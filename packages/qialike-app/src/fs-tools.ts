/**
 * Workspace file mutations the harness's filesystem seam does not expose:
 * `delete` and `move`.
 *
 * The seam (`ctx.fs`) publishes exactly two mutations — `writeText` and
 * `editText` — so before this plugin an agent could create, overwrite and edit
 * files but never remove or rename one. It could still reach both through the
 * shell, which is why this exists mainly for the hosts where that is expensive
 * or impossible:
 *
 *  - **Windows** confines every shell call through the ACL restricted-token
 *    runner, which is a real process launch rather than an in-process file
 *    operation. Routine refactoring — delete a stale file, rename a module —
 *    would otherwise cost a process spawn per operation.
 *  - **A host with no confining executor** gates every shell call behind an
 *    approval prompt (the `unconfinedShellAskDecision` fence), so the fs tools
 *    keep the operation inside the workspace fence without a prompt.
 *  - **A Linux host with neither `bwrap` nor Landlock** fails every shell call
 *    closed (`SANDBOX_UNAVAILABLE`), leaving the fs tools as the only way to
 *    change the workspace at all.
 *
 * The FENCE is the point of this module, and it deliberately differs from the
 * shell's:
 *
 *  - It reuses the seam's OWN containment primitive (`ctx.fs.resolve` +
 *    `ctx.fs.contains`) instead of re-deriving path containment, so it cannot
 *    drift from `dsh-fs-sandbox`.
 *  - It does NOT reuse the harness's `writableRoots()` helper. That helper adds
 *    `/tmp` and `os.tmpdir()` so mkstemp-family WRITES work; there is no
 *    matching need to delete inside the host's shared temp tree, where a
 *    recursive removal harms other processes.
 *  - That asymmetry with `write` is DELIBERATE and load-bearing, not drift: a
 *    write into the shared temp area creates an object the caller owns, while
 *    `delete` is irreversible and would range over other processes' files. A
 *    "single source" refactor that points this fence at `writableRoots()`
 *    re-opens exactly that hazard on POSIX (where the helper grants `/tmp` and
 *    `os.tmpdir()` wholesale); the fix for the underlying asymmetry belongs
 *    upstream, by narrowing the WRITE fence's POSIX roots — not by widening the
 *    destructive one. The POSIX case in `tests/fs-tools.test.ts` pins this.
 *  - The workspace root ITSELF is refused. `contains(root, root)` is true, so
 *    that equality check has to come first — otherwise `delete('.')` would pass
 *    and take the whole workspace with it.
 *
 * @module @yourname/qialike-app/fs-tools
 */

import { rm, rename } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

/** Plugin name. */
export const name = 'qialike-fs-tools'

/** The fs seam plus the shared policy home this fence reads. */
export const inject = ['tools', 'fs', 'sandboxPolicy']

/**
 * The harness's own denial marker (`dsh-sandbox` `sandboxDenialMarker`),
 * reproduced verbatim: a second dialect for the same refusal would leave the
 * model unable to recognise a sandbox denial it has seen from bash.
 * @param mode - the mode the denied call ran under.
 * @returns the marker line, exactly as the model sees it elsewhere.
 */
function denialMarker(mode: string): string {
  return `[sandbox: file access denied under ${mode} mode]`
}

/** The calling session's resolved policy, or the deployment fallback. */
function policyFor(ctx: Context, exec: ToolExecution): SandboxExecutionPolicy {
  return ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
}

/**
 * Resolve one model-supplied path and prove the policy permits mutating it.
 *
 * Returns the RESOLVED target, and every caller mutates exactly that, so the
 * checked identity and the mutated identity cannot diverge (no
 * check-here-write-there window beyond the accepted one in `dsh-fs-sandbox`).
 *
 * @param ctx - plugin context supplying `ctx.fs` and `ctx.sandboxPolicy`.
 * @param policy - the calling session's resolved policy.
 * @param rawPath - the path as the model wrote it.
 * @returns the resolved, permitted target.
 * @throws FsError with code `FS_SANDBOX_DENIED` when the policy refuses.
 */
async function resolvePermitted(ctx: Context, policy: SandboxExecutionPolicy, rawPath: string): Promise<FsTarget> {
  const target = await ctx.fs.resolve(rawPath, { cwd: policy.workspaceRoot })
  if (policy.mode === 'danger-full-access') return target

  if (policy.mode === 'read-only') {
    throw new FsError(
      `${denialMarker(policy.mode)}: "${target.displayPath}" cannot be modified — this session is read-only. Switch the file policy to workspace-write (or danger-full-access) to allow mutations.`,
      'FS_SANDBOX_DENIED',
    )
  }

  const root = await ctx.fs.resolve(policy.workspaceRoot)
  const rootPath = ctx.fs.processPath(root)
  const targetPath = ctx.fs.processPath(target)

  // Order matters: `contains(root, root)` is true, so the equality check must
  // precede containment or the workspace root itself would be mutable.
  if (targetPath === rootPath) {
    throw new FsError(
      `${denialMarker(policy.mode)}: refusing to modify the workspace root itself ("${target.displayPath}"). Name a path inside it.`,
      'FS_SANDBOX_DENIED',
    )
  }
  if (!ctx.fs.contains(root, target)) {
    throw new FsError(
      `${denialMarker(policy.mode)}: "${target.displayPath}" is outside the workspace ("${root.displayPath}"). This fence only covers the workspace root; a wider file policy is a session-level choice, not a per-call one.`,
      'FS_SANDBOX_DENIED',
    )
  }
  return target
}

/** Narrow one model argument to a non-blank string. */
function requirePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty path`)
  }
  return value
}

/**
 * Register `delete` and `move`.
 * @param ctx - the plugin context; registrations are effects scoped to it.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'delete',
    description: 'Delete a file or directory inside the workspace. Irreversible: there is no trash. Deleting a non-empty directory requires recursive: true.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to delete, resolved by the filesystem backend.' },
      recursive: { type: 'boolean', description: 'Delete a directory and everything beneath it. A non-empty directory is refused without it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          kind: { type: 'string', required: true, enum: ['file', 'directory', 'symlink', 'other'] },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<path>${value.path}</path>\n<type>${value.kind}</type>\n<content>\nDeleted\n</content>`,
      }],
    },
    async execute(args, exec) {
      const input = args as { path?: unknown; recursive?: unknown }
      const rawPath = requirePath(input.path, 'path')
      const policy = policyFor(ctx, exec)
      const target = await resolvePermitted(ctx, policy, rawPath)

      // `lstat`, not `stat`: deleting a symlink removes the LINK, and the
      // reported kind must describe the entry that actually went away.
      const info = await ctx.fs.lstat(target.displayPath, { cwd: policy.workspaceRoot }, exec.signal)
      if (info === undefined) {
        throw new FsError(`cannot delete "${target.displayPath}": no such file or directory`, 'FS_NOT_FOUND')
      }
      try {
        // No `force`: a vanished target must surface as FS_NOT_FOUND rather than
        // a silent success, so the model never believes it deleted something it
        // did not.
        await rm(ctx.fs.processPath(target), { recursive: input.recursive === true, force: false })
      } catch (error) {
        throw new FsError(
          `cannot delete "${target.displayPath}": ${error instanceof Error ? error.message : String(error)}`
          + (input.recursive === true ? '' : ' (a non-empty directory needs recursive: true)'),
          'FS_IO_ERROR',
        )
      }
      return { path: target.displayPath, kind: info.type }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'move',
    description: 'Move or rename a file or directory inside the workspace. Both paths must be inside it. Fails across filesystems.',
    parameters: {
      source: { type: 'string', required: true, description: 'Existing path to move, resolved by the filesystem backend.' },
      destination: { type: 'string', required: true, description: 'New path. Its parent directory must already exist.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<path>${value.from}</path>\n<type>move</type>\n<content>\nMoved to ${value.to}\n</content>`,
      }],
    },
    async execute(args, exec) {
      const input = args as { source?: unknown; destination?: unknown }
      const rawSource = requirePath(input.source, 'source')
      const rawDestination = requirePath(input.destination, 'destination')
      const policy = policyFor(ctx, exec)
      // BOTH ends are fenced: moving INTO the workspace from outside would make
      // this tool an exfiltration/ingest path around the policy.
      const source = await resolvePermitted(ctx, policy, rawSource)
      const destination = await resolvePermitted(ctx, policy, rawDestination)

      try {
        await rename(ctx.fs.processPath(source), ctx.fs.processPath(destination))
      } catch (error) {
        throw new FsError(
          `cannot move "${source.displayPath}" to "${destination.displayPath}": ${error instanceof Error ? error.message : String(error)}`,
          'FS_IO_ERROR',
        )
      }
      return { from: source.displayPath, to: destination.displayPath }
    },
  }))
}

/**
 * Materialize the Windows ACL workspace grant OUTSIDE the main thread.
 *
 * The harness's `dsh-sandbox-local` applies the standing `workspace-write`
 * capability ACE (with the ambient-delete deny and the Low integrity label)
 * through `SetNamedSecurityInfoW` on the workspace ROOT. Windows propagates an
 * inheritable ACE to every EXISTING descendant eagerly, inside that one
 * synchronous call, so the cost is proportional to the tree it names. Measured
 * on `E:\qialike` (352,634 objects): 188.5 s of one thread — and that thread
 * hosts both the harness and Ink, so the whole interface froze and qialike's own
 * 1 s heartbeat recorded it as `[stall] main loop blocked for 188.5s`.
 *
 * The harness documents the propagation and mitigates only the REPEAT:
 * `grantWrite` skips the apply when the exact ACE, deny, and label already
 * stand. This module turns that mitigation into the fix, in two steps:
 *
 *  - {@link prewarmAclGrant} applies the grant in a CHILD process at launch, so
 *    the expensive apply runs on another core while the user is still typing;
 *  - {@link ensureAclGrant} is the single-flight gate the patched
 *    `materializeAclGrant` awaits before its own `grant.add()`. With the child
 *    finished, `grant.add()` takes the harness's O(1) skip branch and the first
 *    confined command starts at once; with it still running, the call WAITS for
 *    that one apply instead of starting a second one on the UI thread.
 *
 * Neither step weakens the grant: the child is the harness's own runner in its
 * agentless `workspace-write` form — the invocation the harness itself uses for
 * the win32 probe — so no ACL logic is reimplemented here. The runner derives
 * the SAME deterministic `workspaceWriteSid` from the same canonical root,
 * applies the same three edits, leaves the workspace ACE standing for the reuse
 * cache, and revokes only its own private temp grant on exit. The parent's
 * `grant.add()` still runs afterwards and remains the authority, so a child that
 * fails to start, fails to apply, or never finishes leaves exactly today's
 * behaviour rather than a workspace without a grant.
 *
 * POSIX never executes any of it: every entry point returns before spawning, so
 * Linux and macOS keep their existing rungs unchanged.
 *
 * @module @qialike/qialike-app/windows-acl-grant
 */

import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { logErrorFileOnly } from './log.ts'
import { WINDOWS_ACL_RUNNER_FLAG } from './windows-acl-mode.ts'

/**
 * The `globalThis` slot holding the single-flight state.
 *
 * Shared state rather than a module-local variable because the two callers are
 * different module instances that must agree: the launcher's boot prewarm
 * (`apps/tui-bin/src/bin.ts`) and the patched copy of the harness's
 * `dsh-sandbox-local` inside the bundled farm.
 */
const GRANT_STATE_KEY = '__qialikeAclGrantState'

/**
 * The environment switch that skips the LAUNCH prewarm.
 *
 * It does not disable the fix: the on-demand gate still applies the grant in a
 * child process, so the interface stays responsive and only the head start is
 * lost. That is what makes it useful for measuring the prewarm's effect, and it
 * is the escape hatch for a host where spawning at launch is unwanted.
 */
const PREWARM_DISABLE_ENV = 'QIALIKE_DISABLE_ACL_PREWARM'

/**
 * How long the gate waits for a prewarm before proceeding without it.
 *
 * Only a safety valve: the measured worst case on a 352,634-object workspace is
 * ~190 s, so a wait that reaches this bound means the child is wedged rather
 * than slow. Proceeding is the correct outcome — the caller then applies the
 * grant itself, which is exactly the behaviour without this module.
 */
const GRANT_WAIT_LIMIT_MS = 15 * 60_000

/** The single-flight state, keyed by the workspace root it belongs to. */
interface AclGrantState {
  /** The root {@link AclGrantState.inFlight} was started for. */
  root?: string
  /** The one grant in flight for {@link AclGrantState.root}, settled at most once. */
  inFlight?: Promise<void>
  /** Whether {@link AclGrantState.inFlight} has settled, for the waiting log line. */
  settled?: boolean
  /** When that grant was started, for the log line that reports its cost. */
  startedAt?: number
}

/** The `globalThis` view this module owns; no other module reads the slot. */
interface AclGrantGlobal {
  __qialikeAclGrantState?: AclGrantState
}

/** The process-wide state, created on first use. */
function grantState(): AclGrantState {
  const host = globalThis as AclGrantGlobal
  host.__qialikeAclGrantState ??= {}
  return host.__qialikeAclGrantState
}

/**
 * The runner invocation the boot prewarm uses when no caller supplies one.
 *
 * The single file IS the ACL runner for its own harness — the build points the
 * win32 rung at `[this executable, WINDOWS_ACL_RUNNER_FLAG]` — so the embedded
 * mode covers every shipped layout. {@link embeddedRunnerReady} guards the
 * caller instead of this function: a developer checkout runs under node or bun,
 * where this argv would name the interpreter rather than qialike.
 * @returns the argv prefix for the embedded runner mode.
 */
function embeddedRunnerInvocation(): string[] {
  return [process.execPath, WINDOWS_ACL_RUNNER_FLAG]
}

/**
 * Whether the running executable can be its own ACL runner.
 *
 * True for the built artifact and for a globally installed `qialike.exe`; false
 * under a source launch, where `process.execPath` is the interpreter. The
 * launcher prewarm is skipped when false — the gate still works, because the
 * on-demand call receives the real invocation from the harness.
 * @returns whether `process.execPath` is a qialike binary.
 */
export function embeddedRunnerReady(): boolean {
  const name = basename(process.execPath).toLowerCase()
  return name === 'qialike' || name === 'qialike.exe'
}

/**
 * The runner's argv for a grant-only invocation.
 *
 * `cmd /c exit 0` is the command the harness itself pairs with the runner for its
 * win32 probe: the cheapest thing that can be spawned under the restricted token,
 * with no output and no dependency on the workspace. The grant does not depend on
 * it succeeding — `AclSandbox.init()` applies every ACE before the spawn, and
 * `dispose()` leaves the standing workspace ACE in place — so a failing command
 * still prewarms the tree.
 * @param invocation - the runner argv prefix (program plus any loader arguments).
 * @param workspaceRoot - the canonical workspace root to grant.
 * @returns the full child argv.
 */
export function aclGrantArgv(invocation: readonly string[], workspaceRoot: string): string[] {
  return [
    ...invocation,
    '--workspace', workspaceRoot,
    '--temp', tmpdir(),
    '--mode', 'workspace-write',
    '--', 'cmd', '/c', 'exit', '0',
  ]
}

/**
 * Canonicalize a root the way the enforcement layer does.
 *
 * The write SID is derived from the canonical root, so the prewarm must
 * canonicalize identically or it applies an ACE for a DIFFERENT identity than the
 * one the confined command carries — which would leave both the full-tree cost
 * and a useless standing ACE behind. This mirrors the harness's `canonicalPath`
 * including its fallback: an unresolvable path keeps its spelling rather than
 * inventing an identity the caller never named.
 * @param path - the root as configured or platform-reported.
 * @returns the canonical path, or `path` when resolution fails.
 */
export function canonicalWorkspaceRoot(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Spawn the grant-only runner and settle when it exits.
 *
 * Never rejects: this runs on the startup path, where a failed background grant
 * must stay invisible. The child is unref'd so a long apply cannot hold the TUI
 * open at exit — an orphaned runner finishes its own apply safely, because the
 * standing workspace ACE is idempotent and its temp grant is its own.
 * @param invocation - the runner argv prefix.
 * @param workspaceRoot - the canonical workspace root to grant.
 * @param label - `prewarm` or `on-demand`, for the log line only.
 * @returns a promise for the child's exit, or its bounded wait.
 */
function runAclGrant(invocation: readonly string[], workspaceRoot: string, label: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const startedAt = Date.now()
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(invocation[0] ?? '', aclGrantArgv(invocation.slice(1), workspaceRoot), {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      // An unusable invocation leaves the caller's own grant as the only one.
      logErrorFileOnly('acl', `grant child could not start (${label}): ${
        error instanceof Error ? error.message : String(error)}`)
      resolve()
      return
    }
    child.unref()
    logErrorFileOnly('acl', `workspace grant started (${label}) root=${workspaceRoot}`)
    const limit = setTimeout(() => {
      logErrorFileOnly('acl', `workspace grant still running after ${GRANT_WAIT_LIMIT_MS}ms (${label}); `
        + 'the caller applies it itself')
      resolve()
    }, GRANT_WAIT_LIMIT_MS)
    limit.unref?.()
    const settle = (code: number | null): void => {
      clearTimeout(limit)
      // The grant is applied BEFORE the runner spawns its command, so a non-zero
      // code here still means the tree was granted: it reports the probe command,
      // not the ACE.
      logErrorFileOnly('acl', `workspace grant child exited (${label}) code=${String(code)} `
        + `ms=${Date.now() - startedAt}`)
      resolve()
    }
    child.once('exit', settle)
    child.once('error', () => { settle(null) })
  })
}

/**
 * The one grant in flight for `workspaceRoot`, started on first use.
 *
 * Callers await this before applying the grant themselves, which is what keeps
 * the cost off the UI thread AND avoids a second full-tree propagation.
 * @param workspaceRoot - the canonical workspace root the grant belongs to.
 * @param invocation - the runner argv prefix; the boot prewarm's embedded mode is used when omitted.
 * @param label - `prewarm` or `on-demand`, for the log line only.
 * @returns a promise settling when the grant attempt ends, never rejected.
 */
export function ensureAclGrant(workspaceRoot: string, invocation?: readonly string[], label = 'on-demand'): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve()
  const state = grantState()
  if (state.root !== workspaceRoot) {
    state.root = workspaceRoot
    state.inFlight = undefined
    state.settled = false
    state.startedAt = undefined
  }
  if (state.inFlight === undefined) {
    state.startedAt = Date.now()
    state.inFlight = runAclGrant(invocation ?? embeddedRunnerInvocation(), workspaceRoot, label)
    void state.inFlight.then(() => {
      state.settled = true
      logErrorFileOnly('acl', `workspace grant ready ms=${Date.now() - (state.startedAt ?? Date.now())}`)
    })
  } else if (state.settled !== true) {
    // The line that explains a slow first command: the wait is the grant, not the tool.
    logErrorFileOnly('acl', 'waiting for the in-flight workspace grant before the first confined command')
  }
  return state.inFlight
}

/**
 * Apply the standing workspace grant in the background, once per process.
 *
 * Called by the launcher right after the TUI mounts, so the apply overlaps the
 * user reading the screen and typing their first task instead of blocking the
 * frame that answers it. Skipped outside Windows, under a source launch (see
 * {@link embeddedRunnerReady}), and under {@link PREWARM_DISABLE_ENV}; every skip
 * is silent by design, because the on-demand path covers the grant either way.
 * @param workspaceRoot - the workspace root the session will run under.
 */
export function prewarmAclGrant(workspaceRoot: string): void {
  if (process.platform !== 'win32' || !embeddedRunnerReady()) return
  if ((process.env[PREWARM_DISABLE_ENV] ?? '') !== '') return
  void ensureAclGrant(canonicalWorkspaceRoot(workspaceRoot), undefined, 'prewarm')
}

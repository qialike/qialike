/**
 * The secrets read guard: the pure decision the tool pre-execute waterfall
 * consults before a filesystem READ tool touches a path.
 *
 * The harness's `SandboxMode` vocabulary promises FILE EFFECTS — writes. Reads
 * are outside it by construction, and every backend grants the whole host root
 * read-only (`--ro-bind / /`, Landlock `--ro /`, Seatbelt `allow default`), so
 * nothing below the tool layer stops the model from reading `.env`, `.git`
 * internals, or the harness's own credential document. Gemini CLI blocks the
 * same set in-process for exactly this reason.
 *
 * This guard is therefore mode-INDEPENDENT: it is not a file-effect boundary the
 * user widens with `danger-full-access`, it is a confidentiality policy about
 * which files are worth naming in the first place.
 *
 * Known and deliberate gap: it fences the read TOOLS, not the shell. A command
 * that names a secret file still runs, because inferring paths from shell text
 * is unsound (`$(…)`, variables, redirection) — the same conclusion Gemini CLI
 * reached, which is why its own `.env` deny also has no unsandboxed-shell case.
 * Closing that would need a read boundary the kernel backends cannot express
 * (subtracting from an all-of-`/` read grant), so it is documented instead of
 * approximated. `apps/tui-bin/README` carries the limitation.
 *
 * @module qialike-app/read-policy
 */

import type { PreToolDecision } from '@deepseek-ai/dsh-tools'

/** Path segments that are never worth reading through a tool. */
const BLOCKED_SEGMENTS = new Set(['.git', '.credentials.yaml', '.credentials.yml'])

/**
 * Whether one path segment names a secret file.
 *
 * `.env`-family files carry credentials in every stack, so the whole family is
 * blocked — except `.env.example`, which is a committed template with no
 * secrets and is exactly what an agent SHOULD read when configuring a project.
 * @param segment - one path component (`src`, `.env`, `.env.local`, …).
 * @returns whether reading this segment is refused.
 */
export function isBlockedSecretSegment(segment: string): boolean {
  if (segment.endsWith('.env.example')) return false
  if (segment.endsWith('.env') || segment.startsWith('.env.')) return true
  // A GLOB segment is judged by what it can MATCH, not by its literal spelling.
  // `glob`'s `pattern` is a path glob (see READ_TOOLS), so `.env*` — which the
  // two rules above let through — can match `.env` itself, and returning a
  // filename still confirms the secret exists. Any metacharacter makes the
  // spelling arbitrary, so a pattern carrying one is refused when it names a
  // blocked marker anywhere. `.env.example` stays readable (it returns above).
  if (!/[*?[\]{}]/.test(segment)) return false
  return [...BLOCKED_SEGMENTS, '.env'].some((marker) => segment.includes(marker))
}

/**
 * The first blocked segment in a tool-supplied path, if any.
 *
 * Works on the raw tool input rather than a resolved path, because the tool's
 * `arguments` are what this waterfall sees and resolving here would add I/O to
 * every read decision. Both separators are accepted so a Windows path is judged
 * the same as a POSIX one.
 * @param path - the path, glob, or pattern the tool was called with.
 * @returns the offending segment, or `undefined` when nothing is blocked.
 */
export function blockedPathSegment(path: string): string | undefined {
  for (const segment of path.split(/[\\/]+/)) {
    if (segment === '' || segment === '.' || segment === '..') continue
    if (BLOCKED_SEGMENTS.has(segment)) return segment
    if (isBlockedSecretSegment(segment)) return segment
  }
  return undefined
}

/** The reason a secret read is refused. Names the file and the policy, so the
 *  model stops retrying instead of treating it as a transient failure. */
function blockedReadReason(path: string, segment: string): string {
  return `refusing to read ${JSON.stringify(path)}: "${segment}" is a secret or repository-internal path. This fences the READ TOOLS only — a shell command that names the same file is not covered — and it is not a sandbox-mode restriction, so no sandbox_permissions escalation lifts it.`
}

/**
 * The read tools whose path argument is guarded, and which argument carries it.
 *
 * The distinction matters: `grep`'s `pattern` is a REGEX to search for, not a
 * path — a grep for the literal text `.env` is a perfectly ordinary search, so
 * only its `path` names a file. `glob`'s `pattern` genuinely is a path glob.
 */
const READ_TOOLS: Record<string, readonly string[]> = {
  read: ['file_path'],
  read_image: ['file_path'],
  glob: ['pattern', 'path'],
  grep: ['path'],
}

/**
 * Every string in this call that could name a path, for the given tool.
 * @param name - the tool's registered name.
 * @param args - the tool call's parsed arguments.
 * @returns the candidate path strings, in argument order.
 */
function pathCandidates(name: string, args: unknown): string[] {
  const keys = READ_TOOLS[name]
  if (keys === undefined) return []
  if (typeof args === 'string') return [args]
  if (typeof args !== 'object' || args === null) return []
  const record = args as Record<string, unknown>
  const out: string[] = []
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') out.push(value)
  }
  return out
}

/**
 * Decide one tool execution against the secrets read guard.
 *
 * A deny is final: the reason says so explicitly, because the harness's
 * escalation hint would otherwise invite the model to ask for a wider sandbox
 * mode that cannot lift a confidentiality rule.
 * @param exec - the tool execution under decision (`name` + `arguments`).
 * @returns the deny decision, or `undefined` to delegate down the chain.
 */
export function blockedReadDecision(
  exec: { readonly name?: unknown; readonly arguments?: unknown },
): PreToolDecision | undefined {
  const name = exec.name
  if (typeof name !== 'string' || !(name in READ_TOOLS)) return undefined
  for (const candidate of pathCandidates(name, exec.arguments)) {
    const segment = blockedPathSegment(candidate)
    if (segment !== undefined) return { kind: 'deny', reason: blockedReadReason(candidate, segment) }
  }
  return undefined
}

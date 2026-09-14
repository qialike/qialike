/**
 * The turn-tail "Files changed" row: the paths a turn WROTE, derived from the
 * session's own tool events — web parity with the harness's browser plugin
 * `@deepseek-ai/dsh-client-ui-deliverables` (its `mutationPath` +
 * `deliverablesDefinition` + `producedForClosing`). There is no host service and
 * no git in that path, and this module mirrors its rules rather than inventing
 * its own:
 *
 *  - only the first-party MUTATION tools count: `write`, `edit`, and a mutating
 *    `str_replace_editor` (`create` / `str_replace` / `insert`) — and only when
 *    the arguments are complete enough for the tool to have run (see
 *    {@link mutationPath});
 *  - a path is recorded only when its `tool/result` came back WITHOUT an error;
 *  - the list is per turn, first-seen order, deduped by the exact path string
 *    the model used — a file written and then edited once is one entry;
 *  - paths are listed as spelled (no resolution, no normalization), because the
 *    row's job is to tell the user WHICH file changed, not to canonicalize it;
 *  - shell tools (`bash`/`pwsh`) and third-party tools contribute nothing, even
 *    when they write: the web asks the model to declare those with `present`,
 *    and this row deliberately keeps the same, narrower promise.
 *
 * Pure and dependency-free so the rules can be unit-tested (the browser plugin
 * is React-bound and the harness ships it compiled).
 *
 * @module @yourname/dsh-tui-app/files-changed
 */

/** The user-facing label of the row (web `produced.label` = "Files changed"). */
export const FILES_CHANGED_LABEL = 'Files changed'

/** How many paths the row lists before it collapses the rest into `+N more`
 *  (web `SHOWN_LIMIT = 6`). */
export const FILES_CHANGED_SHOWN = 6

/** A non-blank string keeps its exact spelling; anything else is not a path. */
function pathValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `edit` needs both strings to exist and to differ (a no-op edit wrote nothing). */
function validEditArgs(args: Record<string, unknown>): boolean {
  return typeof args.old_string === 'string' && args.old_string.length > 0
    && typeof args.new_string === 'string' && args.old_string !== args.new_string
    && (args.replace_all === undefined || typeof args.replace_all === 'boolean')
}

/** `str_replace_editor` counts only for its mutating commands. */
function editorMutationPath(args: Record<string, unknown>): string | null {
  const path = pathValue(args.path)
  if (path === null) return null
  switch (args.command) {
    case 'create':
      return typeof args.file_text === 'string' ? path : null
    case 'str_replace':
      return typeof args.old_str === 'string' && args.old_str.length > 0
        && (args.new_str === undefined || typeof args.new_str === 'string') ? path : null
    case 'insert':
      return typeof args.insert_line === 'number' && Number.isInteger(args.insert_line)
        && args.insert_line >= 0 && typeof args.new_str === 'string' ? path : null
    default:
      return null
  }
}

/**
 * The path a mutation tool call wrote, or null when the call is not a supported
 * mutation (a read, a shell command, a malformed call, a third-party tool).
 * @param name - wire tool name from `tool/call`.
 * @param argsRaw - the model-produced JSON argument string.
 * @returns the path as spelled, or null.
 */
export function mutationPath(name: string, argsRaw: string | undefined): string | null {
  if (typeof argsRaw !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  switch (name) {
    case 'write':
      return typeof parsed.content === 'string' ? pathValue(parsed.file_path) : null
    case 'edit':
      return validEditArgs(parsed) ? pathValue(parsed.file_path) : null
    case 'str_replace_editor':
      return editorMutationPath(parsed)
    default:
      return null
  }
}

/**
 * Per-turn accumulator of written paths: {@link call} remembers what each
 * `tool/call` would write, {@link result} turns a SUCCESSFUL one into a listed
 * path, and {@link flush} hands the turn's list to the row and forgets it.
 */
export class FilesChangedLedger {
  /** callId → the path that call would write (null = not a mutation). */
  private readonly calls = new Map<string, string | null>()
  /** callId → the turn it belongs to (so a result can find its turn). */
  private readonly callTurns = new Map<string, number>()
  /** turn → written paths in event order (duplicates included). */
  private readonly byTurn = new Map<number, string[]>()

  /** Remember one `tool/call`. */
  call(turn: number, callId: string, name: string, argsRaw: string | undefined): void {
    this.calls.set(callId, mutationPath(name, argsRaw))
    this.callTurns.set(callId, turn)
  }

  /** Settle one `tool/result`: an errored call wrote nothing. */
  result(callId: string, error: boolean): void {
    const path = this.calls.get(callId)
    const turn = this.callTurns.get(callId)
    if (path === null || path === undefined || turn === undefined) return
    if (error) return
    const list = this.byTurn.get(turn)
    if (list === undefined) this.byTurn.set(turn, [path])
    else list.push(path)
  }

  /**
   * Close a turn: its written paths, first-seen order and deduped, and drop the
   * turn's state. Paths of a call whose result never arrived are not listed.
   * @param turn - the turn being closed.
   * @returns the paths to show (empty when the turn wrote nothing).
   */
  flush(turn: number): readonly string[] {
    const list = this.byTurn.get(turn) ?? []
    this.byTurn.delete(turn)
    for (const [callId, ownTurn] of this.callTurns) {
      if (ownTurn !== turn) continue
      this.callTurns.delete(callId)
      this.calls.delete(callId)
    }
    const seen = new Set<string>()
    const out: string[] = []
    for (const path of list) {
      if (seen.has(path)) continue
      seen.add(path)
      out.push(path)
    }
    return out
  }

  /** Forget everything (a session switch starts a fresh transcript). */
  reset(): void {
    this.calls.clear()
    this.callTurns.clear()
    this.byTurn.clear()
  }
}

/**
 * The one-line row for a turn's written paths.
 * @param paths - the turn's paths, already deduped and in order.
 * @param shown - how many to spell out before collapsing (default 6, web parity).
 * @returns the row text (`Files changed · N · a.ts, b.ts, +2 more`).
 */
export function filesChangedLine(paths: readonly string[], shown = FILES_CHANGED_SHOWN): string {
  const head = paths.slice(0, Math.max(0, shown))
  const rest = paths.length - head.length
  return `${FILES_CHANGED_LABEL} · ${paths.length} · ${head.join(', ')}${rest > 0 ? `, +${rest} more` : ''}`
}

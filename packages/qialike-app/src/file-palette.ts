/**
 * Composer `@file` references: the token grammar, the mention text, and the
 * palette's async-candidate state machine.
 *
 * The grammar and the mention format are NOT re-implemented here — they are the
 * harness's own browser-safe helpers (`@deepseek-ai/dsh-file-reference/grammar`,
 * whose docstring says they are "shared by terminal and web clients"), so the
 * `@` token the composer recognises and the text it inserts are byte-identical
 * with the web composer's reference chips. The candidate LIST is host-side too
 * (`ctx.fileReferences.list`, backed by `WorkspaceFileSearch`: 20 rows per
 * query, 50k indexed entries, fixed directory excludes): the panel never ranks
 * or filters paths itself.
 *
 * The model-facing form of a file reference is literally the mention text —
 * `@src/a.ts`, `@"my dir/a.ts"`, `@dir/` — which the provider documents to the
 * agent through `FILE_REFERENCE_PROMPT` (mounted by the
 * `file-reference-local` row this bundle inserts). There is no reference id and
 * no `references` field on the prompt: the text IS the protocol.
 *
 * @module @yourname/qialike-app/file-palette
 */
import { activeAtToken, formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'

/** One candidate exactly as the host service returns it. */
export interface FileCandidate {
  /** Workspace-relative path (the service's own normalization). */
  path: string
  kind: 'file' | 'directory'
}

/** The `@` token the caret sits in, with its ABSOLUTE offsets in the draft. */
export interface ActiveFileToken {
  /** The whole token including `@` (or the open quote): replaced on accept. */
  prefix: string
  /** The path query after `@` / `@"`. */
  query: string
  /** Whether the user opened a quoted path. */
  quoted: boolean
  /** Draft index where {@link prefix} starts. */
  start: number
}

/** Logical-line bounds of the caret's line. `col` is 0-based within the line. */
function caretLine(input: string, cursor: number): { line: string; col: number } {
  const at = Math.max(0, Math.min(cursor, input.length))
  const start = input.lastIndexOf('\n', at - 1) + 1
  const nl = input.indexOf('\n', at)
  return { line: input.slice(start, nl === -1 ? input.length : nl), col: at - start }
}

/**
 * The `@` token ending at the caret, or undefined when the caret is not in one.
 * Detection is per LOGICAL line (the grammar treats whitespace as the token
 * boundary), so a multi-line draft triggers only on the line being edited — and
 * an `@` inside a word (`user@host`) never triggers.
 * @param input - whole draft.
 * @param cursor - caret index into `input`.
 */
export function activeFileToken(input: string, cursor: number): ActiveFileToken | undefined {
  const { line, col } = caretLine(input, cursor)
  const token = activeAtToken(line, col)
  if (token === undefined) return undefined
  const at = Math.max(0, Math.min(cursor, input.length))
  return { ...token, start: at - token.prefix.length }
}

/**
 * The text to insert for a candidate, or undefined when the path cannot be
 * represented in the mention grammar (control bytes / an illegal quote).
 */
export function fileMentionText(candidate: FileCandidate, quoted: boolean): string | undefined {
  return formatFileMention(candidate, quoted)
}

/** One palette row's label: directories keep the trailing slash (the grammar's
 *  own directory marker, and what a drill continues from). */
export function fileRowLabel(candidate: FileCandidate): string {
  return candidate.kind === 'directory' ? `${candidate.path}/` : candidate.path
}

/**
 * Replace an active token with a mention.
 * @param input - whole draft.
 * @param token - the token {@link activeFileToken} found.
 * @param mention - {@link fileMentionText}'s output.
 * @param space - append a separating space (false when the pick DRILLS into a
 *   directory: the next query continues from the inserted text itself).
 */
export function applyFileMention(
  input: string, token: ActiveFileToken, mention: string, space: boolean,
): { input: string; cursor: number } {
  const end = token.start + token.prefix.length
  // Answering `@sr` in `read @sr and` must not produce a double space: the
  // separator that is already there is kept, and one is added only when the
  // token ends the draft or abuts a non-space character.
  const next = input[end]
  const insert = space && next !== ' ' ? `${mention} ` : mention
  return { input: input.slice(0, token.start) + insert + input.slice(end), cursor: token.start + insert.length }
}

/**
 * Candidate-fetch generations: the panel starts one per query and only the
 * newest may publish, so a slow answer for `@src` can never overwrite the rows
 * for `@packages` the user has since typed (the web's menu does the same with
 * `menuReduce`).
 */
export class FileQuery {
  private generation = 0

  /** Open a new generation (invalidates every in-flight fetch). */
  begin(): number {
    this.generation += 1
    return this.generation
  }

  /** Whether `generation` is still the one the palette is showing. */
  isCurrent(generation: number): boolean {
    return generation === this.generation
  }

  /** Invalidate whatever is in flight (palette closed / draft left the token). */
  cancel(): void {
    this.generation += 1
  }
}

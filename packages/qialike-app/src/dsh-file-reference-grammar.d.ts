/**
 * Types for the harness's browser-safe `@file` grammar module, whose farm copy
 * in this checkout resolves to `lib/types/grammar.js` without a declaration
 * file (TS7016). The signatures mirror
 * `deepseek-harness/packages/context/file-reference/src/grammar.ts`; this shim
 * exists only so the TUI's typecheck sees the two functions it imports.
 *
 * @module @yourname/qialike-app/dsh-file-reference-grammar
 */
declare module '@deepseek-ai/dsh-file-reference/grammar' {
  export interface ActiveAtToken {
    prefix: string
    query: string
    quoted: boolean
  }
  export interface FileReferenceCandidate {
    path: string
    kind: 'file' | 'directory'
  }
  export function activeAtToken(line: string, cursorCol: number): ActiveAtToken | undefined
  export function formatFileMention(candidate: FileReferenceCandidate, preserveQuote: boolean): string | undefined
}

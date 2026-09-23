/**
 * `@file` references for the composer — a TUI sub-plugin.
 *
 * The feature is a CHILD PLUGIN rather than code inside the conversation panel:
 * it owns its own overlay panel (`file-refs`), its own candidate state and its
 * own key handling, and it reaches the host through services
 * (`agents`, `fileReferences`) exactly like every other TUI plugin. The
 * conversation panel therefore needs no knowledge of it: an overlay panel is
 * composited by the conversation's own `overlay()` path and receives keys while
 * `store.panel` names it (same contract the approval / question docks use).
 *
 * Grammar and mention text come from the harness's browser-safe module
 * (`@deepseek-ai/dsh-file-reference/grammar`) and the candidate LIST from
 * `ctx.fileReferences.list` — the same host service the web composer uses — so
 * what this plugin inserts is byte-identical with the web's reference chips and
 * with the `FILE_REFERENCE_PROMPT` the `file-reference-local` row documents to
 * the agent. See `file-palette.ts` for the pure pieces.
 *
 * @module @yourname/qialike-app/file-reference
 */
import React from 'react'
import { Box, Text } from 'ink'
import type { Context } from '@deepseek-ai/cordis'
import {
  activeFileToken, applyFileMention, fileMentionText, fileRowLabel, FileQuery, type FileCandidate,
} from './file-palette.ts'
import type { RawKey } from './stdin.ts'
import type { Store, TuiService } from './index.tsx'
import { theme } from './theme.ts'
import { visualWidth } from './markdown.tsx'
import { useDialogTextBox, dialogTextBoxContains } from './list-geometry.ts'
import { copySelection } from './text-selection.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-file-reference'
/** The panel id this plugin owns (an overlay over the conversation). */
export const FILE_PANEL = 'file-refs'
/** Services read at apply time; `fileReferences` is read lazily per fetch so a
 *  build without the provider row simply offers no candidates. */
export const inject = ['tui', 'tuiStore']

/** Rows painted at once (the host caps candidates at 20; a palette taller than
 *  this would cover the draft it is completing). */
const SHOWN = 8
/** Query debounce: the host walks/indexes a workspace, so a burst of keystrokes
 *  must not queue a scan per character. */
const FETCH_DEBOUNCE_MS = 90

let store: Store
let tui: TuiService
const query = new FileQuery()
let candidates: readonly FileCandidate[] = []
let index = 0
let busy = false
/** The token prefix an Esc dismissed: the palette must not reopen for the SAME
 *  token, but any edit (which changes the prefix) re-arms it. */
let dismissed: string | null = null
/** The token key the palette currently reflects. A store notification — including
 *  the palette's OWN `store.repaint()` when an answer lands — must not start a
 *  new query for a token that is already showing or in flight, or every answer
 *  would re-query the workspace forever (measured on the real binary before this
 *  guard: the header stayed `…` and the host was re-queried every ~25 ms). */
let activeKey: string | null = null

/** Identity of one `@` token: same start, same quoting, same query ⇒ same list. */
function tokenKey(token: { start: number; quoted: boolean; query: string }): string {
  return `${token.start}\u0000${token.quoted ? 1 : 0}\u0000${token.query}`
}

/** Abort/debounce handles for the in-flight fetch. */
let inflight: AbortController | undefined
let timer: ReturnType<typeof setTimeout> | undefined

/** Host candidate source, resolved lazily from the plugin context. */
let listCandidates: ((q: string, quoted: boolean, signal: AbortSignal) => Promise<readonly FileCandidate[]>) | undefined

function stopFetch(): void {
  if (timer !== undefined) { clearTimeout(timer); timer = undefined }
  inflight?.abort()
  inflight = undefined
}

function close(prefix: string | null): void {
  stopFetch()
  query.cancel()
  candidates = []
  busy = false
  index = 0
  dismissed = prefix
  activeKey = null
  if (store.panel === FILE_PANEL) store.setPanel('conversation')
}

function fetch(q: string, quoted: boolean, key: string): void {
  stopFetch()
  activeKey = key
  if (listCandidates === undefined) { candidates = []; busy = false; return }
  const generation = query.begin()
  busy = true
  const controller = new AbortController()
  inflight = controller
  timer = setTimeout(() => {
    timer = undefined
    void listCandidates!(q, quoted, controller.signal).then((list) => {
      if (!query.isCurrent(generation)) return   // a newer query already won
      candidates = list
      index = 0
      busy = false
      store.repaint()
    }, () => {
      if (!query.isCurrent(generation)) return
      candidates = []
      busy = false
      store.repaint()
    })
  }, FETCH_DEBOUNCE_MS)
}

/** Open/close the palette for the caret's current `@` token. Called from the
 *  store subscription, so it follows EVERY draft and caret change (typing,
 *  paste, ←/→, Home/End, history) without the conversation panel knowing. */
function sync(): void {
  const token = activeFileToken(store.input, store.cursor)
  if (token === undefined) {
    if (dismissed !== null) dismissed = null
    activeKey = null
    if (store.panel === FILE_PANEL) close(null)
    return
  }
  if (dismissed === token.prefix) return
  dismissed = null
  if (store.panel !== FILE_PANEL) store.setPanel(FILE_PANEL)
  const key = tokenKey(token)
  // Already showing / already fetching THIS token: the notification was a
  // repaint (often the palette's own), not a new query.
  if (key === activeKey) return
  fetch(token.query, token.quoted, key)
}

/** Accept one candidate: replace the token with the mention text. A directory
 *  DRILL keeps the quote open and leaves the palette up so the next query
 *  continues from the inserted text (web parity). */
function pick(candidate: FileCandidate, drill: boolean): void {
  const token = activeFileToken(store.input, store.cursor)
  if (token === undefined) { close(null); return }
  const mention = fileMentionText(candidate, token.quoted || drill)
  if (mention === undefined) return
  const applied = applyFileMention(store.input, token, mention, !drill)
  store.setInput(applied.input)
  store.setCursor(applied.cursor)
  if (drill) {
    dismissed = null
    const next = activeFileToken(store.input, store.cursor)
    if (next !== undefined) fetch(next.query, true, tokenKey(next))
    return
  }
  close(null)
}

function paletteKey(k: RawKey): void {
  const len = Math.max(1, candidates.length)
  if (k.upArrow) { index = (index - 1 + len) % len; store.repaint(); return }
  if (k.downArrow) { index = (index + 1) % len; store.repaint(); return }
  if (k.escape) { close(activeFileToken(store.input, store.cursor)?.prefix ?? null); return }
  // Mouse: a press inside the popup anchors a text selection over the candidate
  // list (a drag copies it — `copySelection` reads the frame buffer); a plain
  // click stays inert, exactly as it was before this popup had mouse support.
  if (k.mousePress) {
    if (dialogTextBoxContains(k.mousePress.row, k.mousePress.col)) {
      store.mousePress(k.mousePress.row, k.mousePress.col)
    }
    return
  }
  if (k.mouseDrag) { store.mouseDrag(k.mouseDrag.row, k.mouseDrag.col); return }
  if (k.mouseRelease) {
    if (store.mouseRelease(k.mouseRelease.row, k.mouseRelease.col) === 'drag') copySelection(store)
    return
  }
  if (k.tab) {
    const c = candidates[index]
    if (c !== undefined && c.kind === 'directory') { pick(c, true); return }
    if (c !== undefined) { pick(c, false); return }
    return
  }
  if (k.return) {
    const c = candidates[index]
    if (c !== undefined) pick(c, false)
    // No candidate: stay open (Esc leaves) — Enter must not submit a draft that
    // is visibly mid-completion.
    return
  }
  // Anything else edits the draft; the subscription re-syncs from the new text.
  if (k.backspace) { store.backspaceAtCursor(); return }
  if (k.delete) { store.deleteForward(); return }
  if (k.char !== undefined) { store.insertAtCursor(k.char); return }
}

/** Bottom-anchored box just above the composer card. Placement mirrors the
 *  command palette's own formula (`commandPaletteIndexFromRow`): docked leaves 3
 *  rows (message padding + gap) below the box, the hero rests it ON the card's
 *  top border. */
function FileReferencePalette(): React.ReactNode {
  // The palette's TEXT area, published so a drag across the popup copies the
  // candidate list rather than the transcript behind it. Called before the
  // early return so the hook order never depends on the popup being open.
  const textRef = useDialogTextBox('file-reference', [candidates.length, index, busy, store.rows, store.width, store.hero])
  if (candidates.length === 0 && !busy) return null
  const lift = store.hero ? 1 : 3
  const rows = candidates.slice(0, SHOWN)
  const contentW = Math.max(20, store.width - 4)
  const header = busy ? '…' : `${candidates.length} path${candidates.length === 1 ? '' : 's'}`
  return (
    <Box position="absolute" width="100%" height="100%" flexDirection="column" justifyContent="flex-end" paddingBottom={lift}>
      <Box borderStyle="round" borderColor={theme.border} flexDirection="column">
        <Box ref={textRef} flexDirection="column">
        {rows.map((c, i) => {
          const line = `@${fileRowLabel(c)}`
          const trail = `${header}  `
          const fill = Math.max(1, contentW - visualWidth(line) - visualWidth(trail) - 4)
          return (
            <Text key={`${c.kind}:${c.path}`} color={i === index ? theme.accent : undefined} inverse={i === index} backgroundColor={theme.bg} wrap="truncate">
              {'  '}{line}{' '.repeat(fill)}{c.kind === 'directory' ? '▶ ' : ''}{trail}{'  '}
            </Text>
          )
        })}
        {rows.length === 0 ? <Text color={theme.textMuted} backgroundColor={theme.bg}>{'  searching…'}</Text> : null}
        </Box>
      </Box>
    </Box>
  )
}

/** Mount the `@file` palette. */
export function apply(ctx: Context): void {
  store = ctx.get('tuiStore') as Store
  tui = ctx.get('tui') as TuiService
  const agents = ctx.get('agents') as { list(): readonly unknown[] } | undefined
  const refs = ctx.get('fileReferences') as {
    list(agent: unknown, query: string, signal: AbortSignal): Promise<readonly FileCandidate[]>
  } | undefined
  if (agents !== undefined && refs !== undefined) {
    // This surface is single-session (one agent per process), so the newest
    // registered agent is the one whose cwd bounds discovery.
    listCandidates = async (q, _quoted, signal) => {
      const agent = agents.list().at(-1)
      if (agent === undefined) return []
      try {
        return await refs.list(agent, q, signal)
      } catch {
        return []   // a cancelled/failed lookup leaves the palette empty, never throws
      }
    }
  }
  tui.panels.register({
    id: FILE_PANEL,
    mode: 'overlay',
    render: () => <FileReferencePalette />,
    handleKey: (k) => { paletteKey(k); return true },
  })
  ctx.effect(() => store.subscribe(sync), 'tui-file-reference: draft watch')
}

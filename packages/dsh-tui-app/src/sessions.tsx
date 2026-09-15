/**
 * The sessions panel plugin (`tui-sessions`): the `/sessions` command and its
 * full-screen dialog — a session manager: list persisted sessions, live
 * type-to-filter, resume on Enter. The dialog lists historical session
 * records only; starting a brand-new session is `/new`'s job (`tui-new`).
 * Registers the `sessions` (fullscreen) panel against the `tui` service.
 *
 * Content search (message-content search) is NOT available in the
 * single-file process: the harness `sessions` service exposed here is the
 * internal agent registry (no `search`/list snapshot — those live in the
 * remote client layer used by the web app). The dialog therefore filters the
 * persisted list locally by title/id/cwd.
 *
 * @module @yourname/dsh-tui-app/sessions
 */

import { Box, Text } from 'ink'
import React, { useRef } from 'react'
import type { DOMElement } from 'ink'
import { useListGeometry, dialogListIndexFromRow, dialogListContains } from './list-geometry.ts'
import { handleDialogPaste } from './clipboard.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { TuiService, Store, SessionSummary } from './index.tsx'
import { truncateWide } from './markdown.tsx'
import { deleteSession, listSessionFiles, readSessionEvents } from './session-files.ts'
import { forgetPin, forgetTitle, hideUnselectedBlanks, isPinned, listRowHeaders, listWithTitles, renameTitle, togglePin, type SessionHeaderLike, type SessionTitlesPersistence } from './session-titles.ts'
import { forgetActivity } from './session-activity.ts'
import { logErrorFileOnly } from './log.ts'
import { theme } from './theme.ts'
import { stripTerminalControls } from './terminal-safe.ts'
import type { RawKey } from './stdin.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-sessions'

/** The store service (see panels/conversation.tsx for the why-behind-the-seam). */
let store!: Store

/** The `tui` service (panel registration). */
export const inject = ['tui']

/** The VISIBLE display rows (day/pinned headers + session rows) last rendered, so a
 *  mouse hover can map a screen row → the flat/sessions index (headers are not
 *  selectable; rows carry the flat index in `.i`). */
let sessionsMouseDisp: { kind: 'header' | 'row'; i?: number; label?: string }[] = []

/** Day header for a session creation time: Today / Yesterday / date string. */
function dayLabel(createdAt: number | undefined): string {
  if (createdAt === undefined) return ''
  const date = new Date(createdAt)
  const now = new Date()
  const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diffDays = Math.round((dayStart(now) - dayStart(date)) / 86_400_000)
  if (diffDays <= 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  return date.toDateString()
}

/** The /sessions dialog (fullscreen modal). */
function SessionsDialog(): React.JSX.Element {
  const [cursorOn, setCursorOn] = React.useState(true)
  React.useEffect(() => {
    const timer = setInterval(() => setCursorOn((on) => !on), 530)
    return () => clearInterval(timer)
  }, [])
  const block = <Text inverse={cursorOn}> </Text>
  // List computation lifted out of the render IIFE so useListGeometry (a React
  // hook) can be called and the mouse-hover geometry registered; the IIFE reuses
  // these values.
  const rows = store.sessionsFiltered
  const listRows = Math.max(1, store.rows - 15)
  type Disp = { kind: 'header'; label: string } | { kind: 'row'; i: number }
  const disp: Disp[] = []
  const pinnedRows: number[] = []
  rows.forEach((s, i) => { if (isPinned(s.id)) pinnedRows.push(i) })
  if (pinnedRows.length > 0) { disp.push({ kind: 'header', label: '📌 Pinned' }); for (const i of pinnedRows) disp.push({ kind: 'row', i }) }
  let prevDay = ''
  rows.forEach((s, i) => { if (isPinned(s.id)) return; const day = dayLabel(s.activityAt ?? s.createdAt); if (day !== prevDay) { disp.push({ kind: 'header', label: day }); prevDay = day } disp.push({ kind: 'row', i }) })
  const highlightDisp = disp.findIndex((d) => d.kind === 'row' && d.i === store.sessionsDialogIndex)
  const startDisp = Math.max(0, Math.min(Math.max(0, highlightDisp - Math.floor(listRows / 2)), Math.max(0, disp.length - listRows)))
  const visibleCount = Math.min(listRows, Math.max(0, disp.length - startDisp))
  const listRef = useRef<DOMElement>(null)
  useListGeometry(listRef, visibleCount, 1, [store.sessionsDialogIndex, store.sessionsFilter, rows.length])
  sessionsMouseDisp = disp.slice(startDisp, startDisp + listRows)
  return (
    <Box flexDirection="column" height={store.rows} alignItems="center" justifyContent="center">
      <Box position="absolute" width="100%" height={store.rows} flexDirection="column">
        <Text backgroundColor={theme.bg} wrap="wrap">{' '.repeat(Math.max(0, store.width * store.rows))}</Text>
      </Box>
      <Box width={72} borderStyle="round" borderColor={theme.border} flexDirection="column" paddingX={1} paddingY={1}>
        <Text color={theme.accent} bold>Sessions</Text>
        <Text dimColor>current: {(() => {
          const row = store.sessionsFiltered[store.sessionsDialogIndex]
          const text = row === undefined
            ? ''
            : row.blank === true ? 'New Session' : (row.title ?? row.label)
          return stripTerminalControls(truncateWide(text, 60))
        })()}</Text>
        <Box borderStyle="round" borderColor={theme.accent} paddingX={1} marginY={1}>
          <Text color={theme.accent} bold>
            {store.sessionsRenaming !== null
              ? `✎ ${store.sessionsRenameInput}`
              : store.sessionsFilter !== ''
                ? `⌕ ${store.sessionsFilter}`
                : '⌕ type to filter'}
            {block}
          </Text>
        </Box>
        <Box flexDirection="column" gap={0} ref={listRef}>
          {(() => {
            const out: React.JSX.Element[] = []
            for (let k = startDisp; k < startDisp + listRows && k < disp.length; k++) {
              const d = disp[k]
              if (d === undefined) continue
              if (d.kind === 'header') {
                // Unique key per header: the same day label would otherwise
                // repeat if the list were unsorted, and duplicate keys make
                // React reconcile incorrectly (the separate *component* for a
                // sibling text can end up duplicated — the doubled filter line).
                out.push(<Text key={`g-${k}-${d.label}`} color={theme.accent} bold>{d.label}</Text>)
                continue
              }
              const s = rows[d.i]
              if (s === undefined) continue
              // One line per row: the display title plus the session creation
              // TIME (HH:MM, the day lives in the group header above); a long
              // title is truncated so it cannot wrap and inflate the dialog
              // past the terminal height.
              // Untasked placeholder rows read "New Session" (web parity) and
              // carry no clock: nothing has happened in them yet.
              const isBlank = s.blank === true
              const raw = isBlank
                ? 'New Session'
                : (s.title !== undefined && s.title.trim() !== '' ? s.title.trim() : '(untitled)')
              const display = stripTerminalControls(raw)
              const title = truncateWide(display, 50)
              // 24-hour local clock (deterministic — not toLocaleTimeString,
              // whose AM/PM or locale wording would widen the row).
              // The clock shows when the session was last USED (F9) — the same
              // value the list is sorted and day-grouped by.
              const createdAt = s.activityAt ?? s.createdAt
              const time = isBlank || createdAt === undefined ? '' : (() => {
                const d = new Date(createdAt)
                const hh = String(d.getHours()).padStart(2, '0')
                const mm = String(d.getMinutes()).padStart(2, '0')
                return `${hh}:${mm}`
              })()
              const active = d.i === store.sessionsDialogIndex
              out.push(
                <Text key={String(s.id)} color={active ? theme.accent : undefined} inverse={active}>
                  {active ? '› ' : '  '}{isPinned(s.id) ? '📌 ' : ''}{title}
                  {time !== '' && <Text dimColor>  · {time}</Text>}
                </Text>,
              )
            }
            if (rows.length === 0) {
              out.push(
                <Text key="__empty" dimColor>
                  {store.sessionsFilter !== '' ? `no sessions match "${store.sessionsFilter}"` : 'no sessions in this directory — /new starts one'}
                </Text>,
              )
            }
            return out
          })()}
        </Box>
        {store.sessionsDeleting !== null && store.sessionsFiltered[store.sessionsDeleting] !== undefined && (
          <Text color={theme.warning}>
            delete "{truncateWide(store.sessionsFiltered[store.sessionsDeleting]!.label, 40)}"? Ctrl+D again to confirm · Esc to cancel
          </Text>
        )}
        {store.sessionsNotice !== '' && (
          <Text color={store.sessionsNotice.startsWith('delete failed') ? theme.error : theme.warning}>
            {store.sessionsNotice}
          </Text>
        )}
        <Box marginTop={1}>
          <Text dimColor>↑/↓ · PgUp/PgDn · Home/End · Enter resume · Ctrl+R rename · Ctrl+F pin · Ctrl+D delete · Esc clear/back</Text>
        </Box>
      </Box>
    </Box>
  )
}

/** Handle one key while the sessions panel is active. */
function sessionsKey(k: RawKey, reload: () => void): void {
  const char = k.char ?? ''
  const page = Math.max(1, store.rows - 14)
  const clearNotice = (): void => { if (store.sessionsNotice !== '') store.setSessionsNotice('') }
  // Mouse: consume press (no transcript selection); a left-click runs the CURRENT
  // highlight (== Enter) by re-dispatching as a return key.
  if (k.mousePress) return
  if (k.mouseMove) {
    // HOVER: highlight the session row under the cursor (map the screen row to the
    // visible display index, then to the flat sessions index; group headers pass).
    const vi = dialogListIndexFromRow(k.mouseMove.row, k.mouseMove.col)
    const d = vi >= 0 ? sessionsMouseDisp[vi] : undefined
    if (d !== undefined && d.kind === 'row') store.moveSessionsDialogIndex(d.i!)
    return
  }
  if (k.mouseRelease) {
    // Only a click INSIDE the list box activates the highlighted row; a click on
    // the transcript behind the dialog is inert (it used to resume a session).
    const kind = store.mouseRelease(k.mouseRelease.row, k.mouseRelease.col)
    if (kind === 'click' && dialogListContains(k.mouseRelease.row, k.mouseRelease.col)) {
      sessionsKey({ return: true } as RawKey, reload)
    }
    return
  }
  // Rename mode: the filter box becomes a title input (Enter confirms, Esc
  // cancels); navigation and other actions are suspended.
  if (store.sessionsRenaming !== null) {
    if (k.return) {
      const row = store.sessionsFiltered[store.sessionsRenaming]
      if (row !== undefined) {
        renameTitle(row.id, store.sessionsRenameInput)
        store.setSessionsNotice(`renamed to "${store.sessionsRenameInput.trim() || '(auto title)'}"`)
      }
      store.cancelSessionsRename()
      reload()
    } else if (k.escape || (k.ctrl && char === 'c')) {
      store.cancelSessionsRename()
    } else if (k.backspace || k.delete) {
      store.sessionsRenameBackspace()
    } else if (handleDialogPaste(k, store, (text) => store.sessionsRenameType(text), { singleLine: true, maxChars: 120 })) {
      return
    } else if (char) {
      store.sessionsRenameType(char)
    }
    return
  }
  if (k.pageUp) { store.cancelSessionsDelete(); clearNotice(); store.moveSessionsDialogIndex(store.sessionsDialogIndex - page); return }
  if (k.pageDown) { store.cancelSessionsDelete(); clearNotice(); store.moveSessionsDialogIndex(store.sessionsDialogIndex + page); return }
  if (k.home) { store.cancelSessionsDelete(); clearNotice(); store.moveSessionsDialogIndex(0); return }
  if (k.end) { store.cancelSessionsDelete(); clearNotice(); store.moveSessionsDialogIndex(store.sessionsFiltered.length); return }
  if (k.upArrow) { store.cancelSessionsDelete(); clearNotice(); store.bumpSessionsDialogIndex(-1); return }
  if (k.downArrow) { store.cancelSessionsDelete(); clearNotice(); store.bumpSessionsDialogIndex(1); return }
  if (k.wheelUp) {
    if (dialogListContains(k.wheelUp.row, k.wheelUp.col)) { store.cancelSessionsDelete(); clearNotice(); store.bumpSessionsDialogIndex(-1) }
    return
  }
  if (k.wheelDown) {
    if (dialogListContains(k.wheelDown.row, k.wheelDown.col)) { store.cancelSessionsDelete(); clearNotice(); store.bumpSessionsDialogIndex(1) }
    return
  }
  if (k.return) {
    const rows = store.sessionsFiltered
    const index = store.sessionsDialogIndex
    if (index < rows.length) store.resumeSession(String(rows[index]?.id))
    return
  }
  if (k.ctrl && char === 'r') {
    const row = store.sessionsFiltered[store.sessionsDialogIndex]
    if (row === undefined) return
    store.startSessionsRename(store.sessionsDialogIndex, row.title ?? '')
    return
  }
  if (k.ctrl && char === 'f') {
    const row = store.sessionsFiltered[store.sessionsDialogIndex]
    if (row === undefined) return
    const pinned = togglePin(row.id)
    store.setSessionsNotice(pinned ? `pinned ${String(row.id).slice(-8)}` : `unpinned ${String(row.id).slice(-8)}`)
    reload()
    return
  }
  if (k.ctrl && char === 'd') {
    const rows = store.sessionsFiltered
    const index = store.sessionsDialogIndex
    const row = rows[index]
    if (row === undefined) return
    if (String(row.id) === String(store.session?.id)) {
      store.setSessionsNotice('the current session cannot be deleted')
      return
    }
    // Two presses confirm: first arms the row, second deletes it.
    if (store.sessionsDeleting === index) {
      store.setSessionsNotice('deleting…')
      void (async (): Promise<void> => {
        try {
          await deleteSession(row.cwd ?? store.workspace, row.id)
          forgetTitle(row.id)
          forgetActivity(row.id)
          forgetPin(row.id)
          store.setSessionsNotice(`deleted ${String(row.id).slice(-8)}`)
        } catch (error) {
          store.setSessionsNotice(`delete failed: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          store.armSessionsDelete(null)
          reload()
        }
      })()
    } else {
      store.armSessionsDelete(index)
    }
    return
  }
  if (k.escape || (k.ctrl && char === 'c')) {
    if (store.sessionsDeleting !== null) { store.cancelSessionsDelete(); return }
    if (store.sessionsFilter !== '') store.clearSessionsFilter()
    else store.cancelSessions()
    return
  }
  if (k.backspace || k.delete) {
    store.cancelSessionsDelete()
    clearNotice()
    store.sessionsFilterBackspace()
    return
  }
  if (handleDialogPaste(k, store, (text) => { store.cancelSessionsDelete(); clearNotice(); store.sessionsFilterType(text) }, { singleLine: true, maxChars: 120 })) return
  if (char) {
    store.cancelSessionsDelete()
    clearNotice()
    store.sessionsFilterType(char)
  }
}

/** Register the sessions (fullscreen) panel and the `/sessions` command. */
export function apply(ctx: Context): void {
  store = ctx.get('tuiStore') as Store
  const tui = ctx.get('tui') as TuiService
  tui.panels.register({
    id: 'sessions',
    mode: 'fullscreen',
    render: () => <SessionsDialog />,
    handleKey: (k) => { sessionsKey(k, reload); return true },
  })
  /** One place for "the session list did not load": a line in the error log for
   *  diagnosis, plus a transcript row the user can actually read. The dialog
   *  itself has nowhere to put a message, and the status bar may be carrying
   *  another phase's text — a transcript row is never masked. Every promise in
   *  this file's load path MUST end here: a bare rejection becomes an
   *  `unhandledRejection`, and the harness's fail-loud hook answers that with
   *  `process.exit(1)` — the whole TUI dies while the user was only opening the
   *  session list (measured: a `chmod 000` log did exactly that). */
  const reportLoadFailure = (what: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    logErrorFileOnly('sessions', `${what} failed: ${message}`)
    store.append('status', `sessions: ${message}`, true)
  }
  // Shared list load: the `/sessions` command opens it; deletion refreshes it.
  const reload = (): void => {
    const persistence = ctx.get('sessionPersistence') as (SessionTitlesPersistence & { list?: (signal?: AbortSignal) => Promise<SessionHeaderLike[]> }) | undefined
    // Web parity: only the SELECTED untasked "New Session" placeholder stays in
    // the list; other blanks are hidden (the durable file is untouched).
    const publish = (rows: SessionSummary[]): void => {
      store.refreshSessionsDialog(hideUnselectedBlanks(rows, store.session?.id))
    }
    // Ask the FILE SYSTEM instead of the persistence service — the same
    // generation-aware reader the transcript and /export use. Without it the
    // list is always empty, which also makes Ctrl+R rename and Ctrl+D delete
    // unreachable. It is defensive per session (`listSessionFiles` drops an
    // unreadable log instead of failing), which is exactly what makes it the
    // right fallback when the service's `list()` rejects.
    const loadFromFiles = (): void => {
      const filePersistence: SessionTitlesPersistence = {
        inspect: async (id) => ({ events: await readSessionEvents(store.workspace, id) }),
      }
      void (async (): Promise<void> => {
        const headers = await listSessionFiles(store.workspace)
        logErrorFileOnly('sessions', `file-backed list: ${headers.length} session(s) for ${store.workspace}`)
        // Renders from the title cache immediately; the bounded head probe (or
        // the file-backed inspect above) enriches the rows through `publish`.
        const rows = await listWithTitles(filePersistence, headers, publish)
        logErrorFileOnly('sessions', `file-backed rows: ${rows.length} after title merge`)
        publish(rows)
      })().catch((error: unknown) => { reportLoadFailure('file-backed list', error) })
    }
    if (persistence?.list === undefined) {
      loadFromFiles()
      return
    }
    void persistence.list().then((list) => {
      // 0.1.5 wraps each row as `{ header, revision, sizeBytes }`: unwrap before
      // filtering, or every row is dropped and the dialog looks empty.
      const unwrapped = listRowHeaders(list)
      logErrorFileOnly('sessions', `harness list: ${list.length} row(s), ${unwrapped.length} header(s) for ${store.workspace}`)
      // Only sessions created in the current workspace (same-directory
      // semantics as `resume` / the `resume_last` opt-in).
      const sameDir = unwrapped.filter((h) => h.cwd === store.workspace)
      // Render from the title cache immediately; fold missing titles in the
      // background and refresh the dialog in place (keeps filter/highlight).
      void listWithTitles(persistence, sameDir, publish).then(publish)
        .catch((error: unknown) => { reportLoadFailure('title fold', error) })
    }).catch((error: unknown) => {
      // The harness reads every log's generation header here, so ONE unreadable
      // or torn session log made the whole list reject. Say so, then still show
      // the sessions we CAN read — the list is where a user goes to get away
      // from a broken session.
      reportLoadFailure('harness list', error)
      loadFromFiles()
    })
  }
  tui.commands.register({
    name: 'sessions',
    hint: 'list, filter, resume or delete sessions',
    run: reload,
  })
}

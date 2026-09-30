/**
 * Cursor-flicker repro: renders the REAL App on a fake TTY whose terminal model
 * answers `ESC[6n` (CPR) at the exact byte position — like a real emulator — and
 * records, for every instant of the byte stream, WHERE the hardware cursor was
 * and whether it was VISIBLE.
 *
 * The reported bug: typing `/` (in the hero AND in the session view) makes the
 * cursor blink somewhere other than the composer caret.
 *
 * Metrics printed at the end:
 *   - visible time per cell (a stray placement shows up as a cell that is not
 *     the composer caret),
 *   - visible time on the LAST TWO rows (the CPR probe row — the "blinks on the
 *     status bar" signature).
 *
 * Run:  bun packages/qialike-app/repro-cursor-flicker.mjs [hero|docked]
 */
import { Writable, Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchInkFullScreen } from '../../apps/tui-bin/build.mjs'

const MODE = process.argv[2] ?? 'hero'
const ROWS = 30
const COLS = 120
const CPR_DELAY_MS = Number(process.env.CPR_DELAY_MS ?? 15)

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
process.env.TERM = 'xterm-256color'
// A COLD cache makes the calibration actually probe (an isolated DSH_HOME, so the
// developer's own warm `~/.dsh/qialike-charwidth.json` cannot mask the path).
if (process.env.COLD_CACHE === '1') {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-cold-'))
}

// ── terminal model ──────────────────────────────────────────────────────────
const model = {
  row: 1, col: 1, vis: true, saved: { row: 1, col: 1 },
  timeline: [],           // { t, vis, row, col }
  cprRequests: 0,
  buf: Array.from({ length: ROWS }, () => new Array(COLS).fill(' ')),
  now: () => Number(process.hrtime.bigint() / 1000000n),
  snap(kind) { this.timeline.push({ t: this.now(), vis: this.vis, row: this.row, col: this.col, kind }) },
  put(ch) {
    if (this.row >= 1 && this.row <= ROWS && this.col >= 1 && this.col <= COLS) {
      this.buf[this.row - 1][this.col - 1] = ch
    }
    this.col++
    if (this.col > COLS) { this.col = 1; this.row = Math.min(ROWS, this.row + 1) }
  },
  dump() {
    return this.buf.map((r, i) =>
      `${String(i + 1).padStart(2)}|${r.join('').replace(/\s+$/, '')}${i + 1 === this.row ? '   <== cursor' : ''}`).join('\n')
  },
}

const CPR_HANDLERS = []
function feed(text) {
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\x1b') {
      const m25 = /^\x1b\[\?25([hl])/.exec(text.slice(i))
      if (m25) {
        model.vis = m25[1] === 'h'
        i += m25[0].length
        model.snap('?25' + m25[1])
        continue
      }
      const m6 = /^\x1b\[6n/.exec(text.slice(i))
      if (m6) {
        i += m6[0].length
        model.cprRequests++
        // A real terminal replies with the position reached AFTER every byte it
        // has already parsed — i.e. exactly the model's position right now.
        const { row, col } = model
        for (const h of CPR_HANDLERS) h(row, col)
        continue
      }
      const mAlt = /^\x1b\[\?(1049|1047)([hl])/.exec(text.slice(i))
      if (mAlt) {
        i += mAlt[0].length
        if (mAlt[2] === 'h') { model.row = 1; model.col = 1; model.buf = Array.from({ length: ROWS }, () => new Array(COLS).fill(' ')) }
        continue
      }
      const mPriv = /^\x1b\[(\??)([0-9;]*)([ -/]*)([@-~])/.exec(text.slice(i))
      if (mPriv) {
        i += mPriv[0].length
        const priv = mPriv[1] === '?'
        const p = mPriv[2].length ? mPriv[2].split(';').map((x) => (x === '' ? 0 : Number(x))) : []
        const g = (n, d = 1) => (p[n] ? p[n] : d)
        const f = mPriv[4]
        if (priv && (f === 'h' || f === 'l')) continue   // mouse/paste/etc.
        switch (f) {
          case 'H': case 'f':
            model.row = Math.min(ROWS, Math.max(1, g(0, 1))); model.col = Math.min(COLS, Math.max(1, g(1, 1)))
            model.snap('CUP'); break
          case 'A': model.row = Math.max(1, model.row - g(0)); break
          case 'B': model.row = Math.min(ROWS, model.row + g(0)); break
          case 'C': model.col = Math.min(COLS, model.col + g(0)); break
          case 'D': model.col = Math.max(1, model.col - g(0)); break
          case 'G': model.col = Math.min(COLS, Math.max(1, g(0, 1))); model.snap('CHA'); break
          case 'd': model.row = Math.min(ROWS, Math.max(1, g(0, 1))); model.snap('VPA'); break
          case 'J': {
            const n = g(0, 0)
            if (n === 2) model.buf = Array.from({ length: ROWS }, () => new Array(COLS).fill(' '))
            model.snap('ED'); break
          }
          case 'K': {
            const n = g(0, 0)
            if (n === 0) for (let x = model.col; x <= COLS; x++) model.buf[model.row - 1][x - 1] = ' '
            else if (n === 2) model.buf[model.row - 1] = new Array(COLS).fill(' ')
            model.snap('EL'); break
          }
          default: break       // SGR 'm' and anything else: no cursor effect
        }
        continue
      }
      const mTwo = /^\x1b([()][A-Za-z0-9]|[=>])/.exec(text.slice(i))
      if (mTwo) { i += mTwo[0].length; continue }
      if (text[i + 1] === '7') { model.saved = { row: model.row, col: model.col } }
      else if (text[i + 1] === '8') { model.row = model.saved.row; model.col = model.saved.col; model.snap('DECRC') }
      else if (text[i + 1] === 'M') model.row = Math.max(1, model.row - 1)
      else if (text[i + 1] === 'D') model.row = Math.min(ROWS, model.row + 1)
      i += 2
      continue
    }
    if (ch === '\r') model.col = 1
    else if (ch === '\n') model.row = Math.min(ROWS, model.row + 1)
    else if (ch === '\b') model.col = Math.max(1, model.col - 1)
    else if (ch === '\x07') { /* bell */ }
    else if (ch >= ' ') model.put(ch)
    i++
  }
}

// ── fake TTYs ───────────────────────────────────────────────────────────────
class FakeStdout extends Writable {
  constructor() { super(); this.columns = COLS; this.rows = ROWS; this.isTTY = true; this.chunks = [] }
  _write(chunk, _enc, cb) {
    const s = chunk.toString('utf8')
    this.chunks.push(s)
    feed(s)
    cb()
  }
}
class FakeStdin extends Readable {
  constructor() { super({ read() {} }); this.isTTY = true; this.rawMode = false }
  _read() {}
  setRawMode(v) { this.rawMode = v; return this }
}

const fakeStdout = new FakeStdout()
const fakeStdin = new FakeStdin()
CPR_HANDLERS.push((row, col) => {
  const reply = `\x1b[${row};${col}R`
  setTimeout(() => { try { fakeStdin.push(reply) } catch { /* closed */ } }, CPR_DELAY_MS)
})

// The app reads process.stdout/process.stdin directly (frame writer, charwidth),
// so point the globals at the fakes.
const realStdout = process.stdout
const realStdin = process.stdin
Object.defineProperty(process, 'stdout', { value: fakeStdout, configurable: true, writable: true })
Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true, writable: true })

patchInkFullScreen(ROOT + 'node_modules')
const { render } = await import('ink')
const React = (await import('react')).default
const { App, store, tui } = await import('./src/index.tsx')
const conv = await import('./src/panels/conversation.tsx')
const { initCharWidthCalibration } = await import('./src/charwidth.ts')

conv.apply({ get: (k) => (k === 'tuiStore' ? store : k === 'tui' ? tui : undefined) })
store.setSize(COLS, ROWS)

// The slash palette only exists once commands are registered (the real app does
// this in `start()`); reproduce the real list, whose hints carry the ambiguous
// `—` and `…` and whose round border carries `╭ ─ ╮ │ ╰ ╯`.
for (const [n, hint] of [
  ['theme', 'switch colorscheme — Enter opens the theme list'],
  ['sidebar', 'show/hide the right Steps sidebar (auto/on/off)'],
  ['models', 'manage models and the API key'],
  ['sessions', 'list, filter, resume or delete sessions'],
  ['export', 'export the session (JSON/Markdown, sanitize)'],
  ['new', 'start a new session (the current one is saved)'],
  ['goal', 'set or view the goal for a long-running task'],
  ['plan', 'enter or leave plan mode'],
  ['selftest', 'run built-in self checks'],
  ['help', 'show this help'],
  ['think', 'show/hide details under Think and tool rows (reasoning + tool output)'],
  ['clear', 'clear the transcript'],
  ['exit', 'quit qialike'],
  ['compact', 'compact the session history'],
]) tui.commands.register({ name: n, hint, run: () => {} })

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

const app = render(
  React.createElement(App, { onSubmit: () => {}, onCancel: () => {}, onConnect: () => {} }),
  { stdout: fakeStdout, stdin: fakeStdin, stderr: realStdout, patchConsole: false, exitOnCtrlC: false },
)
conv.installFrameSuffix()
store.setWorkspace(process.env.REPRO_WORKSPACE ?? process.cwd())
store.setModelLabel('DeepSeek V4 Flash')
if (MODE === 'docked') {
  // Leave the hero the way `/new` or a resumed session does: attach a session
  // and drop `_heroAllowed`, so the docked chrome (status bar + card at the
  // bottom) is what the frame suffix parks the caret against.
  store.setSession({ id: 'session-repro-cursor' })
  store.leaveHero()
  await pause(120)
  store.append('user', 'hello')
  await pause(80)
  store.append('assistant', 'Hi! What would you like to build?')
}
// Start glyph-width calibration exactly as the TUI boot path does: the CPR probe
// batch — and therefore the reported flicker — belongs to this subsystem.
initCharWidthCalibration({
  isBusy: () => store.running || store.paused,
  onWidthsChanged: () => store.bumpWidths(),
})
await pause(900)   // let fingerprint() run and the first scan settle

// ── THE TRIGGER: type "/" ───────────────────────────────────────────────────
let scanCalls = 0
let scanChars = 0
{
  const inner = globalThis.__dshCharScan
  if (typeof inner === 'function') {
    globalThis.__dshCharScan = (lines) => { scanCalls++; scanChars += lines.join('').length; inner(lines) }
  }
}
const mark = model.timeline.length
store.setInput('/')
await pause(1500)

/** Does the painted palette actually cover the caret row? The frame suffix
 *  decides the caret's visibility from `commandPaletteBox` — the box the render
 *  published for THIS frame — so this recomputes the same range from the painted
 *  screen and reports a mismatch (before the fix the suffix used a plain
 *  `commandPaletteOpen` flag plus "hero ⇒ covered", which hid the caret even when
 *  a narrow palette never reached it). */
function geometry(label) {
  const caretRow = model.row
  const rows = model.buf.map((r) => r.join(''))
  // Locate the palette by its CONTENT (`│  /name — hint`), then add its two
  // border rows. Matching bare box borders would also catch the Steps sidebar.
  const contentRows = rows
    .map((t, i) => (/│ {2}\/[a-z]+ —/.test(t) ? i + 1 : 0))
    .filter((v) => v > 0)
  const pTop = contentRows.length ? contentRows[0] - 1 : -1
  const pBottom = contentRows.length ? contentRows[contentRows.length - 1] + 1 : -1
  let cTop = -1, cBottom = -1
  rows.forEach((t, i) => {
    if (cTop === -1 && t.includes('▄')) cTop = i + 1
    if (t.includes('▀')) cBottom = i + 1
  })
  const covers = pTop !== -1 && caretRow >= pTop && caretRow <= pBottom
  const shouldHide = covers
  const ok = model.vis !== shouldHide
  console.log(`\n[${label}] caret at row ${caretRow} col ${model.col}; palette rows ${pTop}..${pBottom}; card rows ${cTop}..${cBottom}`)
  console.log(`   palette covers the caret row: ${covers}; hardware cursor visible: ${model.vis}`)
  console.log(`   => caret visibility is ${ok ? 'CORRECT' : '*** WRONG ***'} (should be ${shouldHide ? 'hidden' : 'visible'})`)
  console.log(model.dump())
}

geometry('after "/" (14 matches)')
store.setInput('/help')
store.setCommandFilter('help')
await pause(400)
geometry('after "/help" (1 match)')

const tail = model.timeline.slice(mark)
console.log(`mode=${MODE}  CPR round trips during '/' : ${model.cprRequests}`)
console.log(`frames written: ${fakeStdout.chunks.length}`)
console.log(`diag: __dshCharScan calls during trigger = ${scanCalls} (chars ${scanChars})`)
console.log(`diag: __dshCharScan=${typeof globalThis.__dshCharScan} frameSuffix=${typeof globalThis.__dshTuiFrameSuffix} lock=${globalThis.__dshCalibrationLock} flush=${typeof globalThis.__dshCalibrationFlush}`)
console.log(`diag: store.running=${store.running} store.paused=${store.paused} panel=${store.panel}`)
{
  const m = globalThis.__dshCharWidths
  console.log(`diag: __dshCharWidths size=${m?.size} has(╭ 0x256d)=${m?.has?.(0x256d)} has(… 0x2026)=${m?.has?.(0x2026)} has(─ 0x2500)=${m?.has?.(0x2500)}`)
}
if (typeof globalThis.__dshCharScan === 'function') {
  globalThis.__dshCharScan(['  ╭──╮ │ … — ⠿ ▀ ▄'])
  await pause(800)
  console.log(`diag: after a manual scan, CPR round trips = ${model.cprRequests}`)
}

// ── analysis: where was the cursor VISIBLE ──────────────────────────────────
const cellMs = new Map()
const lastRowMs = { last: 0, lastButOne: 0 }
let visibleMs = 0
for (let i = 0; i < tail.length; i++) {
  const a = tail[i]
  const b = tail[i + 1]
  const dur = b ? Math.max(0, b.t - a.t) : 0
  if (!a.vis || dur === 0) continue
  visibleMs += dur
  const key = `row ${a.row} col ${a.col}`
  cellMs.set(key, (cellMs.get(key) ?? 0) + dur)
  if (a.row === ROWS) lastRowMs.last += dur
  else if (a.row === ROWS - 1) lastRowMs.lastButOne += dur
}

console.log(`\nvisible total: ${visibleMs.toFixed(1)} ms`)
console.log(`visible on LAST row (${ROWS})    : ${lastRowMs.last.toFixed(1)} ms`)
console.log(`visible on row ${ROWS - 1}       : ${lastRowMs.lastButOne.toFixed(1)} ms`)
console.log('\nvisible time per cell (top 8):')
const sorted = [...cellMs.entries()].sort((a, b) => b[1] - a[1])
for (const [k, v] of sorted.slice(0, 8)) console.log(`  ${k.padEnd(18)} ${v.toFixed(1)} ms`)

// ── full ordered transition list: show/hide alternation is the "blink" ──────
console.log('\nordered cursor transitions in the trigger window:')
for (const e of tail) {
  if (e.kind === '?25h' || e.kind === '?25l') {
    console.log(`  t=${(e.t - tail[0].t).toString().padStart(5)}ms  ${e.vis ? 'VISIBLE' : 'hidden '}  row ${String(e.row).padStart(2)} col ${String(e.col).padStart(3)}`)
  }
}

// The composer caret in the hero sits mid-screen, in the docked view near the
// bottom but NOT on the last row. Any visible time on the last two rows while
// the probe row is the last row is the reported "cursor blinking elsewhere".
const stray = lastRowMs.last + lastRowMs.lastButOne
console.log(`\nVERDICT: ${stray > 1 ? 'STRAY visible cursor on the probe/status rows = ' + stray.toFixed(1) + ' ms' : 'clean (no stray visible cursor)'}`)

app.unmount()
Object.defineProperty(process, 'stdout', { value: realStdout, configurable: true, writable: true })
Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true, writable: true })
process.exit(0)

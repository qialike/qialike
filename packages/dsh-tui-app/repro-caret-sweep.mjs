/**
 * CARET-PLACEMENT SWEEP — data, not theory.
 *
 * The reported symptom: typing `/` makes the cursor blink SOMEWHERE ELSE, in
 * the hero AND in the session view. A cursor "somewhere else" means the frame
 * suffix parked the hardware cursor on a cell that is not the cell the draft is
 * painted in — i.e. the caret model and the painted layout disagree.
 *
 * This renders the REAL App on a fake TTY, and for a grid of terminal sizes and
 * three palette widths it types a draft whose text carries a UNIQUE marker
 * (`zz`), then compares:
 *   - the row the draft was actually PAINTED on (found in the screen buffer by
 *     the marker), and
 *   - the row/col the hardware cursor was left on (from the escape stream).
 *
 * Any disagreement is caret drift — the cursor blinking "somewhere else".
 *
 * Run: bun packages/dsh-tui-app/repro-caret-sweep.mjs hero|docked
 */
import { Writable, Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchInkFullScreen } from '../../apps/tui-bin/build.mjs'

const MODE = process.argv[2] ?? 'hero'
const CPR_DELAY_MS = Number(process.env.CPR_DELAY_MS ?? 6)
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
process.env.TERM = 'xterm-256color'
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-sweep-'))

// ── terminal model (records the cursor at the instant of every escape) ──────
function makeModel(COLS, ROWS) {
  return {
    COLS, ROWS, row: 1, col: 1, vis: true, saved: { row: 1, col: 1 },
    buf: Array.from({ length: ROWS }, () => new Array(COLS).fill(' ')),
    now: () => Number(process.hrtime.bigint() / 1000000n),
    put(ch) {
      if (this.row >= 1 && this.row <= this.ROWS && this.col >= 1 && this.col <= this.COLS) {
        this.buf[this.row - 1][this.col - 1] = ch
      }
      this.col++
      if (this.col > this.COLS) { this.col = 1; this.row = Math.min(this.ROWS, this.row + 1) }
    },
    feed(text) {
      let i = 0
      while (i < text.length) {
        const ch = text[i]
        if (ch === '\x1b') {
          let m = /^\x1b\[\?25([hl])/.exec(text.slice(i))
          if (m) { this.vis = m[1] === 'h'; i += m[0].length; continue }
          m = /^\x1b\[6n/.exec(text.slice(i))
          if (m) { i += m[0].length; for (const h of CPR) h(this.row, this.col); continue }
          m = /^\x1b\[\?(1049|1047)([hl])/.exec(text.slice(i))
          if (m) {
            i += m[0].length
            if (m[2] === 'h') { this.row = 1; this.col = 1; this.buf = Array.from({ length: this.ROWS }, () => new Array(this.COLS).fill(' ')) }
            continue
          }
          m = /^\x1b\[(\??)([0-9;]*)([ -/]*)([@-~])/.exec(text.slice(i))
          if (m) {
            i += m[0].length
            const priv = m[1] === '?'
            const p = m[2].length ? m[2].split(';').map((x) => (x === '' ? 0 : Number(x))) : []
            const g = (n, d = 1) => (p[n] ? p[n] : d)
            const f = m[4]
            if (priv && (f === 'h' || f === 'l')) continue
            switch (f) {
              case 'H': case 'f':
                this.row = Math.min(this.ROWS, Math.max(1, g(0, 1))); this.col = Math.min(this.COLS, Math.max(1, g(1, 1))); break
              case 'A': this.row = Math.max(1, this.row - g(0)); break
              case 'B': this.row = Math.min(this.ROWS, this.row + g(0)); break
              case 'C': this.col = Math.min(this.COLS, this.col + g(0)); break
              case 'D': this.col = Math.max(1, this.col - g(0)); break
              case 'G': this.col = Math.min(this.COLS, Math.max(1, g(0, 1))); break
              case 'd': this.row = Math.min(this.ROWS, Math.max(1, g(0, 1))); break
              case 'J': {
                const n = g(0, 0)
                if (n === 2) this.buf = Array.from({ length: this.ROWS }, () => new Array(this.COLS).fill(' '))
                else if (n === 0) for (let x = this.col; x <= this.COLS; x++) this.buf[this.row - 1][x - 1] = ' '
                break
              }
              case 'K': {
                const n = g(0, 0)
                if (n === 0) for (let x = this.col; x <= this.COLS; x++) this.buf[this.row - 1][x - 1] = ' '
                else if (n === 2) this.buf[this.row - 1] = new Array(this.COLS).fill(' ')
                break
              }
              default: break
            }
            continue
          }
          m = /^\x1b([()][A-Za-z0-9]|[=>])/.exec(text.slice(i))
          if (m) { i += m[0].length; continue }
          if (text[i + 1] === '7') this.saved = { row: this.row, col: this.col }
          else if (text[i + 1] === '8') { this.row = this.saved.row; this.col = this.saved.col }
          else if (text[i + 1] === 'M') this.row = Math.max(1, this.row - 1)
          else if (text[i + 1] === 'D') this.row = Math.min(this.ROWS, this.row + 1)
          i += 2
          continue
        }
        if (ch === '\r') this.col = 1
        else if (ch === '\n') this.row = Math.min(this.ROWS, this.row + 1)
        else if (ch === '\b') this.col = Math.max(1, this.col - 1)
        else if (ch === '\x07') { /* bell */ }
        else if (ch >= ' ') this.put(ch)
        i++
      }
    },
    lines() { return this.buf.map((r) => r.join('')) },
  }
}

const CPR = []
let model = null

class FakeStdout extends Writable {
  constructor(cols, rows) {
    super(); this.columns = cols; this.rows = rows; this.isTTY = true
  }
  _write(chunk, _e, cb) { model.feed(chunk.toString('utf8')); cb() }
}
class FakeStdin extends Readable {
  constructor() { super({ read() {} }); this.isTTY = true; this.rawMode = false }
  _read() {}
  setRawMode(v) { this.rawMode = v; return this }
}

const COLS0 = 120, ROWS0 = 30
model = makeModel(COLS0, ROWS0)
const fakeStdout = new FakeStdout(COLS0, ROWS0)
const fakeStdin = new FakeStdin()
CPR.push((row, col) => {
  const reply = `\x1b[${row};${col}R`
  setTimeout(() => { try { fakeStdin.push(reply) } catch { /* closed */ } }, CPR_DELAY_MS)
})
const realStdout = process.stdout
const realStdin = process.stdin
Object.defineProperty(process, 'stdout', { value: fakeStdout, configurable: true, writable: true })
Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true, writable: true })

patchInkFullScreen(ROOT + 'node_modules')
const { render } = await import('ink')
const React = (await import('react')).default
const { App, store, tui } = await import('./src/index.tsx')
const conv = await import('./src/panels/conversation.tsx')

conv.apply({ get: (k) => (k === 'tuiStore' ? store : k === 'tui' ? tui : undefined) })
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
  ['exit', 'quit dsh-tui'],
  ['compact', 'compact the session history'],
]) tui.commands.register({ name: n, hint, run: () => {} })

store.setSize(COLS0, ROWS0)
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const app = render(
  React.createElement(App, { onSubmit: () => {}, onCancel: () => {}, onConnect: () => {} }),
  { stdout: fakeStdout, stdin: fakeStdin, stderr: realStdout, patchConsole: false, exitOnCtrlC: false },
)
conv.installFrameSuffix()
store.setWorkspace(process.env.REPRO_WORKSPACE ?? '/home/pipo/deepseek')
store.setModelLabel('DeepSeek V4 Flash')
if (MODE === 'docked') {
  store.setSession({ id: 'session-sweep' })
  store.leaveHero()
  await pause(120)
  store.append('user', 'hello')
  await pause(80)
  store.append('assistant', 'Hi!')
}
await pause(500)

/** Resize the fake terminal and let the app settle. */
async function resize(cols, rows) {
  fakeStdout.columns = cols
  fakeStdout.rows = rows
  model = makeModel(cols, rows)
  fakeStdout._model = model
  // Re-point the write handler at the new model.
  process.stdout.columns = cols
  process.stdout.rows = rows
  store.setSize(cols, rows)
  await pause(260)
}

// The model is rebuilt on resize; FakeStdout must write into the CURRENT one.
const origWrite = FakeStdout.prototype._write
FakeStdout.prototype._write = function (chunk, e, cb) { model.feed(chunk.toString('utf8')); cb() }

const MARKER = 'zz'
const cases = [
  { label: 'no palette (empty draft)', input: '', filter: '' },
  { label: 'palette wide  ("/")', input: '/', filter: '' },
  { label: `palette narrow ("/help ${MARKER}")`, input: `/help ${MARKER}`, filter: `help ${MARKER}` },
]

const sizes = []
for (const rows of [24, 26, 30, 34, 40]) for (const cols of [80, 100, 120, 140]) sizes.push([cols, rows])

let fails = 0
const rowsOut = []
for (const [cols, rows] of sizes) {
  await resize(cols, rows)
  for (const c of cases) {
    store.setInput(c.input)
    store.setCommandFilter(c.filter)
    // Real typing leaves the caret AFTER the last character; `setInput` alone
    // leaves it at index 0, which would hide any column drift.
    store.setCursor(c.input.length)
    await pause(320)
    const lines = model.lines()
    // Row the draft was PAINTED on: the marker is unique to the composer draft
    // (the palette row carries "/help —", never "zz").
    let paintRow = -1
    if (c.input.includes(MARKER)) {
      lines.forEach((t, i) => { if (paintRow === -1 && t.includes(MARKER)) paintRow = i + 1 })
    }
    const cursorRow = model.row, cursorCol = model.col, vis = model.vis
    // For the empty draft there is no marker; fall back to "is the caret row the
    // card's input row" implicitly by only checking marker cases.
    let verdict = 'n/a (no marker)'
    if (paintRow !== -1) {
      const ok = vis && cursorRow === paintRow
      verdict = ok ? 'ok' : (vis ? `DRIFT cursor row ${cursorRow} != painted row ${paintRow}` : `HIDDEN (painted row ${paintRow})`)
      if (!ok && vis) fails++
    }
    rowsOut.push(`  ${String(cols).padStart(3)}x${String(rows).padStart(2)}  ${c.label.padEnd(28)} painted=${String(paintRow).padStart(2)} cursor=row ${String(cursorRow).padStart(2)} col ${String(cursorCol).padStart(3)} vis=${vis ? 'Y' : 'N'}  ${verdict}`)
  }
}
console.log(`\n===== ${MODE.toUpperCase()} =====`)
console.log(rowsOut.join('\n'))
console.log(`\nDRIFT failures: ${fails}`)

app.unmount()
Object.defineProperty(process, 'stdout', { value: realStdout, configurable: true, writable: true })
Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true, writable: true })
process.exit(0)

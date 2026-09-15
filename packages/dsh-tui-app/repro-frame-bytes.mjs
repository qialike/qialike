/**
 * Exact frame-size measurement, in process.
 *
 * A pty splits a single stdout write() when it exceeds the line-discipline
 * buffer (~4096 B), and the terminal then paints an intermediate picture. So the
 * question "can a frame tear?" is really "how big is each write(), and is the
 * palette box complete inside ONE of them?" — both answerable exactly by
 * recording the writes instead of inferring them from pty reads (whose chunking
 * depends on reader timing).
 *
 * Reports, per write: byte size, and whether it carries the palette's box (both
 * borders), plus a byte breakdown (escapes vs text) and the savings a
 * trailing-space collapse would give.
 *
 * Run: bun packages/dsh-tui-app/repro-frame-bytes.mjs [hero|docked]
 */
import { Writable, Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchInkFullScreen } from '../../apps/tui-bin/build.mjs'

const MODE = process.argv[2] ?? 'hero'
const COLS = Number(process.env.PCOLS ?? 200)
const ROWS = Number(process.env.PROWS ?? 60)
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
process.env.TERM = 'xterm-256color'
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-fb-'))

const writes = []
class FakeStdout extends Writable {
  constructor() { super(); this.columns = COLS; this.rows = ROWS; this.isTTY = true }
  _write(chunk, _e, cb) { writes.push(chunk.toString('utf8')); cb() }
}
class FakeStdin extends Readable {
  constructor() { super({ read() {} }); this.isTTY = true; this.rawMode = false }
  _read() {}
  setRawMode(v) { this.rawMode = v; return this }
}
const fakeStdout = new FakeStdout()
const fakeStdin = new FakeStdin()
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

store.setSize(COLS, ROWS)
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const app = render(
  React.createElement(App, { onSubmit: () => {}, onCancel: () => {}, onConnect: () => {} }),
  { stdout: fakeStdout, stdin: fakeStdin, stderr: realStdout, patchConsole: false, exitOnCtrlC: false },
)
conv.installFrameSuffix()
store.setWorkspace(process.env.REPRO_WORKSPACE ?? '/home/pipo/deepseek')
store.setModelLabel('DeepSeek V4 Flash')
if (MODE === 'docked') {
  store.setSession({ id: 'session-fb' })
  store.leaveHero()
  await pause(120)
  store.append('user', 'hello')
  await pause(80)
  store.append('assistant', 'Hi!')
}
await pause(600)

/** Trailing run of plain spaces at the end of a rendered line (after SGR codes),
 *  which `ESC[K` under the same background could paint far more cheaply. */
function trailingSpaceSavings(frame) {
  let saved = 0
  for (const line of frame.split('\n')) {
    const m = /( +)((?:\x1b\[[0-9;]*m)*)$/.exec(line)
    if (m) saved += m[1].length - 4 // ESC[K costs ~4 bytes
  }
  return Math.max(0, saved)
}

const mark = writes.length
store.setInput('/')
await pause(1200)

const post = writes.slice(mark)
console.log(`mode=${MODE}  ${COLS}x${ROWS}  frames written after '/': ${post.length}\n`)
let paletteWrite = null
for (let i = 0; i < post.length; i++) {
  const w = post[i]
  const len = Buffer.byteLength(w)
  const hasTop = w.includes('\u256d')
  const hasBot = w.includes('\u256f')
  const esc = w.match(/\x1b\[[0-9;?]*[ -/]*[@-~]/g) ?? []
  const escB = esc.reduce((n, e) => n + e.length, 0)
  const save = trailingSpaceSavings(w)
  const tag = hasTop && hasBot ? '  <- PALETTE (both borders in ONE write)' : hasTop ? '  <- palette top only' : ''
  console.log(`  write ${i}: ${String(len).padStart(6)} B   escapes ${String(escB).padStart(5)} B `
    + `(${Math.round(100 * escB / len)}%)   trailing-space savings ~${save} B${tag}`)
  if (hasTop && hasBot && paletteWrite === null) paletteWrite = { i, len, escB, save }
}

if (paletteWrite) {
  const { len, save } = paletteWrite
  console.log(`\npalette-opening write: ${len} B`)
  console.log(`  pty line-discipline buffer is ~4096 B, so this write `
    + (len > 4096 ? 'IS SPLIT (the terminal can paint it half-drawn)' : 'arrives in one piece'))
  console.log(`  with a trailing-space collapse it would be ~${len - save} B `
    + `(${len - save > 4096 ? 'still split' : 'under the limit'})`)
} else {
  console.log('\npalette-opening write not found')
}

app.unmount()
Object.defineProperty(process, 'stdout', { value: realStdout, configurable: true, writable: true })
Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true, writable: true })
process.exit(0)

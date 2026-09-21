// Headless render of the update HINT, on both surfaces it has to appear on.
//
// Why this exists: the hint is one line, and where it lands is the whole feature —
// the user asked for the status line, not a dialog. That is a property of real frames:
//
//  - on the HERO (blank session, startup) the row under the card is the only status
//    line there is, and the hero is chrome-free by design (no status bar at all);
//  - in a CONVERSATION it has to sit in the docked status bar, next to the busy
//    indicator and before the stats, without pushing the stats off the right edge.
//
// It is self-checking: it renders through the real App/store, reconstructs each screen
// from the ANSI stream, and fails if the hint is missing, appears on the wrong row, or
// takes over the screen the way the (withdrawn) dialog did.
//
// Run with: bun run packages/qialike-app/repro-update-hint.mjs
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { patchInkFullScreen } from '../../apps/tui-bin/build.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
patchInkFullScreen(ROOT + 'node_modules')

const { render } = await import('ink')
const React = (await import('react')).default
const { App, store, tui } = await import('./src/index.tsx')
// The conversation panel is the App's fallback surface — and the hero lives inside it.
const conv = await import('./src/panels/conversation.tsx')
conv.apply({ get: (key) => (key === 'tuiStore' ? store : key === 'tui' ? tui : undefined) })

// Frame size is MUTABLE, and the fake stdout is the source of truth: Ink lays out from
// `stdout.columns`, so `store.setSize` alone changes the model but not the frame — a
// "narrow terminal" check written that way re-renders the same 100 columns and proves
// nothing. `resize()` drives both, and `capture()` reads the live dimensions.
const W = 100
const H = 30
let frameWidth = W
let frameHeight = H
const writes = []
class FakeStdout extends Writable {
  constructor() { super(); this.columns = W; this.rows = H; this.isTTY = true }
  _write(chunk, _encoding, callback) { writes.push(chunk.toString('utf8')); callback() }
  resize(columns, rows) {
    this.columns = columns
    this.rows = rows
    this.emit('resize')
  }
}

const GITHUB = 'https://github.com/qialike/qialike/releases/download/0.6.3/qialike-windows-x64.zip'
const GITCODE = 'https://gitcode.com/qialike/qialike/releases/download/0.6.3/qialike-windows-x64.zip'

store.setSize(W, H)
const stdout = new FakeStdout()
const app = render(
  React.createElement(App, { onSubmit: () => {}, onCancel: () => {}, onConnect: () => {} }),
  { stdout, stdin: process.stdin, stderr: process.stderr, patchConsole: false },
)
/** Resize BOTH the terminal Ink draws into and the model the panel lays out from. */
function resize(columns, rows) {
  frameWidth = columns
  frameHeight = rows
  stdout.resize(columns, rows)
  store.setSize(columns, rows)
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** Matching form for a flattened frame: padding and box glyphs removed. */
const flatOf = (screen) => screen.join('').replace(/\s+/g, '').replace(/[│─╭╮╰╯]/g, '')
const need = (text) => text.replace(/\s+/g, '')
await pause(150)

// Replay every write so far onto a fresh grid, so each capture is the CURRENT screen.
function capture() {
  const cells = Array.from({ length: frameHeight }, () => Array(frameWidth).fill(' '))
  let row = 0
  let col = 0
  const clearRow = (target) => { for (let i = 0; i < frameWidth; i += 1) cells[target][i] = ' ' }
  for (const chunk of writes) {
    let i = 0
    while (i < chunk.length) {
      const ch = chunk[i]
      if (ch === '\x1b') {
        if (chunk[i + 1] === '[') {
          let j = i + 2
          let param = ''
          while (j < chunk.length && !/[@-~]/.test(chunk[j])) { param += chunk[j]; j += 1 }
          const fin = chunk[j]
          if (fin === 'H' || fin === 'f') { const p = param.split(';').map((x) => parseInt(x, 10)); row = (p[0] || 1) - 1; col = (p[1] || 1) - 1 }
          // Ink positions with cursorTo/cursorMove, which are the ABSOLUTE forms (CHA
          // `\x1b[<n>G`, VPA `\x1b[<n>d`) as often as the relative ones — skipping them
          // makes the replay drift and every check below lie.
          else if (fin === 'G') col = Math.min(frameWidth - 1, (parseInt(param, 10) || 1) - 1)
          else if (fin === 'd') row = Math.min(frameHeight - 1, (parseInt(param, 10) || 1) - 1)
          else if (fin === 'A') row = Math.max(0, row - (parseInt(param, 10) || 1))
          else if (fin === 'B') row = Math.min(frameHeight - 1, row + (parseInt(param, 10) || 1))
          else if (fin === 'C') col = Math.min(frameWidth - 1, col + (parseInt(param, 10) || 1))
          else if (fin === 'D') col = Math.max(0, col - (parseInt(param, 10) || 1))
          else if (fin === 'K') { if (param === '2' || param === '') clearRow(row) }
          else if (fin === 'J') { if (param === '0' || param === '') { for (let y = row; y < frameHeight; y += 1) clearRow(y) } else { for (let y = 0; y < frameHeight; y += 1) clearRow(y) } }
          i = j + 1
          continue
        }
        i += 2
        continue
      }
      if (ch === '\r') { col = 0; i += 1; continue }
      if (ch === '\n') { row = Math.min(frameHeight - 1, row + 1); col = 0; i += 1; continue }
      if (ch === '\b') { col = Math.max(0, col - 1); i += 1; continue }
      if (col < frameWidth) cells[row][col] = ch
      col += 1
      i += 1
    }
  }
  const screen = cells.map((line) => line.join('').replace(/\s+$/, ''))
  return { screen, flat: flatOf(screen), rows: cells.map((line) => line.join('')) }
}

// ── 1. HERO: the hint must appear, and the hero must still be the hero ─────────
const heroBefore = capture()
console.log('=== hero, before the check ===')
console.log(heroBefore.screen.join('\n'))
if (!store.hero) {
  console.error('\nrepro-update-hint: FAIL — expected the hero surface')
  process.exit(1)
}
if (heroBefore.flat.includes(need('0.6.3'))) {
  console.error('\nrepro-update-hint: FAIL — the hint was up before the check ran')
  process.exit(1)
}

// Exactly what the startup check does on Windows (`scheduleAutoCheck` -> `noteUpdate`).
store.noteUpdate({ installed: '0.6.2', version: '0.6.3', urls: [GITHUB, GITCODE] })
await pause(300)
const hero = capture()
console.log('\n=== hero, hint up ===')
for (const [index, line] of hero.screen.entries()) if (line.trim() !== '') console.log(`${String(index + 1).padStart(2)} | ${line}`)

const HINT = 'Update available: 0.6.3 - /upgrade for links'
if (!hero.flat.includes(need(HINT))) {
  console.error('\nrepro-update-hint: FAIL — the hero frame does not carry the hint')
  process.exit(1)
}
// The hint replaces the tip row (same row count), and the hero stays chrome-free: no
// status bar, and certainly no full-screen box over it.
if (hero.flat.includes(need('Download it and replace'))) {
  console.error('\nrepro-update-hint: FAIL — a dialog-looking block is on screen')
  process.exit(1)
}
if (hero.screen.filter((line) => line.trim() !== '').length > 12) {
  console.error('\nrepro-update-hint: FAIL — too many painted rows for a hero + hint')
  process.exit(1)
}

// ── 2. CONVERSATION: the same hint, at the RIGHT of the docked status bar ──────
// `hero` is about SESSION state, so leaving it takes a session; the read-only phase is
// the documented way to be docked without one. Stats are injected on purpose: the
// placement to verify is "immediately LEFT of the stats, both on the right", and an
// empty session paints no stats at all.
store.beginReadOnlySession('repro-session')
store.setStats({ turns: 3, steps: 7, llmMs: 1200, toolMs: 300, inputTokens: 4200, outputTokens: 900 })
await pause(300)
const conversation = capture()
console.log('\n=== conversation, hint in the status bar ===')
for (const [index, line] of conversation.screen.entries()) if (line.trim() !== '') console.log(`${String(index + 1).padStart(2)} | ${line}`)

if (store.hero) {
  console.error('\nrepro-update-hint: FAIL — expected the docked conversation view')
  process.exit(1)
}
// The leading FACT has to be visible even when the stats share the bar: the hint is
// what yields space (`flexShrink={1}`), so it can be truncated but never absent.
if (!conversation.flat.includes(need('Update available: 0.6.3'))) {
  console.error('\nrepro-update-hint: FAIL — the docked frame does not carry the hint')
  process.exit(1)
}
// The hint lives INSIDE the bottom status bar (the last painted box), not in a
// transcript row that would slide away as the conversation grows.
const hintRow = conversation.rows.findIndex((row) => flatOf([row]).includes(need('Updateavailable:0.6.3')))
const barTop = conversation.rows.findIndex((row) => row.includes('╭'))
if (hintRow < 0 || barTop < 0 || hintRow <= barTop) {
  console.error(`\nrepro-update-hint: FAIL — the hint is not inside the status bar (hintRow=${hintRow}, barTop=${barTop})`)
  process.exit(1)
}
// The placement the user asked for: the hint is on the RIGHT — after the busy
// indicator, and immediately LEFT of the stats, which keep the row's right edge.
const bar = (conversation.rows[hintRow] ?? '').replace(/[│|]\s*$/, '')
const at = (needle) => bar.indexOf(needle)
const spinnerAt = at('⠿')
const hintAt = at('Update available:')
const stepsAt = at('7 steps')
const tokAt = at('4.2k')
// Right of the busy indicator, left of the stats: the placement the user asked for.
if (!(spinnerAt >= 0 && hintAt > spinnerAt && stepsAt > hintAt && tokAt > stepsAt)) {
  console.error(`\nrepro-update-hint: FAIL — wrong order in the status bar: spinner=${spinnerAt} hint=${hintAt} steps=${stepsAt} tok=${tokAt}`)
  process.exit(1)
}
// The hint must not touch the busy indicator (the spacer can collapse on a full row).
if (bar.slice(spinnerAt, hintAt).endsWith('Idle') && !/\s$/.test(bar.slice(0, hintAt))) {
  console.error(`\nrepro-update-hint: FAIL — the hint butts against the busy indicator: [${bar}]`)
  process.exit(1)
}
// ...and the stats still END the row: the right edge was not given away to the hint.
if (!bar.replace(/\s+$/, '').endsWith('tok out')) {
  console.error(`\nrepro-update-hint: FAIL — the stats no longer end the status bar: [${bar}]`)
  process.exit(1)
}
// A narrow terminal must truncate the HINT, never push the stats off.
resize(64, H)
await pause(300)
const narrow = capture()
const narrowBar = (narrow.rows.find((row) => row.includes('tok out')) ?? '').trimEnd()
if (!narrow.flat.includes(need('tokout'))) {
  console.error('\nrepro-update-hint: FAIL — a 64-column status bar lost the stats')
  process.exit(1)
}
console.log(`\n=== narrow (64 cols) status bar ===\n${narrowBar}`)
// Wide enough for the hint AND the stats: now the full wording has to be on screen,
// which is what pins the text itself (at 100 columns it is clipped by design).
resize(140, H)
await pause(300)
const wide = capture()
if (!wide.flat.includes(need(HINT))) {
  console.error('\nrepro-update-hint: FAIL — a 140-column status bar does not show the whole hint')
  process.exit(1)
}
console.log(`\n=== 140 cols (whole hint) ===\n${(wide.rows.find((row) => row.includes('tok out')) ?? '').trimEnd()}`)
resize(W, H)
await pause(200)

app.unmount()
console.log('\nrepro-update-hint: PASS — the hint lands in the hero row and in the docked status bar,')
console.log('                   and nothing takes the screen over')

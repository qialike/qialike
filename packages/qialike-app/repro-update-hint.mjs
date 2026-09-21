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

const W = 100
const H = 30
const writes = []
class FakeStdout extends Writable {
  constructor() { super(); this.columns = W; this.rows = H; this.isTTY = true }
  _write(chunk, _encoding, callback) { writes.push(chunk.toString('utf8')); callback() }
}

const GITHUB = 'https://github.com/qialike/qialike/releases/download/0.6.3/qialike-windows-x64.zip'
const GITCODE = 'https://gitcode.com/qialike/qialike/releases/download/0.6.3/qialike-windows-x64.zip'

store.setSize(W, H)
const app = render(
  React.createElement(App, { onSubmit: () => {}, onCancel: () => {}, onConnect: () => {} }),
  { stdout: new FakeStdout(), stdin: process.stdin, stderr: process.stderr, patchConsole: false },
)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** Matching form for a flattened frame: padding and box glyphs removed. */
const flatOf = (screen) => screen.join('').replace(/\s+/g, '').replace(/[│─╭╮╰╯]/g, '')
const need = (text) => text.replace(/\s+/g, '')
await pause(150)

// Replay every write so far onto a fresh grid, so each capture is the CURRENT screen.
function capture() {
  const cells = Array.from({ length: H }, () => Array(W).fill(' '))
  let row = 0
  let col = 0
  const clearRow = (target) => { for (let i = 0; i < W; i += 1) cells[target][i] = ' ' }
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
          else if (fin === 'G') col = Math.min(W - 1, (parseInt(param, 10) || 1) - 1)
          else if (fin === 'd') row = Math.min(H - 1, (parseInt(param, 10) || 1) - 1)
          else if (fin === 'A') row = Math.max(0, row - (parseInt(param, 10) || 1))
          else if (fin === 'B') row = Math.min(H - 1, row + (parseInt(param, 10) || 1))
          else if (fin === 'C') col = Math.min(W - 1, col + (parseInt(param, 10) || 1))
          else if (fin === 'D') col = Math.max(0, col - (parseInt(param, 10) || 1))
          else if (fin === 'K') { if (param === '2' || param === '') clearRow(row) }
          else if (fin === 'J') { if (param === '0' || param === '') { for (let y = row; y < H; y += 1) clearRow(y) } else { for (let y = 0; y < H; y += 1) clearRow(y) } }
          i = j + 1
          continue
        }
        i += 2
        continue
      }
      if (ch === '\r') { col = 0; i += 1; continue }
      if (ch === '\n') { row = Math.min(H - 1, row + 1); col = 0; i += 1; continue }
      if (ch === '\b') { col = Math.max(0, col - 1); i += 1; continue }
      if (col < W) cells[row][col] = ch
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

const HINT = '⬆ qialike 0.6.3 available (you have 0.6.2) — /upgrade for the download links'
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

// ── 2. CONVERSATION: the same hint, in the docked status bar ───────────────────
// `hero` is about SESSION state, so leaving it takes a session; the read-only phase is
// the documented way to be docked without one.
store.beginReadOnlySession('repro-session')
await pause(300)
const conversation = capture()
console.log('\n=== conversation, hint in the status bar ===')
for (const [index, line] of conversation.screen.entries()) if (line.trim() !== '') console.log(`${String(index + 1).padStart(2)} | ${line}`)

if (store.hero) {
  console.error('\nrepro-update-hint: FAIL — expected the docked conversation view')
  process.exit(1)
}
if (!conversation.flat.includes(need(HINT))) {
  console.error('\nrepro-update-hint: FAIL — the docked frame does not carry the hint')
  process.exit(1)
}
// The hint lives INSIDE the bottom status bar (the last painted box), not in a
// transcript row that would slide away as the conversation grows.
const hintRow = conversation.rows.findIndex((row) => flatOf([row]).includes(need('qialike0.6.3available')))
const barTop = conversation.rows.findIndex((row) => row.includes('╭'))
if (hintRow < 0 || barTop < 0 || hintRow <= barTop) {
  console.error(`\nrepro-update-hint: FAIL — the hint is not inside the status bar (hintRow=${hintRow}, barTop=${barTop})`)
  process.exit(1)
}

app.unmount()
console.log('\nrepro-update-hint: PASS — the hint lands in the hero row and in the docked status bar,')
console.log('                   and nothing takes the screen over')

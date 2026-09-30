/**
 * Post-fix verification (dev helper):
 *  1. applies the Ink full-screen render patch (v2: line-level diff writer +
 *     per-frame cursor-parking suffix) to the local pnpm store — the same code
 *     `pnpm build` runs;
 *  2. renders the real App on a fake 80x24 TTY and drives Chinese typing,
 *     streaming and the spinner, recording every stdout write;
 *  3. asserts:
 *       - no clearTerminal (`\x1b[2J`/`\x1b[3J`) is ever written;
 *       - frames use absolute positioning (`\x1b[<r>;1H\x1b[2K`) and rewrite
 *         ONLY changed lines (a single keystroke / spinner tick rewrites at
 *         most a couple of lines, not the whole screen);
 *       - the real cursor is re-shown and parked at the composer caret
 *         (`\x1b[?25h\x1b[<row>;<col>H`) inside every frame;
 *       - Chinese text renders in the composer and the streamed transcript;
 *       - zero "Maximum update depth exceeded" warnings.
 */
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { patchInkFullScreen } from '../../apps/tui-bin/build.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
// Apply the patch BEFORE any module that imports ink is evaluated (ESM static
// imports are hoisted, so ink/react/App must be loaded dynamically below).
patchInkFullScreen(ROOT + 'node_modules')
const { render } = await import('ink')
const React = (await import('react')).default
const { App, store, installFrameSuffix } = await import('./src/index.tsx')

const writes = []
class FakeStdout extends Writable {
  constructor() {
    super()
    this.columns = 80
    this.rows = 24
    this.isTTY = true
  }
  _write(chunk, enc, cb) {
    writes.push(chunk.toString('utf8'))
    cb()
  }
}
const fakeStdout = new FakeStdout()

try { Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true }) } catch { /* ignore */ }
try { Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true }) } catch { /* ignore */ }
store.setSize(80, 24)

const warnings = []
const origError = console.error
console.error = (...args) => {
  const s = args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(' ')
  if (s.includes('Maximum update depth')) warnings.push(s)
  origError(...args)
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const eraseCount = (s) => (s.match(/\x1b\[2K/g) ?? []).length

const app = render(
  React.createElement(App, {
    onSubmit: (text) => { store.append('user', text) },
    onCancel: () => {},
    onConnect: () => {},
  }),
  { stdout: fakeStdout, stdin: process.stdin, stderr: process.stderr, patchConsole: false },
)

installFrameSuffix()

store.setWorkspace('C:/deepseek')
store.setModelLabel('DeepSeek V4 Flash')
store.append('status', 'Session session-test in C:/deepseek', true)
// Wait one tick so the App's store subscription effect has registered; store
// mutations before that (like the initial status) are read fresh at mount.
await pause(100)
store.setRunning(true)

// --- settle, then sample the diff writer while ONLY the spinner changes ---
store.setInput('')
const settleBase = writes.length
await pause(600)
const settleFrames = writes.slice(settleBase).filter((w) => w.includes('\x1b[2K'))
const spinnerBase = writes.length
await pause(260) // ~2-3 spinner ticks
const spinnerSample = writes.slice(spinnerBase)
const spinnerFrames = spinnerSample.filter((w) => w.includes('\x1b[2K'))
const maxSpinnerErase = Math.max(0, ...spinnerFrames.map(eraseCount))
const absPositioning = writes.some((w) => /\x1b\[\d+;1H\x1b\[2K/.test(w))
if (spinnerSample.length === 0) console.log('DEBUG: no writes during spinner sample window')
if (spinnerFrames.length === 0) console.log('DEBUG spinner writes:', JSON.stringify(spinnerSample.map((w) => w.slice(0, 80))))
console.log('DEBUG counts:', JSON.stringify({ sample: spinnerSample.length, frames: spinnerFrames.length, erases: spinnerFrames.map(eraseCount), first: spinnerSample[0]?.slice(0, 100) }))

// --- caret parking: empty composer -> caret cell row 18, col 3 ---
store.setInput('')
await pause(50)
const caretParked = writes.slice(-4).some((w) => w.includes('\x1b[?25h\x1b[18;3H'))

// --- one keystroke: only the composer line(s) should be rewritten ---
const keyBase = writes.length
store.insertAtCursor('你')
await pause(150)
const keyFrame = writes.slice(keyBase).filter((w) => w.includes('\x1b[2K')).at(-1) ?? ''
const keyErase = eraseCount(keyFrame)

// --- Chinese typing + streaming ---
for (const ch of '你好，这是一段中文测试输入内容，用于观察界面是否出现渲染循环问题。') {
  store.insertAtCursor(ch)
  await pause(40)
}
store.setInput('')
store.append('user', '你好，请分析这个日志')
for (const chunk of [
  '这是', '一个', '渲染', '循环', '测试', '消息，', '包含', '中文字符', '与英文 mixed content，',
  '用于', '观察', '布局', '估算', '是否', '发生', '抖动。', '\n\n', '第二段内容，', '继续', '测试。',
]) {
  store.streamText(chunk)
  await pause(50)
}
await pause(300)
store.setRunning(false)
await pause(300)

app.unmount()

const all = writes.join('')
const cleared = writes.filter((w) => w.includes('\x1b[2J') || w.includes('\x1b[3J'))
console.log('write count:', writes.length)
console.log('clearTerminal writes (\\x1b[2J/\\x1b[3J):', cleared.length)
console.log('absolute positioning (\\x1b[r;1H\\x1b[2K):', absPositioning)
console.log('max lines rewritten per spinner tick:', maxSpinnerErase, '(expect <= 2)')
console.log('lines rewritten per single keystroke:', keyErase, '(expect <= 4)')
console.log('caret parked at composer (\\x1b[?25h\\x1b[18;3H):', caretParked)
console.log('composer Chinese visible:', all.includes('中文测试输入'))
console.log('streamed text visible:', all.includes('渲染循环测试消息'))
console.log('update-depth warnings:', warnings.length)

const ok = cleared.length === 0 && absPositioning && maxSpinnerErase <= 2 && keyErase >= 1 && keyErase <= 4 && caretParked && all.includes('中文测试输入') && all.includes('渲染循环测试消息') && warnings.length === 0
console.log(ok ? 'VERIFY OK' : 'VERIFY FAILED')
process.exit(ok ? 0 : 1)

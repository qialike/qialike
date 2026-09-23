/**
 * Deterministic verification of transcript scrolling (PgUp/PgDn gap stability).
 * Renders the real App on a fake 80x24 TTY, records every stdout write,
 * reconstructs the terminal screen from the raw ANSI stream, and decodes the
 * transition frames row by row. No app/build sources are touched.
 */
import { Writable } from 'node:stream'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchInkFullScreen } from '../../apps/tui-bin/build.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const OUT = process.env.REPRO_OUT ?? join(tmpdir(), 'qialike-repro', 'repro')
mkdirSync(OUT, { recursive: true })

patchInkFullScreen(ROOT + 'node_modules')
const { render } = await import('ink')
const React = (await import('react')).default
const { App, store, tui } = await import('./src/index.tsx')
const conv = await import('./src/panels/conversation.tsx')
const { installFrameSuffix } = conv
conv.apply({
  get: (key) => (key === 'tuiStore' ? store : key === 'tui' ? tui : undefined),
})

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
try { Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true }) } catch {}
try { Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true }) } catch {}
store.setSize(80, 24)
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

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
store.append('status', 'Session repro in C:/deepseek', true)
await pause(120)
const firstStatusEnd = writes.length

const turns = [
  ['你能做什么？', '我能做的事情很多：\n\n- 阅读和修改工作区里的文件\n- 运行命令并查看输出\n- 搜索代码与文档\n\n这些能力都来自 deepseek-harness。'],
  ['帮我看下这个报错', '报错是模块未找到。\n\n先检查 package.json 的依赖，然后重新安装。\n\n如果还不行，把完整堆栈贴出来。'],
  ['继续', '接下来是第二段分析：\n\n问题的根因在于 import 路径写错了。\n\n修复后记得跑一遍测试确认没有回归。'],
  ['还有别的吗', '还可以做这些：\n\n1. 审查 PR 的 diff\n2. 写单元测试\n3. 更新文档\n\n按需选择即可。'],
  ['好，最后一个问题', '好的。这是最后一条长一点的回复，用来确保翻页时能看到完整的上下文间距：\n\n第一段正文内容，讨论布局与测量。\n\n第二段正文内容，讨论滚动与裁剪。\n\n第三段收尾。'],
]
for (const [u, a] of turns) {
  store.append('user', u)
  await pause(60)
  store.streamText(a)
  await pause(60)
  store.settleAssistantText(a)
  await pause(350)
}
await pause(900)

const state = () => JSON.stringify({
  scroll: store.scroll, follow: store.followTail,
  layout: store._layoutContent, viewport: store._layoutViewport,
})

function makeScreen() {
  const W = 80, H = 24
  const cells = Array.from({ length: H }, () => Array(W).fill(''))
  let r = 0, c = 0
  const clearRow = (row) => { for (let i = 0; i < W; i++) cells[row][i] = '' }
  return {
    cells,
    apply(chunk) {
      let i = 0
      const s = chunk
      while (i < s.length) {
        const ch = s[i]
        if (ch === '\x1b') {
          if (s[i + 1] === '[') {
            let j = i + 2
            let param = ''
            while (j < s.length && !/[@-~]/.test(s[j])) { param += s[j]; j++ }
            const fin = s[j]
            if (fin === 'H' || fin === 'f') {
              const [rr, cc] = param.split(';').map((x) => parseInt(x, 10))
              r = (rr || 1) - 1; c = (cc || 1) - 1
              if (r >= H) r = H - 1
              if (c >= W) c = W - 1
            } else if (fin === 'A') r = Math.max(0, r - (parseInt(param, 10) || 1))
            else if (fin === 'B') r = Math.min(H - 1, r + (parseInt(param, 10) || 1))
            else if (fin === 'C') c = Math.min(W - 1, c + (parseInt(param, 10) || 1))
            else if (fin === 'D') c = Math.max(0, c - (parseInt(param, 10) || 1))
            else if (fin === 'K') {
              if (param === '2' || param === '') clearRow(r)
              else if (param === '1') for (let k = 0; k <= c; k++) cells[r][k] = ''
              else if (param === '0') for (let k = c; k < W; k++) cells[r][k] = ''
            } else if (fin === 'J') {
              if (param === '0' || param === '') for (let rr2 = r; rr2 < H; rr2++) clearRow(rr2)
              else if (param === '2' || param === '3') for (let rr2 = 0; rr2 < H; rr2++) clearRow(rr2)
            }
            i = j + 1
            continue
          }
          i += 2
          continue
        }
        if (ch === '\r') { c = 0; i++; continue }
        if (ch === '\n') { r = Math.min(H - 1, r + 1); c = 0; i++; continue }
        if (ch === '\b') { c = Math.max(0, c - 1); i++; continue }
        if (c < W) cells[r][c] = ch
        c++
        i++
      }
    },
    snapshot() { return this.cells.map((row) => row.join('')) },
  }
}

function renderRows(snap) {
  const clean = (s) => {
    let out = ''
    for (const ch of s) out += ch === '\u2800' ? '·' : ch
    return out.replace(/\s+$/, '')
  }
  return snap.map((line, i) => `${String(i + 1).padStart(2)}| ${clean(line)}`)
}

function decodeFrame(frame) {
  const rows = []
  if (!frame) return rows
  const re = /\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;1H|$)/g
  let m
  while ((m = re.exec(frame)) !== null) {
    const vis = m[2].replace(/\x1b\[[0-9;]*m/g, '')
    const braille = [...vis].filter((c) => c === '\u2800').length
    rows.push({ row: Number(m[1]), braille, text: vis.replace(/\u2800/g, '·').replace(/[\r\n]/g, '⏎').slice(0, 70) })
  }
  return rows
}

const screen = makeScreen()
const marks = []
let lastMark = 0
const snapAt = (label, upto) => {
  for (let i = lastMark; i < upto; i++) screen.apply(writes[i])
  lastMark = upto
  marks.push({ label, idx: upto, snap: screen.snapshot() })
}

{
  for (let i = 0; i < firstStatusEnd; i++) screen.apply(writes[i])
  marks.push({ label: 'firstStatus', idx: firstStatusEnd, snap: screen.snapshot() })
}
console.log('STATE settle:', state())
const endTail = writes.length
snapAt('tail', endTail)

// First PgUp straight from the tail-following state.
const p1 = writes.length
store.scrollPage(-1)
await pause(600)
const endP1 = writes.length
snapAt('PgUp', endP1)
console.log('STATE PgUp  :', state())

// PgDn back to the bottom.
store.scrollPage(1)
await pause(600)
const endP2 = writes.length
snapAt('PgDn', endP2)
console.log('STATE PgDn  :', state())

// PgUp again (stability).
store.scrollPage(-1)
await pause(600)
const endP3 = writes.length
snapAt('PgUp2', endP3)
console.log('STATE PgUp2 :', state())

// Walk 1-line steps up to the very top.
for (let step = 0; step < 60 && store.scroll > 0; step++) {
  const before = store.scroll
  store.scrollLines(-1)
  await pause(70)
  if (store.scroll === before) break
}
store.touch()
await pause(250)
snapAt('walkTop', writes.length)
console.log('STATE walkTop:', state())

// Inspect the RAW bytes of the PgUp frame around the blank rows: what SGR
// state precedes each erase (background the terminal will use for the blank).
{
  const fw = writes.slice(p1, endP1).filter((w) => /\x1b\[\d+;1H\x1b\[2K/.test(w))[0]
  if (fw) {
    console.log('RAW PgUp frame excerpt (rows 5-12, SGR visible):')
    const re = /\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;1H|$)/g
    let m
    while ((m = re.exec(fw)) !== null) {
      const row = Number(m[1])
      if (row < 5 || row > 12) continue
      const seg = m[2]
      const showsgr = seg.replace(/\x1b/g, '␛').slice(0, 120)
      console.log(`  row ${row}: ${JSON.stringify(showsgr)}`)
    }
  }
}

// While parked in the history window, a NEW message streams in at the tail:
// the window's rows must stay byte-identical (nothing reflows above).
store.scrollPage(-1) // ensure scroll=29 history window
await pause(200)
const before = JSON.stringify(marks.at(-1)?.snap ?? '')
{
  const start = writes.length
  store.append('user', '滚屏时新消息')
  await pause(80)
  store.streamText('这是滚动过程中追加的新回复，不应影响上方的窗口内容。\n\n第二段。')
  await pause(500)
  const frames = writes.slice(start).filter((w) => /\x1b\[\d+;1H\x1b\[2K/.test(w))
  const all = frames.map((f) => {
    const re = /\x1b\[(\d+);1H\x1b\[2K/g
    const rows = []
    let m
    while ((m = re.exec(f)) !== null) rows.push(Number(m[1]))
    return rows
  })
  console.log('STREAM-while-scrolled rewritten rows per frame:', JSON.stringify(all))
  console.log('STREAM-while-scrolled scroll state:', state())
  snapAt('streamAppend', writes.length)
}
const after = JSON.stringify(marks.find((m) => m.label === 'streamAppend')?.snap ?? '')
console.log('HISTORY WINDOW unchanged while streaming:', before === after)

// Decode the PgUp transition frames.
{
  const frames = writes.slice(p1, endP1).filter((w) => /\x1b\[\d+;1H\x1b\[2K/.test(w))
  console.log('DECODED PgUp frames:')
  frames.forEach((f, fi) => {
    console.log(` frame ${fi}:`)
    for (const r of decodeFrame(f)) console.log(`   row ${String(r.row).padStart(2)}: ${r.braille ? '[b] ' : ''}${JSON.stringify(r.text)}`)
  })
}
// Decode the last walk frame (top window).
{
  const fw = writes.slice(-8).filter((w) => /\x1b\[\d+;1H\x1b\[2K/.test(w)).at(-1)
  console.log('DECODED walkTop frame:')
  for (const r of decodeFrame(fw)) console.log(`   row ${String(r.row).padStart(2)}: ${r.braille ? '[b] ' : ''}${JSON.stringify(r.text)}`)
  console.log('ITEMS:', store.getItems().map((it) => `${it.kind}:${it.text.slice(0, 12)}`).join(' | '))
}

// Big jump: bottom -> top in one step; decode that frame's top rows.
store.scrollBottom()
await pause(120)
{
  const start = writes.length
  store.scrollTop()
  await pause(400)
  const frames = writes.slice(start).filter((w) => /\x1b\[\d+;1H\x1b\[2K/.test(w))
  const fw = frames.at(-1) ?? ''
  console.log('DECODED scrollTop frame (bottom->top):')
  for (const r of decodeFrame(fw)) console.log(`   row ${String(r.row).padStart(2)}: ${r.braille ? '[b] ' : ''}${JSON.stringify(r.text)}`)
  snapAt('scrollTop', writes.length)
  console.log('STATE scrollTop:', state())
}

app.unmount()

for (const m of marks) writeFileSync(`${OUT}/${m.label}.txt`, renderRows(m.snap).join('\n'))
console.log('Screens written to', OUT)
process.exit(0)

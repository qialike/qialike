/**
 * Headless reproduction of the /sessions dialog "two 'type to filter' lines"
 * defect. Renders the real App (conversation + sessions plugins applied) on a
 * fake 80x24 TTY, opens the sessions dialog, and snapshots/decodes frames
 * across the caret-blink toggle.
 */
import { Writable } from 'node:stream'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { patchInkFullScreen } from '../../apps/tui-bin/build.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const OUT = '/home/pipo/deepseek/.opencode-research/sessions'
mkdirSync(OUT, { recursive: true })

patchInkFullScreen(ROOT + 'node_modules')
const { render } = await import('ink')
const React = (await import('react')).default
const { App, store, tui } = await import('./src/index.tsx')
const conv = await import('./src/panels/conversation.tsx')
const sessions = await import('./src/sessions.tsx')
const fakeCtx = {
  get: (key) => (key === 'tuiStore' ? store : key === 'tui' ? tui : undefined),
}
conv.apply(fakeCtx)
sessions.apply(fakeCtx)

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
await pause(100)
store.setWorkspace('C:/deepseek')
store.setModelLabel('DeepSeek V4 Flash')

const now = Date.now()
const day = 86_400_000
const titles = [
  'how are you?','你是谁?','工作台内 deepseek-harness 仓库, 用 web_search/web_fetch 查 Mistral (deepseek)',
  '增加Models对话框提示间距','用 web_search/web_fetch 查 GitHub Copilot (claude)','用 web_search/web_fetch 查 Anthropic (claude)',
  '用 web_search/web_fetch 查 OpenAI (gpt)','计算1到10的和程序','用 web_search/web_fetch 查蚂蚁集群','用 web_search/web_fetch 查字节跳动',
  '用 web_search/web_fetch 查阿里云','用 web_search/web_fetch 查小米大','排查qialike与opencode供应商差异','Session load failure troubleshooting',
  "移除'type to filter'提示","终端执行qialike退出残留信息原因","分析qialike运行日志","deepseek-harness 供应商研究",
  'Models 对话框上下间距','修复 /sessions 过滤框双行','web 搜索与供应商对比','数据库迁移脚本','单元测试覆盖提升',
]
const fakes = titles.map((t, i) => ({
  id: 9000 + i,
  label: 'session ' + i,
  title: t,
  cwd: 'C:/deepseek',
  createdAt: now - Math.floor(i % 3 === 0 ? (i * 1.3) : (i * 0.7)) * day,
}))
store.openSessions(fakes)
await pause(250)
console.log('panel:', store.panel, 'filtered:', store.sessionsFiltered.length, 'rows:', store.rows)

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

const screen = makeScreen()
let mark = 0
const snapAt = async (label) => {
  for (let i = mark; i < writes.length; i++) screen.apply(writes[i])
  mark = writes.length
  const snap = screen.snapshot()
  writeFileSync(`${OUT}/${label}.txt`, snap.map((l, i) => `${String(i + 1).padStart(2)}| ${l.replace(/\s+$/, '')}`).join('\n'))
  const hits = []
  snap.forEach((l, i) => { if (l.includes('type to filter')) hits.push(i + 1) })
  console.log(`${label}: 'type to filter' at screen rows:`, hits.join(',') || '(none)')
  return snap
}

// multi-size sweep: reopen the dialog at each terminal size
for (const [W, H] of [[80, 24], [100, 30], [120, 40], [200, 50], [70, 16], [60, 20]]) {
  store.setSize(W, H)
  try { Object.defineProperty(process.stdout, 'columns', { value: W, configurable: true }) } catch {}
  try { Object.defineProperty(process.stdout, 'rows', { value: H, configurable: true }) } catch {}
  store.openSessions(fakes)
  await pause(200)
  // capture two frames across a blink toggle
  const a = writes.length
  await pause(560)
  const b = writes.length
  await pause(560)
  const c = writes.length
  for (let i = mark; i < a; i++) screen.apply(writes[i])
  mark = a
  const snapA = screen.snapshot(); let hits = []
  snapA.forEach((l, i) => { if (l.includes('type to filter')) hits.push(i + 1) })
  // cursor parks in the frames between a..c
  const parks = []
  for (let i = a; i < c; i++) {
    for (const m of writes[i].matchAll(/\x1b\[(\d+);(\d+)H/g)) {
      const row = Number(m[1]); const col = Number(m[2])
      if (row >= 1 && row <= H && !parks.some((p) => p.row === row && p.col === col)) parks.push({ row, col })
    }
  }
  for (let i = a; i < c; i++) screen.apply(writes[i])
  mark = c
  const snapB = screen.snapshot()
  const hitsB = []
  snapB.forEach((l, i) => { if (l.includes('type to filter')) hitsB.push(i + 1) })
  writeFileSync(`${OUT}/size-${W}x${H}.txt`, snapB.map((l, i) => `${String(i + 1).padStart(2)}| ${l.replace(/\s+$/, '')}`).join('\n'))
  console.log(`size ${W}x${H}: 'type to filter' rows=[${hits.join(',')}] after-blink rows=[${hitsB.join(',')}] cursor parks=${JSON.stringify(parks)}`)
  const frame = writes.slice(a, c).filter((w) => /\x1b\[\d+;1H\x1b\[2K/.test(w))
  console.log(`  frames in 2 blinks: ${frame.length}; per-frame row-ops: ${frame.map((f) => [...f.matchAll(/\x1b\[(\d+);1H/g)].map((m) => m[1]).join(',')).join(' | ')}`)
}
app.unmount()
console.log('total writes:', writes.length)
process.exit(0)

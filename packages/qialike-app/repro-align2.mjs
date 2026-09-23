import { Writable } from 'node:stream'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchInkFullScreen } from '../../apps/tui-bin/build.mjs'
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const OUT = process.env.REPRO_OUT ?? join(tmpdir(), 'qialike-repro', 'align')
mkdirSync(OUT, { recursive: true })
patchInkFullScreen(ROOT + 'node_modules')
const { render } = await import('ink')
const React = (await import('react')).default
const { App, store, tui } = await import('./src/index.tsx')
const conv = await import('./src/panels/conversation.tsx')
const question = await import('./src/panels/question.tsx')
const fakeCtx = { get: (k) => (k === 'tuiStore' ? store : k === 'tui' ? tui : undefined) }
conv.apply(fakeCtx); question.apply(fakeCtx)
const writes = []
class FakeStdout extends Writable { constructor(){ super(); this.columns=100; this.rows=40; this.isTTY=true } _write(c,e,cb){ writes.push(c.toString('utf8')); cb() } }
const fs2 = new FakeStdout()
store.setSize(100, 40)
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const app = render(React.createElement(App, { onSubmit:(t)=>{store.append('user',t)}, onCancel:()=>{}, onConnect:()=>{} }), { stdout: fs2, stdin: process.stdin, stderr: process.stderr, patchConsole: false })
await pause(100)
// a user message + assistant with a code block + list + long text
store.append('user', '用 Python 写一个从 3 到 20 的求和程序，并解释一下。')
await pause(60)
store.streamText('好的，用 Python 写：\n\n```python\n"""sum 3..20 (inclusive)."""\nstart = 3\nend = 20\ntotal = sum(range(start, end + 1))\nprint(f"from {start} to {end} = {total}")\n```\n\n验证：3+4+…+20 = (3+20)×18÷2 = 207（这是一个通用的求和程序，修改 start 和 end 就能算任意区间的和）。\n\n这是一段足够长的正文，用于观察代码块之外的段落是否也整齐地左对齐并在右侧留下四个字符宽度的空白区域。\n\n运行看看：\n\n```bash\npython3 sum_3_to_20.py   # 输出：从 3 到 20 的和是 207\n```')
await pause(400)
store.settleAssistantText('好的，用 Python 写：\n\n```python\n"""sum 3..20 (inclusive)."""\nstart = 3\nend = 20\ntotal = sum(range(start, end + 1))\nprint(f"from {start} to {end} = {total}")\n```\n\n验证：3+4+…+20 = (3+20)×18÷2 = 207（这是一个通用的求和程序，修改 start 和 end 就能算任意区间的和）。\n\n这是一段足够长的正文，用于观察代码块之外的段落是否也整齐地左对齐并在右侧留下四个字符宽度的空白区域。\n\n运行看看：\n\n```bash\npython3 sum_3_to_20.py   # 输出：从 3 到 20 的和是 207\n```')
await pause(500)
// reasoning (expanded) via a manual append? reasoning items come from streamReasoning
store.streamReasoning('The user asks if the program can be written in other languages. Let me offer a few common languages. This is a user-owned choice — I should ask which language they prefer. I will ask a question. Provide the options.')
await pause(500)
// question dock
store.setQuestion({ item: { id:'q1', question: '用哪种语言写这个求和程序？', options:[{label:'Python'},{label:'C++'},{label:'Rust'}], detail:'这是一个较长的细节说明，用来测试 question dock 的折行与左右留白是否与消息正文对齐。' }, resolve:()=>{}, reject:()=>{}, index:0, custom:'', customMode:false })
await pause(500)
app.unmount()
const W=100,H=40
const cells=Array.from({length:H},()=>Array(W).fill('')); let r=0,c=0
const clr=(row)=>{for(let i=0;i<W;i++)cells[row][i]=''}
function apply(s){let i=0;while(i<s.length){const ch=s[i]
 if(ch==='\x1b'){if(s[i+1]==='['){let j=i+2,param='';while(j<s.length&&!/[@-~]/.test(s[j])){param+=s[j];j++}const fin=s[j]
  if(fin==='H'||fin==='f'){const p=param.split(';').map(x=>parseInt(x,10));r=(p[0]||1)-1;c=(p[1]||1)-1;if(r>=H)r=H-1;if(c>=W)c=W-1}
  else if(fin==='A')r=Math.max(0,r-(parseInt(param,10)||1));else if(fin==='B')r=Math.min(H-1,r+(parseInt(param,10)||1))
  else if(fin==='C')c=Math.min(W-1,c+(parseInt(param,10)||1));else if(fin==='D')c=Math.max(0,c-(parseInt(param,10)||1))
  else if(fin==='K'){if(param==='2'||param==='')clr(r)}else if(fin==='J'){if(param==='0'||param==='')for(let y=r;y<H;y++)clr(y);else if(param==='2'||param==='3')for(let y=0;y<H;y++)clr(y)}
  i=j+1;continue}i+=2;continue}
 if(ch==='\r'){c=0;i++;continue}if(ch==='\n'){r=Math.min(H-1,r+1);c=0;i++;continue}if(ch==='\b'){c=Math.max(0,c-1);i++;continue}
 if(c<W)cells[r][c]=ch;c++;i++}}
for(const w of writes) apply(w)
let txt=''
for(let i=0;i<H;i++){const line=cells[i].join('').replace(/\s+$/,'');if(line.trim())txt+=String(i+1).padStart(2)+'| '+line+'\n'}
writeFileSync(OUT+'/align2.txt',txt)

function lastTextCol(row){const line=row.join('');const t=line.replace(/\s+$/,'');return t.length}

console.log('--- reasoning rows ---')
for(let i=0;i<40;i++){const line=cells[i].join(''); if(/Think|user asks|which language/.test(line)){const f=line.match(/[^ ]/); console.log(`row${i+1} L=${f?line.indexOf(f[0])+1:''} R=${line.replace(/\s+$/,'').length} :: ${line.trim().slice(0,55)}`)}}

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
conv.apply({ get: (k) => (k === 'tuiStore' ? store : k === 'tui' ? tui : undefined) })
const writes = []
class FakeStdout extends Writable {
  constructor(){ super(); this.columns=100; this.rows=30; this.isTTY=true }
  _write(c,e,cb){ writes.push(c.toString('utf8')); cb() }
}
const fs2 = new FakeStdout()
store.setSize(100, 30)
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const app = render(React.createElement(App, { onSubmit:(t)=>{store.append('user',t)}, onCancel:()=>{}, onConnect:()=>{} }), { stdout: fs2, stdin: process.stdin, stderr: process.stderr, patchConsole: false })
await pause(100)
store.append('user', '你能做什么？请具体介绍你的核心能力。')
await pause(80)
store.streamText('我可以做的事情很多：\n\n- 阅读和修改工作区内的文件\n- 运行命令并查看输出\n- 搜索代码与文档\n\n这里是一段特意加长到足以触发折行的正文内容，用来在多行折行时观察每一行是否都整齐地从同一个左列开始，以及最右侧是否统一留出了四个字符宽度的空白区域。这一段再补充一些文字，确保它必然超过可用的换行宽度，从而产生真正的多行折行效果。')
await pause(400)
store.settleAssistantText('我可以做的事情很多：\n\n- 阅读和修改工作区内的文件\n- 运行命令并查看输出\n- 搜索代码与文档\n\n这里是一段特意加长到足以触发折行的正文内容，用来在多行折行时观察每一行是否都整齐地从同一个左列开始，以及最右侧是否统一留出了四个字符宽度的空白区域。这一段再补充一些文字，确保它必然超过可用的换行宽度，从而产生真正的多行折行效果。')
await pause(600)
app.unmount()
const W=100,H=30
const cells=Array.from({length:H},()=>Array(W).fill(''))
let r=0,c=0
const clr=(row)=>{ for(let i=0;i<W;i++)cells[row][i]='' }
function apply(s){
  let i=0
  while(i<s.length){
    const ch=s[i]
    if(ch==='\x1b'){
      if(s[i+1]==='['){
        let j=i+2,param=''
        while(j<s.length && !/[@-~]/.test(s[j])){param+=s[j];j++}
        const fin=s[j]
        if(fin==='H'||fin==='f'){const p=param.split(';').map(x=>parseInt(x,10));r=(p[0]||1)-1;c=(p[1]||1)-1;if(r>=H)r=H-1;if(c>=W)c=W-1}
        else if(fin==='A')r=Math.max(0,r-(parseInt(param,10)||1))
        else if(fin==='B')r=Math.min(H-1,r+(parseInt(param,10)||1))
        else if(fin==='C')c=Math.min(W-1,c+(parseInt(param,10)||1))
        else if(fin==='D')c=Math.max(0,c-(parseInt(param,10)||1))
        else if(fin==='K'){ if(param==='2'||param==='') clr(r); else if(param==='1'){for(let k=0;k<=c;k++)cells[r][k]=''} else if(param==='0'){for(let k=c;k<W;k++)cells[r][k]=''} }
        else if(fin==='J'){ if(param==='0'||param===''){for(let y=r;y<H;y++)clr(y)} else if(param==='2'||param==='3'){for(let y=0;y<H;y++)clr(y)} }
        i=j+1; continue
      }
      i+=2; continue
    }
    if(ch==='\r'){c=0;i++;continue}
    if(ch==='\n'){r=Math.min(H-1,r+1);c=0;i++;continue}
    if(ch==='\b'){c=Math.max(0,c-1);i++;continue}
    if(c<W)cells[r][c]=ch
    c++; i++
  }
}
for(const w of writes) apply(w)
let txt=''
for(let i=0;i<H;i++){ const line=cells[i].join('').replace(/\s+$/,''); if(line.trim()) txt+=String(i+1).padStart(2)+'| '+line+'\n' }
writeFileSync(OUT+'/align.txt',txt)
// measure left/right columns of each text row
for(const row of cells){const line=row.join(''); const first=line.search(/\S/); const last=line.match(/\S\s*$/)? line.lastIndexOf(line.match(/\S[^\S]*$/)[0]):-1; if(first!==-1){ console.log(`L=${first+1} R=${last+1} :: ${line.trim().slice(0,40)}`) } }

console.log(txt)

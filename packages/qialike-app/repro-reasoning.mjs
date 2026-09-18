import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { patchInkFullScreen } from '../../apps/tui-bin/build.mjs'
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
patchInkFullScreen(ROOT + 'node_modules')
const { render } = await import('ink')
const React = (await import('react')).default
const { App, store, tui } = await import('./src/index.tsx')
const conv = await import('./src/panels/conversation.tsx')
conv.apply({ get: (k) => (k === 'tuiStore' ? store : k === 'tui' ? tui : undefined) })
const writes = []
class FakeStdout extends Writable { constructor(){ super(); this.columns=100; this.rows=40; this.isTTY=true } _write(c,e,cb){ writes.push(c.toString('utf8')); cb() } }
const fs2 = new FakeStdout(); store.setSize(100, 40)
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const app = render(React.createElement(App, { onSubmit:(t)=>{}, onCancel:()=>{}, onConnect:()=>{} }), { stdout: fs2, stdin: process.stdin, stderr: process.stderr, patchConsole: false })
await pause(100)
store.append('user', 'What can you do?')
await pause(60)
store.streamReasoning('The user asks "what can you do?" This is a general question about my capabilities. Let me answer conversationally, describing what I can do as a coding agent in this environment and how I can help.' )
store.setRunning(true)
await pause(250)
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
for(let i=0;i<H;i++){const line=cells[i].join('').replace(/\s+$/,''); if(line.trim()) console.log(`row${i+1}: L=${cells[i].join('').search(/\S/)+1} R=${line.length} :: ${line.slice(0,60)}`)}

// Multimodal serialization check for tui-llm: image blocks become OpenAI
// image_url parts and Anthropic base64 source blocks.
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { serializeMessagesOpenAI, serializeMessagesAnthropic } from '../packages/dsh-tui-app/src/llm.ts'

const fakeCtx = {
  get(name) {
    if (name === 'attachments') {
      return {
        readImageRequest: async () => ({ mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) }),
      }
    }
    return undefined
  },
}

const imageRef = { attachmentId: 'a1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
const user = createUserMessage({
  content: [
    { type: 'text', text: 'what is in this image?' },
    { type: 'image', attachment: imageRef },
  ],
  source: { kind: 'user' },
})

const failures = []

const wire = await serializeMessagesOpenAI(fakeCtx, [user], 'the system', undefined)
const sys = wire[0]
const userMsg = wire[1]
let ok = sys.role === 'system' && sys.content === 'the system'
console.log(`${ok ? 'PASS' : 'FAIL'}: OpenAI system message`)
if (!ok) failures.push('openai system')
ok = Array.isArray(userMsg.content)
  && userMsg.content[0].type === 'text'
  && userMsg.content[1].type === 'image_url'
  && userMsg.content[1].image_url.url === 'data:image/png;base64,AQID'
console.log(`${ok ? 'PASS' : 'FAIL'}: OpenAI user content parts (text + image_url base64)`)
if (!ok) failures.push('openai image parts')

const anth = await serializeMessagesAnthropic(fakeCtx, [user], 'the system', undefined)
ok = anth.systemText === 'the system'
  && anth.messages.length === 1
  && anth.messages[0].content[0].type === 'text'
  && anth.messages[0].content[1].type === 'image'
  && anth.messages[0].content[1].source.type === 'base64'
  && anth.messages[0].content[1].source.media_type === 'image/png'
  && anth.messages[0].content[1].source.data === 'AQID'
console.log(`${ok ? 'PASS' : 'FAIL'}: Anthropic user content blocks (text + image base64 source)`)
if (!ok) failures.push('anthropic image blocks')

// assistant tool-call round trip (Anthropic tool_use block)
const assistant = createAssistantMessage({
  content: [{ type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"cmd":"ls"}' }],
  provider: 'x',
  model: 'm',
})
const anth2 = await serializeMessagesAnthropic(fakeCtx, [assistant], undefined, undefined)
ok = anth2.messages[0].role === 'assistant'
  && anth2.messages[0].content[0].type === 'tool_use'
  && anth2.messages[0].content[0].name === 'bash'
  && JSON.stringify(anth2.messages[0].content[0].input) === '{"cmd":"ls"}'
console.log(`${ok ? 'PASS' : 'FAIL'}: Anthropic assistant tool_use block`)
if (!ok) failures.push('anthropic tool_use')

console.log()
if (failures.length > 0) {
  console.log('FAILURES:', failures)
  process.exit(1)
}
console.log('ALL PASS')

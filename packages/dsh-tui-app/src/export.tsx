/**
 * The export plugin (`tui-export`): the `/export` command — export a session
 * (current by default, or a given id) to a JSON transcript (machine-readable,
 * opencode's `export` shape) or a human-readable Markdown replay. Modeled on
 * opencode's `opencode export [sessionID] --sanitize`:
 *
 *   /export                     → open the export dialog (format / file name /
 *                                 sanitize), exporting the current session
 *   /export <sessionId>         → that session as JSON
 *   /export --markdown          → human-readable Markdown replay
 *   /export --sanitize          → redact message/file content ([redacted:…])
 *   /export --output <name>     → custom file name (extension added; may
 *                                 include subdirectories, e.g. notes/summary)
 *
 * Data comes from the harness persisted-session store (`inspect` returns the
 * immutable event log), folded into user/assistant/tool messages.
 *
 * @module @yourname/dsh-tui-app/export
 */

import { Box, Text } from 'ink'
import React from 'react'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TuiService, Store } from './index.tsx'
import { theme } from './theme.ts'
import type { RawKey } from './stdin.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-export'

/** The store service (see panels/conversation.tsx for the why-behind-the-seam). */
let store!: Store

/** The `tui` service (panel + command registration). */
export const inject = ['tui']

/** One exported message row. */
interface ExportMessage {
  role: 'user' | 'assistant' | 'tool'
  text?: string
  reasoning?: string
  name?: string
  input?: string
  output?: string
  error?: string
}

/** The exported document. */
interface ExportDoc {
  session: { id: string; cwd: string; exportedAt: string }
  messages: ExportMessage[]
}

/** Flatten text blocks from a harness message content (blocks array). */
function flattenText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content
    .filter((b): b is { type: string; text?: unknown } => b !== null && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('')
}

/** Flatten reasoning blocks from a harness message content. */
function flattenReasoning(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text?: unknown } => b !== null && typeof b === 'object' && (b as { type?: string }).type === 'reasoning')
    .map((b) => String(b.text ?? ''))
    .join('')
}

/** Flatten a tool-result message: its content is one `tool-result` block whose
 *  own `content` holds the text blocks. */
function flattenToolResult(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((b) => {
      if (b === null || typeof b !== 'object') return []
      const block = b as { type?: string; content?: unknown }
      if (block.type === 'tool-result') return flattenText(block.content)
      if (block.type === 'text') return [String((block as { text?: unknown }).text ?? '')]
      return []
    })
    .join('')
}

/** Fold the harness event log into user/assistant/tool messages (call/result
 *  paired by order — the single-agent loop executes tools sequentially). */
function foldEvents(events: readonly { type: string; data?: Record<string, unknown> }[]): ExportMessage[] {
  const out: ExportMessage[] = []
  const open: ExportMessage[] = []
  for (const event of events) {
    const data = event.data ?? {}
    switch (event.type) {
      case 'user/message': {
        // The event data IS the message (top-level content/source).
        out.push({ role: 'user', text: flattenText(data.content) })
        break
      }
      case 'assistant/message': {
        // assistant/message carries `{ turn, step, message }`; user/message's
        // data IS the message (top-level content/source).
        const message = data.message as { content?: unknown } | undefined
        out.push({
          role: 'assistant',
          text: flattenText(message?.content),
          reasoning: flattenReasoning(message?.content),
        })
        break
      }
      case 'tool/call': {
        const msg: ExportMessage = { role: 'tool', name: String(data.name ?? ''), input: String(data.arguments ?? '') }
        out.push(msg)
        open.push(msg)
        break
      }
      case 'tool/result': {
        const message = data.message as { content?: unknown } | undefined
        const msg = open.pop()
        const output = flattenToolResult(message?.content)
        if (msg !== undefined) msg.output = output
        else out.push({ role: 'tool', output })
        if (data.error !== undefined) {
          const target = msg ?? out[out.length - 1]
          if (target !== undefined) target.error = String((data.error as { message?: unknown })?.message ?? 'error')
        }
        break
      }
      default:
        break
    }
  }
  return out
}

/** Redact sensitive content while keeping the structure (opencode `--sanitize`). */
function sanitizeDoc(doc: ExportDoc): ExportDoc {
  let n = 0
  const redact = (value: string | undefined, kind: string): string | undefined =>
    value !== undefined && value.trim() !== '' ? `[redacted:${kind}:${n++}]` : value
  return {
    session: { ...doc.session, cwd: redact(doc.session.cwd, 'cwd') ?? '' },
    messages: doc.messages.map((m) => ({
      ...m,
      text: redact(m.text, 'text'),
      reasoning: redact(m.reasoning, 'reasoning'),
      name: redact(m.name, 'tool'),
      input: redact(m.input, 'tool-input'),
      output: redact(m.output, 'tool-output'),
    })),
  }
}

/** Render the document as a human-readable Markdown replay. */
function renderMarkdown(doc: ExportDoc, sanitize: boolean): string {
  const d = sanitize ? sanitizeDoc(doc) : doc
  const lines: string[] = [
    `# 会话导出 ${d.session.id}`,
    `工作区: ${d.session.cwd} · 导出时间: ${d.session.exportedAt}`,
    '',
  ]
  for (const m of d.messages) {
    if (m.role === 'user') {
      lines.push('## 👤 User', '', m.text ?? '', '')
    } else if (m.role === 'assistant') {
      lines.push('## 🤖 Assistant', '')
      if (m.reasoning !== undefined && m.reasoning !== '') {
        lines.push('> 思考', '>', `> ${m.reasoning.replace(/\n/g, '\n> ')}`, '')
      }
      if (m.text !== undefined && m.text !== '') lines.push(m.text, '')
    } else {
      lines.push(`## 🛠 Tool${m.name !== undefined ? ` · ${m.name}` : ''}`, '')
      if (m.input !== undefined && m.input !== '') {
        lines.push('```json', m.input, '```', '')
      }
      if (m.output !== undefined && m.output !== '') {
        lines.push('输出:', '', '```', m.output, '```', '')
      }
      if (m.error !== undefined) lines.push(`错误: ${m.error}`, '')
    }
  }
  return lines.join('\n')
}

/** Resolve the export destination under the workspace root, refusing any
 *  custom name whose resolved path escapes it (`../` segments, absolute
 *  paths). Subdirectory names inside the workspace are allowed (mkdir
 *  recursive covers them). Exported for the containment unit tests
 *  (fix 2, dsh-tui-security.md). */
export function resolveExportDestination(
  workspace: string,
  base: string,
  ext: string,
): { ok: true; file: string } | { ok: false; reason: string } {
  const root = resolve(workspace)
  const file = resolve(join(workspace, `${base}.${ext}`))
  const rel = relative(root, file)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: `path escapes workspace ("${base}")` }
  }
  return { ok: true, file }
}

/** One export run: inspect the session, fold, render, write to the workspace. */
function doExport(ctx: Context, sessionId: string, opts: { markdown: boolean; sanitize: boolean; output?: string }): void {
  const persistence = ctx.get('sessionPersistence') as {
    inspect?(id: SessionId, signal?: AbortSignal): Promise<{ events: readonly { type: string; data?: Record<string, unknown> }[] }>
  } | undefined
  if (persistence?.inspect === undefined) {
    store.append('status', 'export: service unavailable', true)
    return
  }
  void persistence.inspect(SessionId(sessionId)).then((inspection) => {
    const doc: ExportDoc = {
      session: { id: sessionId, cwd: store.workspace, exportedAt: new Date().toISOString() },
      messages: foldEvents(inspection.events),
    }
    const body = opts.markdown
      ? renderMarkdown(doc, opts.sanitize)
      : JSON.stringify(opts.sanitize ? sanitizeDoc(doc) : doc, null, 2)
    const ext = opts.markdown ? 'md' : 'json'
    // Export into the workspace root, under a custom name when supplied (may
    // include subdirectories); otherwise a timestamped default.
    const base = opts.output !== undefined && opts.output.trim() !== '' ? opts.output.trim() : `session-${sessionId.slice(-8)}`
    // Containment guard (fix 2, dsh-tui-security.md): `../`/absolute custom
    // names are refused before any write, so /export can never touch a file
    // outside the workspace root.
    const resolved = resolveExportDestination(store.workspace, base, ext)
    if (!resolved.ok) {
      store.append('status', `export: ${resolved.reason}`, true)
      return
    }
    const file = resolved.file
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, body, 'utf8')
    store.append('status', `export: ${file} (${doc.messages.length} messages)`, true)
  }).catch((error: unknown) => {
    store.append('status', `export failed: ${error instanceof Error ? error.message : String(error)}`, true)
  })
}

/** The `/export` dialog: format / file name / sanitize (opencode-style form). */
function ExportDialog(): React.JSX.Element {
  const [cursorOn, setCursorOn] = React.useState(true)
  React.useEffect(() => {
    const timer = setInterval(() => setCursorOn((on) => !on), 530)
    return () => clearInterval(timer)
  }, [])
  const block = <Text inverse={cursorOn}> </Text>
  const field0 = store.exportField === 0
  const field1 = store.exportField === 1
  const field2 = store.exportField === 2
  return (
    <Box flexDirection="column" height={store.rows} alignItems="center" justifyContent="center">
      <Box position="absolute" width="100%" height={store.rows} flexDirection="column">
        <Text backgroundColor={theme.bg} wrap="wrap">{' '.repeat(Math.max(0, store.width * store.rows))}</Text>
      </Box>
      <Box width={72} borderStyle="round" borderColor={theme.border} flexDirection="column" paddingX={1} paddingY={1}>
        <Text color={theme.accent} bold>Export session</Text>
        <Box marginBottom={1}>
          <Text dimColor>session: {String(store.session?.id ?? '')}</Text>
        </Box>
        <Text color={field0 ? theme.primary : undefined}>
          [ 1 ] format:{' '}
          {store.exportFormat === 'json' ? (
            <>
              <Text color={theme.accent}>[JSON]</Text>
              <Text dimColor> Markdown</Text>
            </>
          ) : (
            <>
              <Text dimColor>JSON </Text>
              <Text color={theme.accent}>[Markdown]</Text>
            </>
          )}
          {field0 ? block : null}
        </Text>
        <Text color={field1 ? theme.primary : undefined}>
          [ 2 ] file name: {store.exportName !== '' ? store.exportName : '(default)'}
          {field1 ? block : null}
        </Text>
        <Text color={field2 ? theme.primary : undefined}>
          [ 3 ] sanitize:{' '}
          {store.exportSanitize ? (
            <>
              <Text color={theme.accent}>[on]</Text>
              <Text dimColor> off</Text>
            </>
          ) : (
            <>
              <Text dimColor>on </Text>
              <Text color={theme.accent}>[off]</Text>
            </>
          )}
          {field2 ? block : null}
        </Text>
        <Box marginTop={1}>
          <Text dimColor>↑/↓ move · ←/→ toggle · j/m format · o/n sanitize · type file name · Enter export · Esc/right-click cancel</Text>
        </Box>
      </Box>
    </Box>
  )
}

/** Handle one key while the export panel is active. */
function exportKey(k: RawKey): void {
  const char = k.char ?? ''
  if (k.upArrow) { store.exportFieldMove(-1); return }
  if (k.downArrow) { store.exportFieldMove(1); return }
  if (k.leftArrow || k.rightArrow) {
    if (store.exportField === 0) store.exportFormatToggle()
    else if (store.exportField === 2) store.exportSanitizeToggle()
    return
  }
  if (k.return) {
    const sessionId = store.session?.id
    store.cancelExport()
    if (sessionId === undefined) {
      store.append('status', 'export: no session to export', true)
      return
    }
    doExport(ctxRef, String(sessionId), {
      markdown: store.exportFormat === 'markdown',
      sanitize: store.exportSanitize,
      output: store.exportName,
    })
    return
  }
  if (k.escape || k.mouseRightPress || (k.ctrl && char === 'c')) { store.cancelExport(); return }
  if (store.exportField === 0) {
    // Direct letter shortcuts: j → JSON, m → Markdown (←/→ still toggle).
    if (char === 'j' || char === 'J') { if (store.exportFormat !== 'json') store.exportFormatToggle(); return }
    if (char === 'm' || char === 'M') { if (store.exportFormat !== 'markdown') store.exportFormatToggle(); return }
    return
  }
  if (store.exportField === 2) {
    // Direct letter shortcuts: o → on, n → off (←/→ still toggle).
    if (char === 'o' || char === 'O') { if (!store.exportSanitize) store.exportSanitizeToggle(); return }
    if (char === 'n' || char === 'N') { if (store.exportSanitize) store.exportSanitizeToggle(); return }
    return
  }
  if (store.exportField === 1) {
    if (k.backspace || k.delete) store.exportNameBackspace()
    else if (char) store.exportNameType(char)
  }
}

/** The context captured at apply (for the dialog submit). */
let ctxRef: Context

/** Register the export (fullscreen) panel and the `/export` command. */
export function apply(ctx: Context): void {
  ctxRef = ctx
  store = ctx.get('tuiStore') as Store
  const tui = ctx.get('tui') as TuiService
  tui.panels.register({
    id: 'export',
    mode: 'fullscreen',
    render: () => <ExportDialog />,
    handleKey: (k) => { exportKey(k); return true },
  })
  tui.commands.register({
    name: 'export',
    hint: 'export the session (JSON/Markdown, sanitize)',
    run: (arg) => {
      // Bare `/export` opens the interactive dialog; flags go straight through.
      if (arg.trim() === '') {
        const sessionId = store.session?.id
        store.openExport(`session-${String(sessionId ?? '').slice(-8)}`)
        return
      }
      // Parse: `--markdown` / `--sanitize` / `--output <name>` / `-o <name>`,
      // plus an optional leading session id (first non-flag token).
      const tokens = arg.split(/\s+/).filter((t) => t !== '')
      const markdown = tokens.includes('--markdown')
      const sanitize = tokens.includes('--sanitize')
      let output: string | undefined
      const positional: string[] = []
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]
        if (token === '--output' || token === '-o') {
          output = tokens[i + 1]
          i++
        } else if (!token.startsWith('--')) {
          positional.push(token)
        }
      }
      const sessionId = positional[0] ?? store.session?.id
      if (sessionId === undefined) {
        store.append('status', 'export: no session to export', true)
        return
      }
      doExport(ctx, String(sessionId), { markdown, sanitize, output })
    },
  })
}

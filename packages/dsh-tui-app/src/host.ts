/**
 * P4c host mode: the same binary boots the embedded harness WITHOUT the Ink
 * surface and serves a session to a client over JSON Lines on stdio.
 *
 * Why this exists (see `dsh-tui-p4c-spike.md`): the harness decodes and
 * materializes a whole session on the calling thread — measured 10–11 s for a
 * 1.45 M-event log, plus 4–6 s request-assembly blocks during turns. In the
 * Ink client that work freezes the render thread (keyboard and mouse stop
 * answering). Running it in a child process keeps the frames flowing: the
 * client stays a renderer.
 *
 * Protocol (v0, M1 slice): requests carry `id` and are answered in order with
 * the same `id`. Only the read-only subset the M1 slice needs is implemented —
 * `attach` / `page` — plus `shutdown`; prompting, cancellation and the
 * approval/question waterfalls land in later milestones.
 *
 * @module dsh-tui-app/host
 */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { logErrorFileOnly } from './log.ts'

/** Messages the client sends. */
interface HostRequest {
  id?: number
  type: 'attach' | 'page' | 'shutdown'
  /** `attach`: explicit session id (absent = newest with content in the cwd). */
  sessionId?: string
  /** `page`: inclusive-exclusive event range. */
  from?: number
  to?: number
}

/** Minimal shape of the services the host needs from the harness. */
interface AgentsLike {
  create(options: unknown): Promise<AgentHandleLike>
  resume(options: unknown): Promise<AgentHandleLike>
}
interface AgentHandleLike {
  agent: {
    session: {
      id: string
      snapshotEvents(): readonly SessionEventLike[]
      requestHeader?(): { config?: { provider?: string; model?: string } } | undefined
    }
  }
  dispose(): Promise<void>
}
interface SessionEventLike {
  type: string
  seq: number
  time?: number
  data?: unknown
}
interface PersistenceLike {
  list?(signal?: AbortSignal): Promise<Array<{ id: string; cwd?: string; createdAt?: number }>>
}

/** One line writer: the protocol owns stdout, so nothing else may print there. */
function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/**
 * Run the host loop until stdin closes or a `shutdown` request arrives.
 * @param ctx - booted harness context (base + host-side plugins mounted).
 * @param config - workspace and optional explicit session id.
 * @returns a promise that settles when the loop ends.
 */
export async function startHost(
  ctx: Context,
  config: { workspace: string; resume: string | undefined; model: string | undefined },
): Promise<void> {
  const agents = ctx.get('agents') as unknown as AgentsLike | undefined
  const persistence = ctx.get('sessionPersistence') as unknown as PersistenceLike | undefined
  const defaultModel = ctx.get('agentDefaultModel') as unknown as
    | { currentSelection(): ModelSelection | undefined }
    | undefined
  if (agents === undefined || defaultModel === undefined) {
    send({ type: 'error', code: 'not-ready', message: 'agents/agentDefaultModel service missing' })
    return
  }
  const selection: ModelSelection | undefined = defaultModel.currentSelection()
  if (selection === undefined) {
    send({ type: 'error', code: 'no-model', message: 'agentDefaultModel has no selection' })
    return
  }
  const selected: ModelSelectionRef = { current: selection, assembled: undefined }
  const setup = (agentCtx: Context): void => { installModelSelection(agentCtx, selected) }
  const agentOptions = config.model === undefined
    ? { provider: selection.provider, model: selection.model }
    : { provider: selection.provider, model: config.model }

  let handle: AgentHandleLike | undefined
  /** The client's page cache is the handle's snapshot; fetched per `page`. */
  const snapshot = (): readonly SessionEventLike[] => handle?.agent.session.snapshotEvents() ?? []

  const pickSessionId = async (): Promise<string | undefined> => {
    if (config.resume !== undefined) return config.resume
    try {
      const list = await persistence?.list?.() ?? []
      const here = list.filter((h) => h.cwd === config.workspace)
      const newest = here.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]
      return newest?.id
    } catch {
      return undefined
    }
  }

  const attach = async (requestId: number | undefined, explicit?: string): Promise<void> => {
    const wanted = explicit ?? await pickSessionId()
    if (wanted === undefined) {
      send({ type: 'error', code: 'no-session', message: 'no session to attach in this workspace' })
      return
    }
    const t0 = Date.now()
    logErrorFileOnly('host', `attach: resuming ${wanted}`)
    handle = await agents.resume({ resumeSessionId: wanted as SessionId, agentOptions, setup })
    logErrorFileOnly('host', `attach: resumed in ${Date.now() - t0}ms events=${snapshot().length}`)
    // The decode+attach happened HERE — on the host's thread, which is the
    // whole point: the client was free to keep painting while this ran.
    send({
      id: requestId,
      type: 'attached',
      sessionId: wanted,
      title: sessionTitle(),
      eventCount: snapshot().length,
      openMs: Date.now() - t0,
      workspace: config.workspace,
    })
  }

  /** The session's last `session/title` value, straight from the materialized
   *  log (the host already holds it, so this is a cheap backward scan — and it
   *  keeps the client from having to decode the log for a title). */
  const sessionTitle = (): string | undefined => {
    const events = snapshot()
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!
      if (event.type === 'session/title') {
        const title = (event.data as { title?: unknown } | undefined)?.title
        if (typeof title === 'string' && title.trim() !== '') return title
      }
    }
    return undefined
  }

  const page = (requestId: number | undefined, from: number, to: number): void => {
    const events = snapshot()
    const start = Math.max(0, Math.min(from, events.length))
    const end = Math.max(start, Math.min(to, events.length))
    send({ id: requestId, type: 'page', from: start, to: end, events: events.slice(start, end) })
  }

  let closing = false
  const shutdown = async (): Promise<void> => {
    if (closing) return
    closing = true
    try { await handle?.dispose() } catch (error) { logErrorFileOnly('host', error) }
    send({ type: 'bye' })
    // The loader keeps the event loop alive; exit explicitly (same reasoning as
    // the TUI's own shutdown path).
    setTimeout(() => process.exit(0), 10)
  }

  const dispatch = (line: string): void => {
    if (process.env.DSH_TUI_HOST_TRACE === '1') logErrorFileOnly('host', `request: ${line.slice(0, 120)}`)
    let request: HostRequest
    try {
      request = JSON.parse(line) as HostRequest
    } catch {
      send({ type: 'error', code: 'bad-json', message: 'request was not JSON' })
      return
    }
    void (async (): Promise<void> => {
      try {
        switch (request.type) {
          case 'attach': await attach(request.id, request.sessionId); break
          case 'page': page(request.id, request.from ?? 0, request.to ?? Number.MAX_SAFE_INTEGER); break
          case 'shutdown': await shutdown(); break
          default: send({ id: request.id, type: 'error', code: 'unknown-request', message: String(request.type) })
        }
      } catch (error) {
        send({
          id: request.id,
          type: 'error',
          code: 'request-failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  }

  send({
    type: 'ready',
    profile: 'tui-host',
    workspace: config.workspace,
    model: `${selection.provider}/${selection.model}`,
    pid: process.pid,
  })
  logErrorFileOnly('host', `ready workspace=${config.workspace} model=${selection.provider}/${selection.model}`)

  // Line-delimited stdin loop (no readline: the protocol owns the stream, and a
  // partial line must survive across chunks).
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const nl = buffer.indexOf('\n')
      if (nl < 0) break
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line !== '') dispatch(line)
    }
  })
  process.stdin.on('end', () => { void shutdown() })
  process.stdin.resume()
  await new Promise<void>(() => { /* the loop ends via shutdown/exit */ })
}

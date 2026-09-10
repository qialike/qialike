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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { planResumeFold } from './resume-fold.ts'
import { readOnlyBashDecision, type SandboxMode } from './bash-policy.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { logErrorFileOnly } from './log.ts'

/** Messages the client sends. */
interface HostRequest {
  id?: number
  type: 'attach' | 'page' | 'prompt' | 'cancel' | 'shutdown' | 'answer' | 'policy'
  /** `prompt`: the user message's content blocks, sent as plain JSON. */
  blocks?: unknown[]
  /** `attach`: explicit session id (absent = newest with content in the cwd). */
  sessionId?: string
  /** `page`: inclusive-exclusive event range. */
  from?: number
  to?: number
  /** `answer`: which ask this settles (the id from the host's `ask`). */
  requestId?: number
  /** `answer`: the kind-specific answer payload. */
  payload?: Record<string, unknown>
  /** `policy`: the sandbox mode the client's status bar shows. */
  permission?: string
}

/** The two host-side waterfalls that need the CLIENT's Ink dialogs. */
type AskKind = 'approval' | 'question'

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

/** Clamp a sandbox-mode string from the wire. An unrecognized mode fails CLOSED
 *  (`read-only`): over-enforcing is recoverable, a silently weaker fence is not
 *  — and a mismatch with the chip the client draws is a protocol bug either way,
 *  so it is logged loudly. */
function normalizePermission(value: string | undefined): SandboxMode {
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') return value
  logErrorFileOnly('host', `unknown sandbox mode from client: ${String(value)}`)
  return 'read-only'
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
  let forwarding = false
  const eventQueue: Record<string, unknown>[] = []
  let eventTimer: ReturnType<typeof setTimeout> | undefined
  /** The client's page cache is the handle's snapshot; fetched per `page`. */
  const snapshot = (): readonly SessionEventLike[] => handle?.agent.session.snapshotEvents() ?? []

  // ── The three waterfalls (P4c M3) ────────────────────────────────────────
  // The harness calls these on the thread that owns the session — this one. The
  // DIALOGS live in the client, so an approval or a user question blocks this
  // turn while the answer travels back over stdio. The third waterfall
  // (`tools/pre-execute`) is pure policy and is NOT bridged: the client mirrors
  // its sandbox mode down (`policy`) and this process applies the very same
  // rule from `bash-policy.ts`, so a tool execution never waits on the client's
  // render loop.
  let permission: SandboxMode = 'workspace-write'
  let permissionFromClient = false
  let askSerial = 0
  /** Pending asks keyed by the id sent to the client; the value settles it. */
  const pendingAsks = new Map<number, (answer: Record<string, unknown> | undefined) => void>()

  /**
   * Ask the client and wait for its answer. The ask is withdrawn — and the
   * waiter settled — when the harness aborts the request (its own timeout) or
   * after a last-resort timeout, so the turn can never hang on a dead client.
   * @param kind - which waterfall is asking.
   * @param payload - JSON-only payload the client's dialog renders.
   * @param signal - the harness's abort signal for this request, when it has one.
   * @returns the client's answer payload, or `undefined` when it was withdrawn.
   */
  const ask = (kind: AskKind, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> => {
    const requestId = ++askSerial
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (answer: Record<string, unknown> | undefined): void => {
        if (!pendingAsks.delete(requestId)) return
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', withdraw)
        resolve(answer)
      }
      const withdraw = (): void => {
        send({ type: 'ask-cancelled', requestId })
        finish(undefined)
      }
      if (signal?.aborted === true) {
        send({ type: 'ask-cancelled', requestId })
        resolve(undefined)
        return
      }
      if (signal !== undefined) {
        timer = setTimeout(withdraw, 5 * 60_000)
        signal.addEventListener('abort', withdraw, { once: true })
      }
      pendingAsks.set(requestId, finish)
      send({ type: 'ask', requestId, kind, payload })
    })
  }

  /** Claim this session's approvals and user questions for the client. */
  const registerWaterfalls = (wanted: string): void => {
    ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
      if (req.agent?.session.id !== wanted) return next()
      const answer = await ask('approval', { toolName: req.toolName, reason: req.reason })
      const outcome = answer?.outcome
      return outcome === 'allowed-once' || outcome === 'rejected' ? outcome : 'cancelled'
    })
    ctx.on('user-questions/request', async (request, next) => {
      if (request.agent !== undefined && request.agent.session.id !== wanted) return next()
      const answer = await ask('question', { questions: request.questions })
      // Parity with the in-process answerer: an unanswered (withdrawn) ask is a
      // rejection, which the tool surfaces as a cancelled `ask_user_question`.
      if (answer === undefined) throw new Error('ask_user_question was cancelled')
      return { answers: (answer.answers ?? []) as Array<{ id: string; selected: string[]; custom?: string }> }
    })
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      return readOnlyBashDecision(exec, permission) ?? next()
    })
  }

  /** Apply the client's mirrored sandbox mode to the session this host owns.
   *  The write is a durable `sandbox/mode` event, so it only ever happens for a
   *  mode the user really chose (Tab in the composer) — never for the default,
   *  which would append an event to the log on every launch. */
  const applyPermission = (mode: SandboxMode): void => {
    permission = mode
    permissionFromClient = true
    const session = handle?.agent.session as unknown as Session | undefined
    if (session === undefined) return
    try { setSandboxMode(session, mode) } catch (error) { logErrorFileOnly('host', error) }
  }

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
    // Forward this session's live events to the client, batched (~50 ms) so a
    // streaming turn does not become one message per delta. The client feeds
    // them into the same listener the in-process path uses.
    if (!forwarding) {
      forwarding = true
      registerWaterfalls(wanted)
      // `agent/status` is a SERVICE event, not a session event: without it the
      // client never learns the turn is running (so Esc-to-cancel and the busy
      // indicator would stay dead). Forward it verbatim.
      // NOTE: forward only the STATUS. `payload.agent` is the live Agent object
      // (circular, huge) — JSON.stringify on it throws, which silently killed
      // this handler before (the client never learned the turn was running, so
      // Esc-to-cancel stayed dead).
      ctx.on('agent/status', (payload: { agent: { id: string }; status: 'idle' | 'running' }) => {
        if (payload.agent.id !== wanted) return
        send({ type: 'agent-status', status: payload.status })
      })
      ctx.on('session/event', (session, event) => {
        if (session.id !== wanted) return
        eventQueue.push(event as unknown as Record<string, unknown>)
        if (eventTimer === undefined) {
          eventTimer = setTimeout(() => {
            eventTimer = undefined
            if (eventQueue.length === 0) return
            const batch = eventQueue.splice(0, eventQueue.length)
            send({ type: 'events', batch })
          }, 50)
        }
      })
    }
    const t0 = Date.now()
    logErrorFileOnly('host', `attach: resuming ${wanted}`)
    handle = await agents.resume({ resumeSessionId: wanted as SessionId, agentOptions, setup })
    logErrorFileOnly('host', `attach: resumed in ${Date.now() - t0}ms events=${snapshot().length}`)
    // A mode the client already chose (Tab pressed while this session was still
    // decoding) belongs to the session, so replay/consumers see it too.
    if (permissionFromClient) applyPermission(permission)
    // The decode+attach happened HERE — on the host's thread, which is the
    // whole point: the client was free to keep painting while this ran.
    // The fold PLAN is computed here, where the whole log already lives: the
    // client then folds exactly these ranges (safe turn boundaries included) and
    // never needs the events it is not showing.
    const plan = planResumeFold(snapshot())
    send({
      id: requestId,
      type: 'attached',
      sessionId: wanted,
      title: sessionTitle(),
      plan,
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

  /** Prompt = the client's `agent.followup`; the harness queues it exactly as
   *  in-process (approval/question waterfalls are NOT bridged yet — M3 — so a
   *  host-side claim would fail closed with `next()`). */
  const prompt = (requestId: number | undefined, blocks: readonly unknown[] | undefined): void => {
    if (handle === undefined) {
      send({ id: requestId, type: 'error', code: 'not-attached', message: 'attach first' })
      return
    }
    const content = (blocks ?? []) as ContentBlock[]
    const agent = handle.agent as unknown as { followup(message: unknown): void }
    agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
    send({ id: requestId, type: 'accepted' })
  }

  /** Cancellation: the harness's ordinary user cancel (keeps queued inbox work). */
  const cancel = (requestId: number | undefined): void => {
    if (handle === undefined) {
      send({ id: requestId, type: 'error', code: 'not-attached', message: 'attach first' })
      return
    }
    const agent = handle.agent as unknown as { cancel?(reason: unknown, options: unknown): void }
    try { agent.cancel?.({ kind: 'user' }, { keepInbox: true }) } catch (error) { logErrorFileOnly('host', error) }
    send({ id: requestId, type: 'accepted' })
  }

  /** The client's answer to a pending ask; a late answer for a withdrawn ask is
   *  dropped here (the harness's own "late answer is discarded" rule). */
  const answer = (requestId: number | undefined, payload: Record<string, unknown> | undefined): void => {
    if (requestId === undefined) return
    const settle = pendingAsks.get(requestId)
    if (settle === undefined) {
      if (process.env.DSH_TUI_HOST_TRACE === '1') logErrorFileOnly('host', `answer for unknown ask #${requestId}`)
      return
    }
    settle(payload ?? {})
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
          case 'prompt': prompt(request.id, request.blocks); break
          case 'cancel': cancel(request.id); break
          case 'answer': answer(request.requestId, request.payload); break
          case 'policy': applyPermission(normalizePermission(request.permission)); break
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

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
import { findReusableBlank, foldSessionBlank, type SessionHeaderLike, type SessionTitlesPersistence } from './session-titles.ts'
import { lastSandboxMode, readOnlyBashDecision, type SandboxMode } from './bash-policy.ts'
import { ManualCompactionError, type CompactionResult, type ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction'
import { GoalError } from '@deepseek-ai/dsh-goal'
import type { HostCommand, HostCommandResult } from './host-command.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { logErrorFileOnly } from './log.ts'
import { join } from 'node:path'
import { sessionDir } from './session-files.ts'

/** Messages the client sends. */
interface HostRequest {
  id?: number
  type: 'attach' | 'page' | 'prompt' | 'cancel' | 'shutdown' | 'answer' | 'policy' | 'new'
    | 'model' | 'compact' | 'abort-compact' | 'command' | 'target'
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
  /** `model`: the selection the client's `/models` dialog applied. */
  selection?: { provider: string; model: string; reasoningEffort?: string }
  /** `command`: one `/goal` or `/plan` seam call. */
  command?: HostCommand
}

/** The two host-side waterfalls that need the CLIENT's Ink dialogs. */
type AskKind = 'approval' | 'question'

/** Minimal shape of the services the host needs from the harness. */
interface AgentsLike {
  create(options: unknown): Promise<AgentHandleLike>
  resume(options: unknown): Promise<AgentHandleLike>
}
interface PersistenceListLike {
  list?(signal?: AbortSignal): Promise<Array<{ id: string; cwd?: string; createdAt?: number }>>
  inspect?(id: string, signal?: AbortSignal): Promise<{ events: readonly unknown[] }>
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
interface PersistenceLike extends PersistenceListLike {}

/** The durable log path for a session under THIS host's harness home. */
function logPathFor(sessionId: string): string | undefined {
  try {
    return join(sessionDir(process.cwd(), sessionId as SessionId), 'session.jsonl.zstd')
  } catch {
    return undefined
  }
}

/** Set once the client is gone: writes are pointless and stdout's error event
 *  must not turn a normal exit into a crash. */
let clientGone = false

/**
 * One line writer: the protocol owns stdout, so nothing else may print there.
 *
 * A client that exits (or is killed) leaves us with a broken pipe, and a write to
 * it surfaces asynchronously as an `error` event on stdout — with no listener that
 * becomes an `uncaughtException`, so EVERY client exit used to dump an EPIPE stack
 * into the shared log and exit the child with code 1. Losing the client means there
 * is nobody left to serve: note it once and stop.
 * @param message - the protocol message to write.
 */
function send(message: Record<string, unknown>): void {
  if (clientGone) return
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  } catch (error) {
    noteClientGone(error)
  }
}

/** The client's pipe is broken: nothing left to serve, so exit quietly. */
function noteClientGone(error: unknown): void {
  if (clientGone) return
  clientGone = true
  logErrorFileOnly('host', `client gone (${error instanceof Error ? error.message : String(error)}) — exiting`)
  setTimeout(() => process.exit(0), 10)
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
  const sessions = ctx.get('sessions') as unknown as
    | { flush?(session: Session): Promise<void> }
    | undefined
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
  /** The ONE session this host serves right now — mutable: `attach` with
   *  another id (or `new`) switches sessions in place, which is what keeps the
   *  client's `/sessions` and `/new` working once the session lives here. */
  let current: string | undefined
  let listenersReady = false
  const eventQueue: Record<string, unknown>[] = []
  let eventTimer: ReturnType<typeof setTimeout> | undefined
  /** The client's page cache is the handle's snapshot; fetched per `page`. */
  const snapshot = (): readonly SessionEventLike[] => handle?.agent.session.snapshotEvents() ?? []

  /** Drop the pending event batch: it belongs to the session being replaced, and
   *  the client would attribute it to the NEW one (the batches carry no id of
   *  their own — `send` adds it). */
  const dropPendingEvents = (): void => {
    eventQueue.length = 0
    if (eventTimer !== undefined) {
      clearTimeout(eventTimer)
      eventTimer = undefined
    }
  }

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

  /** Claim this session's approvals and user questions for the client.
   *
   *  Registered ONCE per process: every handler reads the mutable `current`
   *  session id, so switching sessions (`attach` with another id, or `new`) only
   *  has to re-point that variable — a late event from the session we left is
   *  dropped by the id check, and its pending approval can never be answered on
   *  the wrong session. */
  const registerWaterfalls = (): void => {
    ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
      if (req.agent?.session.id !== current) return next()
      const answer = await ask('approval', { toolName: req.toolName, reason: req.reason })
      const outcome = answer?.outcome
      return outcome === 'allowed-once' || outcome === 'rejected' ? outcome : 'cancelled'
    })
    ctx.on('user-questions/request', async (request, next) => {
      if (request.agent !== undefined && request.agent.session.id !== current) return next()
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

  /** Register everything session-scoped ONCE (handlers read `current`). */
  const registerListeners = (): void => {
    if (listenersReady) return
    listenersReady = true
    registerForwarding()
    registerWaterfalls()
  }

  /**
   * Release the session we serve, before acquiring the next one: the harness
   * runtime owns exactly one live agent per id and refuses a second resume of it,
   * so acquire must follow release.
   *
   * The order is the harness's own teardown recipe (cancel → whenIdle → flush →
   * dispose) and it matters: the durable log is written WRITE-BEHIND, and once
   * `dispose()` has run the session is no longer live in the store, so a flush
   * would throw `session "<id>" is not live in this store` and the tail of the
   * log could be lost. Flushing first is what makes switching safe.
   */
  const disposeCurrent = async (): Promise<void> => {
    const previous = handle
    handle = undefined
    if (previous === undefined) return
    const agent = previous.agent as unknown as {
      session: Session
      cancel?(reason: unknown, options: unknown): void
      whenIdle?(): Promise<void>
    }
    // A compaction belongs to the session we are leaving: abort it first (the
    // harness's maintenance task holds the agent otherwise).
    compactAbort?.abort()
    try { agent.cancel?.({ kind: 'user' }, { keepInbox: true }) } catch { /* best-effort */ }
    try { await agent.whenIdle?.() } catch { /* best-effort */ }
    try { await sessions?.flush?.(agent.session) } catch (error) { logErrorFileOnly('host', error) }
    try { await previous.dispose() } catch (error) { logErrorFileOnly('host', error) }
  }

  /**
   * `/goal` and `/plan`: run one seam call on the agent this host owns.
   *
   * Both services reject anything that is not the live agent, so the work cannot
   * happen in the client; the client keeps the grammar and the wording and sends
   * one semantic operation per call. Rejections come back CLASSIFIED
   * (`GoalError` code) so the client's existing copy mapping stays in one place.
   * @param requestId - protocol id to answer.
   * @param command - the operation to perform.
   */
  const runCommand = (requestId: number | undefined, command: HostCommand | undefined): void => {
    const fail = (code: string, message: string): void => {
      send({ id: requestId, type: 'command-result', result: { error: { code, message } } })
    }
    if (command === undefined) {
      fail('bad-command', 'missing command')
      return
    }
    const agent = handle?.agent
    if (agent === undefined) {
      fail('no-agent', 'no session is attached')
      return
    }
    try {
      const result: Record<string, unknown> = {}
      if (command.kind === 'goal') {
        const goals = ctx.get('goals') as unknown as {
          get(agent: unknown): unknown
          create(agent: unknown, input: { objective: string }): unknown
          edit(agent: unknown, ref: unknown, input: { objective: string }): unknown
          pause(agent: unknown, ref: unknown): unknown
          resume(agent: unknown, ref: unknown): unknown
          clear(agent: unknown, ref: unknown): void
        }
        switch (command.op) {
          case 'get': result.goal = goals.get(agent); break
          case 'create': result.goal = goals.create(agent, { objective: command.objective }); break
          case 'edit': result.goal = goals.edit(agent, command.ref, { objective: command.objective ?? '' }); break
          case 'pause': result.goal = goals.pause(agent, command.ref); break
          case 'resume': result.goal = goals.resume(agent, command.ref); break
          case 'clear': goals.clear(agent, command.ref); break
        }
      } else {
        const planMode = ctx.get('planMode') as unknown as {
          get(agent: unknown): { active: boolean }
          set(agent: unknown, active: boolean): string
        }
        if (command.op === 'get') {
          result.active = planMode.get(agent).active
        } else {
          result.outcome = planMode.set(agent, command.active)
          if (command.message !== undefined && command.message !== '') {
            // `/plan <message>` also steers the text into the session — the host
            // owns the real agent, so the client ships the text instead of
            // calling `agent.steer` on its (session-less) shim.
            const steer = (agent as unknown as { steer?(message: unknown): void }).steer
            steer?.call(agent, createUserMessage({
              content: [{ type: 'text', text: command.message }],
              source: { kind: 'user' },
            }))
          }
        }
      }
      send({ id: requestId, type: 'command-result', result: result as HostCommandResult })
    } catch (error) {
      const code = error instanceof GoalError ? error.code : 'failed'
      fail(code, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * `/models`: switch THIS agent's route for its next request.
   *
   * The harness has no `agent.setModel`; the supported in-memory path is the
   * selection ref the per-agent `setup` installed (`installModelSelection`), read
   * again by every prompt assembly — mutating it is exactly what the in-process
   * client does. Before this, the client's dialog only changed its OWN copy, so
   * the status bar and the model actually used could disagree.
   * @param requestId - protocol id to answer.
   * @param selection - the provider/model/effort triple the dialog applied.
   */
  const setModel = (requestId: number | undefined, selection: HostRequest['selection']): void => {
    if (selection === undefined || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
      send({ id: requestId, type: 'error', code: 'bad-model', message: 'model selection must be {provider, model}' })
      return
    }
    selected.current = selection as ModelSelection
    // Persist the default HERE as well: in host mode the client's profile may not
    // mount `agentDefaultModel` at all (M4.4), so the child that owns the harness
    // is the one that can write the settings section future launches read.
    try {
      void (ctx.get('agentDefaultModel') as unknown as { saveSelection?(next: ModelSelection): Promise<void> } | undefined)
        ?.saveSelection?.(selection as ModelSelection)
    } catch (error) { logErrorFileOnly('host', error) }
    logErrorFileOnly('host',
      `model: ${selection.provider}/${selection.model}${selection.reasoningEffort === undefined ? '' : ` (${selection.reasoningEffort})`}`)
    send({ id: requestId, type: 'accepted' })
  }

  /** The in-flight manual compaction, so Esc can abort it and a session switch
   *  can never leave one running against a session we no longer serve. */
  let compactAbort: AbortController | undefined

  /**
   * `/compact`: run the harness's manual compaction on the LIVE agent here.
   *
   * It must be this process: `compactNow` needs `runMaintenance`, which only the
   * owner of the live agent has (the client's agent shim has neither). Progress
   * is durable session events (`compaction/start|summary|end`), which already
   * stream to the client through the ordinary event forwarding — so the status
   * bar and the checkpoint row light up exactly as in-process.
   * @param requestId - protocol id to answer.
   */
  const startCompact = async (requestId: number | undefined): Promise<void> => {
    if (handle === undefined) {
      send({ id: requestId, type: 'error', code: 'not-attached', message: 'attach first' })
      return
    }
    const engine = ctx.get('compaction') as unknown as
      | { compactNow?(agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId: string): Promise<CompactionResult | null> }
      | undefined
    if (engine?.compactNow === undefined) {
      send({ id: requestId, type: 'compacted', failed: { code: 'unavailable', message: 'compaction service unavailable' } })
      return
    }
    if (compactAbort !== undefined) {
      send({ id: requestId, type: 'compacted', failed: { code: 'busy', message: 'a compaction is already running' } })
      return
    }
    const controller = new AbortController()
    compactAbort = controller
    const agent = handle.agent as unknown as ManualCompactAgentContext
    try {
      const result = await engine.compactNow(agent, controller.signal, `tui-${crypto.randomUUID()}`)
      send({
        id: requestId,
        type: 'compacted',
        result: result === null
          ? null
          : { items: result.shadowedSeqs.length, tokens: result.shadowedTokenCount, summarySeq: result.summarySeq },
      })
    } catch (error) {
      send({
        id: requestId,
        type: 'compacted',
        failed: {
          code: error instanceof ManualCompactionError ? error.code : 'failed',
          message: error instanceof Error ? error.message : String(error),
          cancelled: controller.signal.aborted,
        },
      })
    } finally {
      compactAbort = undefined
    }
  }

  /** Esc during `/compact`: the harness's own cancellation signal is the only
   *  way out of a long summary. */
  const abortCompact = (): void => { compactAbort?.abort() }

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

  /** Register the stream forwarding ONCE (the handlers read `current`). Events
   *  are batched (~50 ms) so a streaming turn does not become one message per
   *  delta; the client feeds them into the same listener the in-process path
   *  uses. Each batch carries the session id so a switch can never make the
   *  client mis-attribute a straggler. */
  const registerForwarding = (): void => {
    // `agent/status` is a SERVICE event, not a session event: without it the
    // client never learns the turn is running (so Esc-to-cancel and the busy
    // indicator would stay dead). Forward it verbatim.
    // NOTE: forward only the STATUS. `payload.agent` is the live Agent object
    // (circular, huge) — JSON.stringify on it throws, which silently killed
    // this handler before (the client never learned the turn was running, so
    // Esc-to-cancel stayed dead).
    ctx.on('agent/status', (payload: { agent: { id: string }; status: 'idle' | 'running' }) => {
      if (payload.agent.id !== current) return
      send({ type: 'agent-status', status: payload.status })
    })
    ctx.on('session/event', (session, event) => {
      if (session.id !== current) return
      eventQueue.push(event as unknown as Record<string, unknown>)
      if (eventTimer === undefined) {
        eventTimer = setTimeout(() => {
          eventTimer = undefined
          if (eventQueue.length === 0) return
          const sessionId = current
          const batch = eventQueue.splice(0, eventQueue.length)
          send({ type: 'events', sessionId, batch })
        }, 50)
      }
    })
  }

  /**
   * Serve one session: resume it here, re-point every listener, and hand the
   * client the fold plan it should render.
   *
   * Called for the first attach AND for every switch (`/sessions`, `/new`): the
   * handle we already hold is disposed first, so the client's `/sessions` no
   * longer tears the host down (that was the pre-M4 behaviour, where the client
   * resumed the session locally and dropped this process).
   * @param requestId - protocol id to answer, when the client is waiting.
   * @param explicit - the session to serve; absent = the newest with content in
   *   this workspace (or `--resume`).
   */
  const attach = async (requestId: number | undefined, explicit?: string): Promise<void> => {
    const wanted = explicit ?? await pickSessionId()
    if (wanted === undefined) {
      // MUST carry the request id: an id-less error settles nothing, so the
      // client's `attach` promise hangs and the caller stays in its loading state
      // (which suppresses keys) until the process is killed.
      send({ id: requestId, type: 'error', code: 'no-session', message: 'no session to attach in this workspace' })
      return
    }
    registerListeners()
    dropPendingEvents()
    await disposeCurrent()
    const t0 = Date.now()
    logErrorFileOnly('host', `attach: resuming ${wanted}`)
    const next = await agents.resume({ resumeSessionId: wanted as SessionId, agentOptions, setup })
    logErrorFileOnly('host', `attach: resumed in ${Date.now() - t0}ms events=${next.agent.session.snapshotEvents().length}`)
    finishAttach(next, wanted, requestId, t0)
  }

  /**
   * `/new`: start a brand-new session in place (or adopt an unused blank one, so
   * empty sessions cannot pile up — the same rule the client applies in-process).
   *
   * Doing this HERE is what keeps `/new` working in host mode: the client used to
   * create the session in its own (local) harness and hand the shim to the UI,
   * which silently cut the host loose from the session on screen.
   * @param requestId - protocol id to answer.
   */
  const startNew = async (requestId: number | undefined): Promise<void> => {
    if (handle !== undefined && foldSessionBlank(snapshot())) {
      // Already on an unused session: say so instead of minting another blank
      // (the client prints its own "already on a new session" notice).
      send({ id: requestId, type: 'new-session', sessionId: current, alreadyBlank: true })
      return
    }
    registerListeners()
    dropPendingEvents()
    await disposeCurrent()
    const t0 = Date.now()
    let wanted: string | undefined
    try {
      const headers = await persistence?.list?.() ?? []
      const reused = await findReusableBlank(
        persistence as unknown as SessionTitlesPersistence,
        headers as unknown as readonly SessionHeaderLike[],
        config.workspace,
        current as SessionId | undefined,
      )
      wanted = reused === undefined ? undefined : String(reused)
    } catch (error) {
      logErrorFileOnly('host', error)
    }
    const next = wanted === undefined
      ? await agents.create({
        sessionId: SessionId(`session-${crypto.randomUUID()}`),
        meta: { cwd: config.workspace },
        agentOptions,
        setup,
      })
      : await agents.resume({ resumeSessionId: wanted as SessionId, agentOptions, setup })
    // A brand-new log carries no `sandbox/mode` of its own; without this stamp
    // the client's chip (the mirrored mode) and the harness's own file boundary
    // would disagree until the next Tab — the chip would claim `read-only` while
    // writes still went through.
    try { setSandboxMode(next.agent.session as unknown as Session, permission) } catch (error) { logErrorFileOnly('host', error) }
    logErrorFileOnly('host', `new: serving ${next.agent.session.id} (${wanted === undefined ? 'created' : 'reused blank'})`)
    finishAttach(next, next.agent.session.id, requestId, t0)
  }

  /** Answer an attach/new with the fold plan the client should render. */
  const finishAttach = (
    next: AgentHandleLike,
    wanted: string,
    requestId: number | undefined,
    t0: number,
  ): void => {
    handle = next
    current = wanted
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
      sandboxMode: sessionSandboxMode(),
      blank: sessionBlank(),
      plan,
      eventCount: snapshot().length,
      openMs: Date.now() - t0,
      workspace: config.workspace,
    })
  }

  /**
   * Which session will this host serve, and where is its log?
   *
   * Answered BEFORE any resume, so a client can render that session from the log
   * file itself (P4c M6: a seekable frame read costs ~30 ms for a tail window
   * instead of the ~12 s a full materialization takes). The path comes from the
   * host because the host owns the harness-home resolution.
   * @param requestId - protocol id to answer.
   */
  const target = async (requestId: number | undefined): Promise<void> => {
    const wanted = current ?? config.resume ?? await pickSessionId()
    if (wanted === undefined) {
      send({ id: requestId, type: 'error', code: 'no-session', message: 'no session to attach in this workspace' })
      return
    }
    send({ id: requestId, type: 'target', sessionId: wanted, cwd: config.workspace, logPath: logPathFor(wanted) })
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

  /** The session's DURABLE sandbox mode, so the client's chip shows what the
   *  session actually enforces instead of resetting to the default on every
   *  launch (the shared rule that also fences bash). */
  /** Whether this session never ran a turn (the client's hero/"New Session"
   *  rule). The host owns the whole log, so it is the authoritative source: the
   *  client only ever holds a WINDOW of a giant session, where "no turn/start in
   *  what I have" would be a wrong answer. */
  const sessionBlank = (): boolean => foldSessionBlank(snapshot())

  const sessionSandboxMode = (): SandboxMode | undefined => lastSandboxMode(snapshot())

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
          case 'new': await startNew(request.id); break
          case 'model': setModel(request.id, request.selection); break
          case 'compact': await startCompact(request.id); break
          case 'abort-compact': abortCompact(); break
          case 'command': runCommand(request.id, request.command); break
          case 'target': await target(request.id); break
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

  // Listen for a broken stdout BEFORE the first write: the failure arrives as an
  // event, not as a throw (see `send`).
  process.stdout.on('error', noteClientGone)
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

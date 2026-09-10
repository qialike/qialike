/**
 * Client side of P4c host mode: spawn `dsh-tui --dsh-host` and drive it over
 * JSON Lines on stdio.
 *
 * The point is isolation, not speed: the host owns the session decode and the
 * harness's synchronous work, so the Ink render thread keeps producing frames
 * while a giant session opens (see `dsh-tui-p4c-spike.md`, M1 slice).
 *
 * @module dsh-tui-app/host-client
 */

import { logErrorFileOnly } from './log.ts'
import type { HostCommand, HostCommandResult } from './host-command.ts'

/** The Bun global is not in the typecheck project's lib set; declare only the
 *  spawn surface this module uses (the build bundles Bun's real implementation). */
interface SpawnedProcess {
  stdin: { write(data: string): void; flush?(): Promise<void> | void }
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  kill(): void
}
declare const Bun: {
  spawn(command: string[], options: {
    cwd?: string
    env?: Record<string, string | undefined>
    stdin?: 'pipe'
    stdout?: 'pipe'
    stderr?: 'pipe'
  }): SpawnedProcess
}

/** One durable event, as the host sends it (shape is the harness's). */
export interface HostEvent {
  type: string
  seq: number
  time?: number
  data?: unknown
}

/** The host's answer to `attach`/`new`: the session it now serves plus the fold
 *  plan the client should render. */
export interface HostAttached {
  type: 'attached'
  sessionId: string
  title?: string
  /** The session's durable `sandbox/mode` (what the harness enforces), so the
   *  chip shows reality instead of a fresh default. */
  sandboxMode?: string
  /** Whether the session never ran a turn — the hero/"New Session" rule. The host
   *  answers it because only the host holds the whole log (the client holds a
   *  window of a giant session). */
  blank?: boolean
  eventCount: number
  openMs: number
  /** The host's OWN chunked fold plan (portable: mode/tailStart/olderRanges). */
  plan?: { mode: 'fast' } | { mode: 'chunked'; tailStart: number; olderRanges: ReadonlyArray<readonly [number, number]> }
}

/** The host's answer to `new` when the current session is already unused. */
export interface HostAlreadyBlank {
  type: 'new-session'
  sessionId: string
  alreadyBlank: true
}

/** The host's answer to `compact`. */
export interface CompactionOutcome {
  /** `null` = nothing compactable; absent when the run failed. */
  result?: { items: number; tokens: number; summarySeq?: number } | null
  /** A classified failure (`ManualCompactionError` code, or our own). */
  failed?: { code: string; message: string; cancelled?: boolean }
}

/** What the client needs from a host handle. */
export interface HostClient {
  /** Resolves once the host reports `ready`. */
  ready: Promise<{ model?: string; pid?: number }>
  /** Serve a session: the first attach, or a SWITCH when an id is given (the
   *  host disposes the session it was serving). Absent id = the newest with
   *  content in the workspace. */
  attach(sessionId?: string): Promise<HostAttached>
  /** `/new`: the host creates (or adopts an unused blank) session and serves it. */
  newSession(): Promise<HostAttached | HostAlreadyBlank>
  /** `/models`: switch the route of the agent the host owns (next request). */
  setModel(selection: { provider: string; model: string; reasoningEffort?: string }): Promise<void>
  /** `/compact`: run the harness's manual compaction where the live agent is. */
  compact(): Promise<CompactionOutcome>
  /** Esc during `/compact`: abort it through the harness's own signal. */
  abortCompact(): void
  /** Which session will the host serve, and where is its log? Answered before
   *  any resume, so the client can render it from the file itself (M6). */
  target(): Promise<{ sessionId: string; cwd: string; logPath?: string }>
  /** One `/goal` or `/plan` seam call on the agent the host owns. */
  command(command: HostCommand): Promise<HostCommandResult>
  /** Fetch `[from, to)` of the durable event log. */
  page(from: number, to: number): Promise<HostEvent[]>
  /** Submit a user message (the host's `agent.followup`). */
  prompt(blocks: readonly unknown[]): Promise<void>
  /** Cancel the running turn (the host's `agent.cancel`). */
  cancel(): Promise<void>
  /** Subscribe to the host's live `session/event` batches. `sessionId` lets the
   *  client drop a straggler from a session it just switched away from. */
  onEvents(handler: (batch: HostEvent[], sessionId?: string) => void): void
  /** Subscribe to the host's turn-status beats (`agent/status`). */
  onStatus(handler: (status: 'idle' | 'running') => void): void
  /** Subscribe to host-side asks (approvals, user questions) this process must
   *  answer; the host's turn blocks until `answer` is sent. */
  onAsk(handler: (ask: HostAsk) => void): void
  /** The host withdrew an ask (its request aborted or timed out): close the
   *  dialog that ask opened. */
  onAskCancelled(handler: (requestId: number) => void): void
  /** Answer a pending ask (fire and forget: the host sends no reply). */
  answer(requestId: number, payload: Record<string, unknown>): void
  /** Mirror the sandbox mode this client shows: the host enforces the
   *  `read-only` bash fence with the SAME rule (`bash-policy.ts`). */
  setPolicy(permission: string): void
  /** The host process ended (crash or shutdown): the session on screen is now
   *  orphaned, which the client must say out loud. */
  onExit(handler: (reason: string) => void): void
  /** Ask the host to dispose and exit. */
  close(): void
}

/** An ask the host raised and is waiting on. */
export interface HostAsk {
  /** Correlation id echoed back with the answer. */
  requestId: number
  /** `approval` = tool approval dock; `question` = `ask_user_question` dock. */
  kind: 'approval' | 'question'
  /** Kind-specific payload (JSON only — it crossed the wire). */
  payload: Record<string, unknown>
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** Spawn a host and return a promise-based client.
 *  @param options - workspace, optional explicit session id, and the tail size
 *    the caller will request afterwards.
 *  @returns the connected client (its `ready` promise settles first). */
export function spawnHostClient(options: { workspace: string; resume?: string; model?: string }): HostClient {
  const args = ['--dsh-host', '--workspace', options.workspace]
  if (options.resume !== undefined) args.push('--resume', options.resume)
  // `--model` must reach the host too: it overrides the deployment default for
  // the agent the HOST builds, which is the one that actually serves requests.
  if (options.model !== undefined) args.push('--model', options.model)
  const child: SpawnedProcess = Bun.spawn([process.execPath, ...args], {
    cwd: options.workspace,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, DSH_TUI_HOST_CHILD: '1' },
  })

  let buffer = ''
  let nextId = 1
  const pending = new Map<number, Pending>()
  const eventHandlers = new Set<(batch: HostEvent[], sessionId?: string) => void>()
  const statusHandlers = new Set<(status: 'idle' | 'running') => void>()
  const askHandlers = new Set<(ask: HostAsk) => void>()
  const askCancelledHandlers = new Set<(requestId: number) => void>()
  const exitHandlers = new Set<(reason: string) => void>()
  let readyResolve: ((value: { model?: string; pid?: number }) => void) | undefined
  let readyReject: ((error: Error) => void) | undefined
  const ready = new Promise<{ model?: string; pid?: number }>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })

  const settle = (id: number | undefined, value: unknown, error?: string): void => {
    if (id === undefined) return
    const entry = pending.get(id)
    if (entry === undefined) return
    pending.delete(id)
    if (error === undefined) entry.resolve(value)
    else entry.reject(new Error(error))
  }

  const handleLine = (line: string): void => {
    let message: { type?: string; id?: number; code?: string; message?: string } & Record<string, unknown>
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      logErrorFileOnly('host', `unparsable host line: ${line.slice(0, 200)}`)
      return
    }
    if (process.env.DSH_TUI_HOST_TRACE === '1') logErrorFileOnly('host', `recv: ${line.slice(0, 90)}`)
    switch (message.type) {
      case 'ready':
        readyResolve?.({ model: message.model as string | undefined, pid: message.pid as number | undefined })
        readyResolve = undefined
        logErrorFileOnly('host', `ready pid=${String(message.pid)} model=${String(message.model)}`)
        return
      case 'attached':
      case 'new-session':
        settle(message.id, message)
        return
      case 'page':
        settle(message.id, message.events)
        return
      case 'events':
        for (const handler of eventHandlers) {
          handler((message.batch ?? []) as HostEvent[], message.sessionId as string | undefined)
        }
        return
      case 'agent-status': {
        const status = message.status as 'idle' | 'running' | undefined
        if (status !== undefined) for (const handler of statusHandlers) handler(status)
        return
      }
      case 'ask': {
        const ask: HostAsk = {
          requestId: Number(message.requestId),
          kind: message.kind === 'question' ? 'question' : 'approval',
          payload: (message.payload ?? {}) as Record<string, unknown>,
        }
        if (process.env.DSH_TUI_HOST_TRACE === '1') {
          logErrorFileOnly('host', `ask #${String(ask.requestId)} ${ask.kind}: ${JSON.stringify(ask.payload).slice(0, 120)}`)
        }
        for (const handler of askHandlers) handler(ask)
        return
      }
      case 'ask-cancelled': {
        const requestId = Number(message.requestId)
        for (const handler of askCancelledHandlers) handler(requestId)
        return
      }
      case 'accepted':
        settle(message.id, undefined)
        return
      case 'compacted':
        settle(message.id, message as CompactionOutcome)
        return
      case 'target':
        settle(message.id, message)
        return
      case 'command-result':
        settle(message.id, message.result as HostCommandResult)
        return
      case 'bye':
        settle(message.id, undefined)
        return
      case 'error':
        if (message.id === undefined) {
          // A protocol-level failure before any request: fail `ready` so the
          // caller does not wait forever.
          readyReject?.(new Error(String(message.message)))
          readyReject = undefined
          logErrorFileOnly('host', `host error (${String(message.code)}): ${String(message.message)}`)
          return
        }
        settle(message.id, undefined, String(message.message))
        return
      default:
        logErrorFileOnly('host', `unknown host message: ${line.slice(0, 200)}`)
    }
  }

  void (async (): Promise<void> => {
    const stdout = child.stdout
    const decoder = new TextDecoder()
    for await (const chunk of stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      for (;;) {
        const nl = buffer.indexOf('\n')
        if (nl < 0) break
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line !== '') handleLine(line)
      }
    }
    // stdout closed: the host exited. Fail anything still in flight.
    const error = new Error('host exited')
    for (const [, entry] of pending) entry.reject(error)
    pending.clear()
    readyReject?.(error)
    for (const handler of exitHandlers) handler(error.message)
  })()

  // Host logs ride stderr and are ALREADY in the shared log file (the host
  // writes them itself, tagged `[host]`): only forward what our logger did not
  // produce, so a panic or boot noise is visible without duplicating lines.
  const forwardHostStderr = (line: string): void => {
    const trimmed = line.trim()
    if (trimmed === '') return
    if (/^\[\d{4}-\d{2}-\d{2}T/.test(trimmed)) return // our logger already wrote it
    logErrorFileOnly('host', trimmed)
  }
  void (async (): Promise<void> => {
    const stderr = child.stderr
    const decoder = new TextDecoder()
    let tail = ''
    for await (const chunk of stderr) {
      tail += decoder.decode(chunk, { stream: true })
      const lines = tail.split('\n')
      tail = lines.pop() ?? ''
      for (const line of lines) forwardHostStderr(line)
    }
    forwardHostStderr(tail)
  })()

  /** Fire-and-forget write: the host answers some messages (`answer`, `policy`)
   *  with nothing at all, so they must not allocate a pending entry that would
   *  only ever time out. */
  const write = (message: Record<string, unknown>): void => {
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`)
      void child.stdin.flush?.()
    } catch (error) {
      logErrorFileOnly('host', `write failed (${String(message.type)}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function request<T>(message: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`host request ${String(message.type)} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const wrapped = pending.get(id)!
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); wrapped.resolve(value) },
        reject: (error) => { clearTimeout(timer); wrapped.reject(error) },
      })
      try {
        if (process.env.DSH_TUI_HOST_TRACE === '1') logErrorFileOnly('host', `send: ${JSON.stringify({ id, ...message }).slice(0, 90)}`)
        child.stdin.write(`${JSON.stringify({ id, ...message })}\n`)
        void child.stdin.flush?.()
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  return {
    ready,
    attach: (sessionId?: string) => request<HostAttached>(
      sessionId === undefined ? { type: 'attach' } : { type: 'attach', sessionId },
    ) as Promise<HostAttached>,
    newSession: () => request<HostAttached | HostAlreadyBlank>({ type: 'new' }),
    setModel: (selection) => request<void>({ type: 'model', selection }, 20_000),
    compact: () => request<CompactionOutcome>({ type: 'compact' }, 10 * 60_000),
    abortCompact: () => { write({ type: 'abort-compact' }) },
    command: (command) => request<HostCommandResult>({ type: 'command', command }, 30_000),
    target: () => request<{ sessionId: string; cwd: string; logPath?: string }>({ type: 'target' }, 30_000),
    page: (from: number, to: number) => request<HostEvent[]>({ type: 'page', from, to }),
    prompt: (blocks: readonly unknown[]) => request<void>({ type: 'prompt', blocks }),
    cancel: () => request<void>({ type: 'cancel' }),
      onEvents: (handler: (batch: HostEvent[], sessionId?: string) => void) => { eventHandlers.add(handler) },
    onStatus: (handler: (status: 'idle' | 'running') => void) => { statusHandlers.add(handler) },
    onAsk: (handler: (ask: HostAsk) => void) => { askHandlers.add(handler) },
    onAskCancelled: (handler: (requestId: number) => void) => { askCancelledHandlers.add(handler) },
    onExit: (handler: (reason: string) => void) => { exitHandlers.add(handler) },
    answer: (requestId: number, payload: Record<string, unknown>) => {
      write({ type: 'answer', requestId, payload })
    },
    setPolicy: (permission: string) => { write({ type: 'policy', permission }) },
    close: () => {
      try { child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`) } catch { /* best-effort */ }
      setTimeout(() => { try { child.kill() } catch { /* already gone */ } }, 500)
    },
  }
}

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

/** What the client needs from a host handle. */
export interface HostClient {
  /** Resolves once the host reports `ready`. */
  ready: Promise<{ model?: string; pid?: number }>
  /** Attach a session (explicit id, else the host picks the newest here). */
  attach(sessionId?: string): Promise<{ sessionId: string; title?: string; eventCount: number; openMs: number }>
  /** Fetch `[from, to)` of the durable event log. */
  page(from: number, to: number): Promise<HostEvent[]>
  /** Submit a user message (the host's `agent.followup`). */
  prompt(blocks: readonly unknown[]): Promise<void>
  /** Cancel the running turn (the host's `agent.cancel`). */
  cancel(): Promise<void>
  /** Subscribe to the host's live `session/event` batches. */
  onEvents(handler: (batch: HostEvent[]) => void): void
  /** Subscribe to the host's turn-status beats (`agent/status`). */
  onStatus(handler: (status: 'idle' | 'running') => void): void
  /** Ask the host to dispose and exit. */
  close(): void
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** Spawn a host and return a promise-based client.
 *  @param options - workspace, optional explicit session id, and the tail size
 *    the caller will request afterwards.
 *  @returns the connected client (its `ready` promise settles first). */
export function spawnHostClient(options: { workspace: string; resume?: string }): HostClient {
  const args = ['--dsh-host', '--workspace', options.workspace]
  if (options.resume !== undefined) args.push('--resume', options.resume)
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
  const eventHandlers = new Set<(batch: HostEvent[]) => void>()
  const statusHandlers = new Set<(status: 'idle' | 'running') => void>()
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
        settle(message.id, message)
        return
      case 'page':
        settle(message.id, message.events)
        return
      case 'events':
        for (const handler of eventHandlers) handler((message.batch ?? []) as HostEvent[])
        return
      case 'agent-status': {
        const status = message.status as 'idle' | 'running' | undefined
        if (status !== undefined) for (const handler of statusHandlers) handler(status)
        return
      }
      case 'accepted':
        settle(message.id, undefined)
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
    attach: (sessionId?: string) => request<{ sessionId: string; title?: string; eventCount: number; openMs: number }>(
      sessionId === undefined ? { type: 'attach' } : { type: 'attach', sessionId },
    ),
    page: (from: number, to: number) => request<HostEvent[]>({ type: 'page', from, to }),
    prompt: (blocks: readonly unknown[]) => request<void>({ type: 'prompt', blocks }),
    cancel: () => request<void>({ type: 'cancel' }),
    onEvents: (handler: (batch: HostEvent[]) => void) => { eventHandlers.add(handler) },
    onStatus: (handler: (status: 'idle' | 'running') => void) => { statusHandlers.add(handler) },
    close: () => {
      try { child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`) } catch { /* best-effort */ }
      setTimeout(() => { try { child.kill() } catch { /* already gone */ } }, 500)
    },
  }
}

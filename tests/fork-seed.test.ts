/**
 * Tests for `/fork` seed construction (fork-seed.ts).
 *
 * The load-bearing test is EQUIVALENCE: the child's derived transcript must be
 * exactly the parent's model-visible history. It is checked against the
 * harness's own fold — a real `SessionStore` session is built from the synthetic
 * parent log, a real second session is built from the seed our builder produces,
 * and the two `deriveMessages()` results are compared. That also proves the seed
 * passes the harness's seed boundary (`assertSessionEventEnvelope` +
 * `SurfaceManager.validateNext` + the store's own header rules) instead of
 * asserting a shape we made up.
 *
 * Run with `bun test tests/fork-seed.test.ts`.
 *
 * @module dsh-tui/fork-seed-test
 */

import { describe, expect, test } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { buildForkSeed, describeForkSeed, ForkUnavailableError, type ForkSeedSourceEvent } from '../packages/dsh-tui-app/src/fork-seed.ts'

/** One user message payload (the harness's `UserMessage`). */
const userMessage = (id: string, text: string): Record<string, unknown> => ({
  id,
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text }],
})

/** One assistant message payload, wrapped in the event's `{turn, step, message}`. */
const assistantMessage = (id: string, text: string, turn: number, step: number): Record<string, unknown> => ({
  turn,
  step,
  message: {
    id,
    role: 'assistant',
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    content: [{ type: 'text', text }],
  },
})

/** One tool result payload. */
const toolResult = (id: string, callId: string, text: string, turn: number, step: number): Record<string, unknown> => ({
  turn,
  step,
  message: {
    id,
    role: 'user',
    source: { kind: 'tool', callId },
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
  },
})

/** A request header payload with a distinguishing model. */
const requestHeader = (model: string): Record<string, unknown> => ({
  header: { config: { provider: 'deepseek-official', model } },
  reason: 'resume',
})

/** How the synthetic parent log ends. */
type Tail = 'closed' | 'pendingPrompt' | 'pendingProgress'

interface FixtureOptions {
  /** Write a compaction checkpoint (default true) or leave the log uncompacted. */
  compact?: boolean
  /** What the tail looks like: a completed turn, an unanswered prompt, or a
   *  half-finished answer to one. */
  tail?: Tail
}

/**
 * The synthetic parent log: every awkward case the builder must survive is in
 * here — a compaction checkpoint deep in the log, a tool-result PRUNER
 * replacement after it, an open turn at the tail, log-only state events that
 * must be carried (last value only), and events that must NOT be carried.
 */
function parentFixture(options: FixtureOptions = {}): SessionEvent[] {
  const { compact = true, tail = 'pendingPrompt' } = options
  const events: Array<Record<string, unknown>> = []
  const push = (type: string, data: unknown, extra: Record<string, unknown> = {}): number => {
    const seq = events.length
    events.push({ type, seq, time: 1000 + seq, data, ...extra })
    return seq
  }

  push('turn/start', { turn: 1 })
  push('user/message', userMessage('u1', 'first question'), { surfaceOp: 'append' })
  push('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text', text: 'fir' } })
  push('assistant/message', assistantMessage('a1', 'first answer', 1, 1), { surfaceOp: 'append', sourceEventSeqs: [2] })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })

  push('session/title', { title: 'parent title' })
  push('request/header', requestHeader('model-OLD'))
  push('turn/start', { turn: 2 })
  push('user/message', userMessage('u2', 'second question'), { surfaceOp: 'append' })
  push('assistant/message', assistantMessage('a2', 'second answer', 2, 1), { surfaceOp: 'append' })
  push('turn/end', { turn: 2, reason: { kind: 'completed' } })

  if (compact) {
    // The checkpoint replaces surface nodes 1..9 (every node so far).
    push('compaction/start', { compactionId: 'c1', shadowedSeqs: [1, 3, 8, 9] })
    push('compaction/summary', { compactionId: 'c1', summary: 'condensed' })
    push('user/message', userMessage('ckpt', 'COMPACTED SUMMARY of turns 1-2'), {
      surfaceOp: { op: 'replace', start: 1, end: 9 },
      // Must cite the start event, the summary event, and EVERY shadowed node.
      sourceEventSeqs: [11, 12, 1, 3, 8, 9],
    })
    push('compaction/end', { compactionId: 'c1' })
  }

  push('request/header', requestHeader('model-NEW'))
  push('sandbox/mode', { mode: 'read-only' })
  push('permission/preset', { preset: 'read-only' })
  push('approval/policy', { policy: 'never' })

  push('turn/start', { turn: 3 })
  push('user/message', userMessage('u3', 'third question'), { surfaceOp: 'append' })
  push('assistant/message', assistantMessage('a3', 'third answer', 3, 1), { surfaceOp: 'append' })
  const bigResult = push('tool/result', toolResult('t3', 'call_3', 'HUGE OUTPUT '.repeat(50), 3, 1), { surfaceOp: 'append' })
  push('turn/end', { turn: 3, reason: { kind: 'completed' } })

  push('turn/start', { turn: 4 })
  push('user/message', userMessage('u4', 'fourth question'), { surfaceOp: 'append' })
  push('assistant/message', assistantMessage('a4', 'fourth answer', 4, 1), { surfaceOp: 'append' })
  // The tool-result PRUNER: replaces the node IN PLACE and may change only content.
  push('tool/result', toolResult('t3', 'call_3', 'pruned', 3, 1), {
    surfaceOp: { op: 'replace', start: bigResult, end: bigResult },
    sourceEventSeqs: [bigResult],
  })
  push('turn/end', { turn: 4, reason: { kind: 'completed' } })

  // State events: only the LAST of each survives.
  push('plan/mode', { mode: 'plan' })
  push('todo/write', { todos: [{ id: '1', text: 'old todo', status: 'pending' }] })
  push('todo/write', { todos: [{ id: '1', text: 'current todo', status: 'completed' }] })
  push('goal/change', { goal: { id: 'g1', objective: 'carry me over' } })

  // Must NOT be carried: pending input, its splice, chunks, title.
  push('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [userMessage('p1', 'pending input')] })

  if (tail !== 'closed') {
    push('turn/start', { turn: 5 })
    push('user/message', userMessage('u5', 'in-flight question'), { surfaceOp: 'append' })
    if (tail === 'pendingProgress') {
      push('assistant/message', assistantMessage('a5', 'half an answer', 5, 1), { surfaceOp: 'append' })
      push('tool/result', toolResult('t5', 'call_5', 'half a result', 5, 1), { surfaceOp: 'append' })
    }
    push('step/start', { turn: 5, step: 1 })
  }

  return events as unknown as SessionEvent[]
}

/** One live session built from a seed, through the harness's own store. */
function liveSession(events: readonly SessionEvent[], id: string): Session {
  return new SessionStore(new Context()).create(SessionId(id), { seed: events, meta: { cwd: '/tmp' } })
}

/** The text of one content block, digging through tool-result nesting. */
function blockText(block: { type?: string; text?: string; content?: unknown }): string {
  if (typeof block.text === 'string') return block.text
  if (Array.isArray(block.content)) {
    return block.content.map(inner => blockText(inner as { text?: string })).join('')
  }
  return `[${String(block.type)}]`
}

/** The text of every message a session would send to the model. */
function transcript(session: Session): string[] {
  return session.deriveMessages().map(m => m.content.map(block => blockText(block as { text?: string })).join(''))
}

/** Build the seed from a fixture and return both sides of the comparison. */
function forkFixture(options: FixtureOptions = {}): {
  parent: Session
  child: Session
  seed: readonly SessionEvent[]
  stats: ReturnType<typeof buildForkSeed>['stats']
} {
  const parent = liveSession(parentFixture(options), 'session-parent')
  const { seed, stats } = buildForkSeed(parent.snapshotEvents() as unknown as ForkSeedSourceEvent[])
  const child = liveSession(seed, 'session-child')
  return { parent, child, seed, stats }
}

describe('buildForkSeed', () => {
  test('the child transcript IS the parent transcript, from the harness own fold', () => {
    const { parent, child, stats } = forkFixture()
    const parentTexts = transcript(parent)
    const childTexts = transcript(child)
    // The parent's whole visible history is the checkpoint plus what follows it.
    expect(parentTexts).toEqual([
      'COMPACTED SUMMARY of turns 1-2',
      'third question', 'third answer', 'pruned',
      'fourth question', 'fourth answer',
      'in-flight question',
    ])
    expect(childTexts).toEqual(parentTexts)
    expect(stats.messages).toBe(parentTexts.length)
    // 1.49 M-event session, 181 messages: the child log is a fraction of the parent's.
    expect(child.snapshotEvents().length).toBeLessThan(parentFixture().length)
  })

  test('an uncompacted session forks as its full history', () => {
    const { parent, child, stats } = forkFixture({ compact: false })
    expect(transcript(parent)).toEqual([
      'first question', 'first answer',
      'second question', 'second answer',
      'third question', 'third answer', 'pruned',
      'fourth question', 'fourth answer',
      'in-flight question',
    ])
    expect(transcript(child)).toEqual(transcript(parent))
    expect(stats.checkpointSeq).toBeUndefined()
    expect(stats.shadowedRange).toBeUndefined()
  })

  test('a completed tail carries no pending prompt, and a half answer is dropped', () => {
    const closed = forkFixture({ tail: 'closed' })
    expect(closed.stats.pendingPromptSeq).toBeUndefined()
    expect(transcript(closed.child)).toEqual(transcript(closed.parent))

    // Mid-turn progress: the child keeps the pending QUESTION, never the
    // half-finished answer whose tool call has no result to pair with.
    const progress = forkFixture({ tail: 'pendingProgress' })
    expect(transcript(progress.parent).at(-1)).toBe('half a result')
    expect(transcript(progress.child).at(-1)).toBe('in-flight question')
    expect(progress.stats.pendingPromptSeq).toBeDefined()
  })

  test('starts at the last compaction checkpoint', () => {
    const { stats } = forkFixture({ tail: 'closed' })
    expect(stats.checkpointSeq).toBe(13)
    expect(stats.shadowedRange).toEqual([1, 9])
    // checkpoint + u3, a3, pruned t3, u4, a4
    expect(stats.messages).toBe(6)
  })

  test('carries the last value of each state event, and nothing else', () => {
    const { seed } = forkFixture()
    const types = seed.map(e => e.type)
    expect(types.filter(t => t === 'request/header')).toHaveLength(1)
    expect(types.filter(t => t === 'todo/write')).toHaveLength(1)
    expect(types.filter(t => t === 'goal/change')).toHaveLength(1)
    for (const carried of ['sandbox/mode', 'permission/preset', 'approval/policy', 'plan/mode']) {
      expect(types).toContain(carried)
    }
    // The carried request header is the LAST one, so route/effort follow.
    const header = seed.find(e => e.type === 'request/header') as { data: { header: { config: { model: string } } } }
    expect(header.data.header.config.model).toBe('model-NEW')
    const todo = seed.find(e => e.type === 'todo/write') as { data: { todos: Array<{ text: string }> } }
    expect(todo.data.todos[0]!.text).toBe('current todo')
    for (const banned of [
      'assistant/chunk', 'session/title', 'agent/inbox/spliced',
      'compaction/start', 'compaction/summary', 'compaction/end',
      'turn/start', 'turn/end', 'step/start',
    ]) {
      expect(types).not.toContain(banned)
    }
  })

  test('is contiguous from 0, all-append, and carries no stale source refs', () => {
    const { seed, stats, parent } = forkFixture()
    seed.forEach((event, index) => expect(event.seq).toBe(index))
    for (const event of seed as unknown as ForkSeedSourceEvent[]) {
      const surface = event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result'
      if (surface) expect(event.surfaceOp).toBe('append')
      else expect(event.surfaceOp).toBeUndefined()
      // Every copied reference cites an event that is not in this log, and the
      // fold rejects a stale or empty citation, so the builder drops them all.
      expect(event.sourceEventSeqs).toBeUndefined()
    }
    expect(stats.foldedReplacements).toBe(2)
    // The parent's own log (its events + the harness's `session/end-seed`).
    expect(stats.parentEvents).toBe(parent.snapshotEvents().length)
  })

  test('keeps the pruned tool result at its ORIGINAL position', () => {
    const { seed } = forkFixture()
    const indexOf = (needle: string): number => seed.findIndex(e => JSON.stringify(e.data ?? '').includes(needle))
    const pruned = seed.findIndex(e => e.type === 'tool/result')
    expect(pruned).toBeGreaterThan(indexOf('third question'))
    expect(pruned).toBeLessThan(indexOf('fourth question'))
    // Pruned content, not the original 550-character blob.
    const text = JSON.stringify(seed[pruned])
    expect(text).toContain('pruned')
    expect(text).not.toContain('HUGE OUTPUT')
  })

  test('never mutates the parent log it reads', () => {
    const parent = liveSession(parentFixture(), 'session-parent')
    const before = JSON.stringify(parent.snapshotEvents())
    buildForkSeed(parent.snapshotEvents() as unknown as ForkSeedSourceEvent[])
    expect(JSON.stringify(parent.snapshotEvents())).toBe(before)
  })

  test('a log with no turn markers (a /fork child) can be forked again', () => {
    const { child } = forkFixture()
    // A seed carries the conversation as plain surface events: no turn brackets.
    expect((child.snapshotEvents() as unknown as ForkSeedSourceEvent[]).some(e => e.type === 'turn/end')).toBe(false)
    const { seed, stats } = buildForkSeed(child.snapshotEvents() as unknown as ForkSeedSourceEvent[])
    expect(stats.lastTurnEndSeq).toBeUndefined()
    expect(stats.messages).toBe(child.deriveMessages().length)
    // And the grandchild gets the same transcript — the parent's context survives
    // a chain of forks.
    expect(transcript(liveSession(seed, 'session-grandchild'))).toEqual(transcript(child))
  })

  test('a dangling tool call is trimmed off a turn-less tail', () => {
    // An interrupted turn: the assistant asked for a tool whose result never came.
    const dangling = [
      { type: 'user/message', seq: 0, time: 1, data: userMessage('u1', 'do the thing'), surfaceOp: 'append' },
      { type: 'assistant/message', seq: 1, time: 2, surfaceOp: 'append', data: {
        turn: 1, step: 1,
        message: {
          id: 'a1', role: 'assistant',
          source: { kind: 'model', provider: 'p', model: 'm' },
          content: [{ type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{}' }],
        },
      } },
    ] as unknown as ForkSeedSourceEvent[]
    const { seed, stats } = buildForkSeed(dangling)
    expect(stats.lastTurnEndSeq).toBeUndefined()
    expect(transcript(liveSession(seed, 'session-trimmed'))).toEqual(['do the thing'])

    // The same log WITH the result keeps both nodes: the tail is well-formed.
    const answered = [...dangling, {
      type: 'tool/result', seq: 2, time: 3, surfaceOp: 'append',
      data: toolResult('t1', 'call_1', 'done', 1, 1),
    }] as unknown as ForkSeedSourceEvent[]
    // The answer's own assistant message is the tool CALL (rendered as a block
    // marker here), then the result — a well-formed exchange.
    expect(transcript(liveSession(buildForkSeed(answered).seed, 'session-answered')))
      .toEqual(['do the thing', '[tool-call]', 'done'])
  })

  test('refuses a session with nothing to continue from', () => {
    expect(() => buildForkSeed([])).toThrow(ForkUnavailableError)
    expect(() => buildForkSeed([])).toThrow(/nothing to continue from/i)
  })

  test('describes itself for the status bar', () => {
    const { stats } = forkFixture({ tail: 'closed' })
    expect(describeForkSeed(stats)).toBe('6 messages from compaction @13 · 7 state events · 35 parent events')
    expect(describeForkSeed({ ...stats, checkpointSeq: undefined, parentEvents: 10 }))
      .toContain('full history (no compaction)')
  })
})

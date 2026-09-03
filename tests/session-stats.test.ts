/**
 * Unit tests for the bottom-bar session stats module (`session-stats.ts`):
 * the durable-log fold (steps/turns/tokens from assistant/message usage) and
 * the display formatting (groups drop when empty, compact tokens/durations).
 *
 * Run with `bun test tests/session-stats.test.ts`.
 *
 * @module dsh-tui/session-stats-test
 */

import { describe, expect, test } from 'bun:test'
import {
  emptySessionStats,
  foldSessionStats,
  formatSessionStats,
  formatStatDuration,
  formatStatTokens,
  type SessionStatsEventLike,
} from '../packages/dsh-tui-app/src/session-stats.ts'

describe('foldSessionStats', () => {
  const msg = (turn: number, usage?: { inputTokens?: number; outputTokens?: number }): SessionStatsEventLike => ({
    type: 'assistant/message',
    data: { turn, step: 0, message: { content: [] }, ...(usage === undefined ? {} : { usage }) },
  })

  test('counts steps and distinct turns, sums usage tokens', () => {
    const events: SessionStatsEventLike[] = [
      msg(0, { inputTokens: 100, outputTokens: 50 }),
      msg(0, { inputTokens: 200, outputTokens: 60 }),
      msg(1, { inputTokens: 300, outputTokens: 70 }),
      { type: 'tool/call', data: { turn: 0, step: 0 } }, // ignored by the fold
    ]
    expect(foldSessionStats(events)).toEqual({
      turns: 2,
      steps: 3,
      llmMs: 0,
      toolMs: 0,
      inputTokens: 600,
      outputTokens: 180,
    })
  })

  test('omits usage-less steps and yields zero tokens', () => {
    expect(foldSessionStats([msg(0)])).toMatchObject({ turns: 1, steps: 1, inputTokens: 0, outputTokens: 0 })
  })

  test('empty log folds to zero stats', () => {
    expect(foldSessionStats([])).toEqual(emptySessionStats())
  })
})

describe('formatting', () => {
  test('compact durations', () => {
    expect(formatStatDuration(600)).toBe('0.6s')
    expect(formatStatDuration(12_300)).toBe('12.3s')
    expect(formatStatDuration(162_000)).toBe('2m42s')
  })

  test('compact tokens', () => {
    expect(formatStatTokens(923)).toBe('923')
    expect(formatStatTokens(1_234)).toBe('1.2k')
    expect(formatStatTokens(3_456_789)).toBe('3.5M')
  })

  test('groups drop when empty', () => {
    expect(formatSessionStats(emptySessionStats())).toBe('')
    expect(formatSessionStats({ ...emptySessionStats(), steps: 3, turns: 2 })).toBe('3 steps · 2 turns')
    // LLM/Tool durations are folded but deliberately NOT shown in the bar.
    expect(formatSessionStats({
      turns: 2, steps: 3, llmMs: 12_300, toolMs: 1_600, inputTokens: 0, outputTokens: 0,
    })).toBe('3 steps · 2 turns')
    expect(formatSessionStats({
      turns: 1, steps: 1, llmMs: 0, toolMs: 0, inputTokens: 1_200, outputTokens: 3_400,
    })).toBe('1 step · 1 turn | 1.2k tok in · 3.4k tok out')
    expect(formatSessionStats({
      turns: 1, steps: 1, llmMs: 500, toolMs: 0, inputTokens: 10, outputTokens: 20,
    })).toBe('1 step · 1 turn | 10 tok in · 20 tok out')
  })
})

describe('foldSessionStats durations (events carry wall-clock time)', () => {
  test('LLM time = step/start→assistant/message; tool time = call→result (FIFO)', () => {
    const events: SessionStatsEventLike[] = [
      { type: 'step/start', data: { turn: 0, step: 0 }, time: 1_000 },
      { type: 'tool/call', data: { turn: 0, step: 0 }, time: 2_000 },
      { type: 'assistant/message', data: { turn: 0, step: 0, usage: { inputTokens: 10, outputTokens: 20 } }, time: 2_600 },
      { type: 'tool/result', data: { turn: 0, step: 0 }, time: 4_500 },
      { type: 'step/start', data: { turn: 1, step: 0 }, time: 5_000 },
      { type: 'assistant/message', data: { turn: 1, step: 0, usage: { inputTokens: 30, outputTokens: 40 } }, time: 6_400 },
    ]
    expect(foldSessionStats(events)).toEqual({
      turns: 2,
      steps: 2,
      llmMs: (2_600 - 1_000) + (6_400 - 5_000), // 1600 + 1400
      toolMs: 4_500 - 2_000,
      inputTokens: 40,
      outputTokens: 60,
    })
  })

  test('events without time keep durations at zero', () => {
    expect(foldSessionStats([
      { type: 'step/start', data: { turn: 0, step: 0 } },
      { type: 'assistant/message', data: { turn: 0, step: 0 } },
    ])).toMatchObject({ llmMs: 0, toolMs: 0 })
  })
})

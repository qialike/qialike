/**
 * Tests for the concurrent-write resume hardening (fix: a session that another
 * process is appending to often FALSE-positives as "corrupt" — the harness
 * reader requires the last committed zstd frame to end on a complete JSONL
 * record, and records straddle frame seams while the writer is appending).
 * - isCorruptLogMessage now recognizes the zstd "torn JSONL record" variant;
 * - withResumeCorruptRetry retries corrupt-class failures a bounded number of
 *   times (the writer usually advances within a few hundred ms) and only then
 *   lets the caller fall back.
 *
 * Run with `bun test tests/resume-corrupt-retry.test.ts`.
 *
 * @module qialike/resume-corrupt-retry-test
 */

import { describe, expect, test } from 'bun:test'
import {
  describeResumeFailure,
  isCorruptLogMessage,
  withResumeCorruptRetry,
} from '../packages/qialike-app/src/resume-fold.ts'

describe('isCorruptLogMessage', () => {
  test('recognizes both corrupt classes', () => {
    expect(isCorruptLogMessage('resume: corrupt session log: seq gap in committed region')).toBe(true)
    expect(isCorruptLogMessage('corrupt Zstandard session log: complete frame contains a torn JSONL record')).toBe(true)
    expect(isCorruptLogMessage('some other error')).toBe(false)
    expect(isCorruptLogMessage('')).toBe(false)
  })
})

describe('describeResumeFailure', () => {
  test('corrupt-class errors explain BOTH possible causes (transient vs real)', () => {
    const text = describeResumeFailure(new Error('corrupt Zstandard session log: complete frame contains a torn JSONL record'))
    expect(text).toContain('resume: the session log was rejected as corrupt')
    // Concurrent-write transient reads are retried; do not claim it is the only cause.
    expect(text).toContain('another process is appending to the same session')
    // Real mid-log seq damage (interrupted resume leftovers) is called out too.
    expect(text).toContain('real seq damage')
    expect(text).toContain('leftover lines')
  })

  test('non-corrupt errors pass through with the resume: prefix', () => {
    expect(describeResumeFailure(new Error('boom'))).toBe('resume: boom')
  })
})

describe('withResumeCorruptRetry', () => {
  test('succeeds on a later attempt after transient corrupt reads', async () => {
    let calls = 0
    const result = await withResumeCorruptRetry(async () => {
      calls += 1
      if (calls < 3) throw new Error('corrupt Zstandard session log: complete frame contains a torn JSONL record')
      return 'ok'
    }, { retries: 3, waitMs: 1 })
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  test('gives up with the last error after exhausting retries', async () => {
    let calls = 0
    await expect(withResumeCorruptRetry(async () => {
      calls += 1
      throw new Error('corrupt session log: seq gap')
    }, { retries: 2, waitMs: 1 })).rejects.toThrow('corrupt session log')
    expect(calls).toBe(3) // first attempt + 2 retries
  })

  test('non-corrupt errors throw immediately without retry', async () => {
    let calls = 0
    await expect(withResumeCorruptRetry(async () => {
      calls += 1
      throw new Error('no agent factory registered')
    }, { retries: 5, waitMs: 1 })).rejects.toThrow('no agent factory registered')
    expect(calls).toBe(1)
  })
})

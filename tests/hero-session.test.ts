/**
 * Tests for the hero/docked launch split (web parity):
 *  - `dsh-tui` (no argument) never auto-resumes: it opens an unused New
 *    Session placeholder and shows the HERO screen;
 *  - `dsh-tui resume` continues the newest session WITH CONTENT and lands
 *    directly in the conversation view (docked);
 *  - the store's hero predicate flips on the first submit's own frame.
 *
 * DSH_HOME points at a throwaway temp dir before any session-titles call so
 * the real ~/.dsh title cache is never touched.
 *
 * Run with `bun test tests/hero-session.test.ts`.
 *
 * @module dsh-tui/hero-session-test
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { parseResumeMode, tuiCommand } from '../packages/dsh-tui-app/src/startup.ts'
import { Store } from '../packages/dsh-tui-app/src/index.tsx'
import { rememberBlank } from '../packages/dsh-tui-app/src/session-titles.ts'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-hero-test-'))
process.env.DSH_HOME = home

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

function sid(text: string): SessionId {
  return text as SessionId
}

describe('resume mode parsing', () => {
  test('a bare launch is NOT resume mode; `resume` is', () => {
    expect(parseResumeMode(undefined)).toBe(false)
    expect(parseResumeMode('resume')).toBe(true)
  })

  test('an unknown positional fails loud instead of starting fresh', () => {
    expect(() => parseResumeMode('resme')).toThrow(/unknown argument "resme"/)
    expect(() => parseResumeMode('--resume')).toThrow()
  })

  test('the command declares the positional mode and keeps --resume <id>', () => {
    const program = tuiCommand()
    expect(program.registeredArguments.map((a) => a.name())).toEqual(['mode'])
    expect(program.options.map((o) => o.long)).toContain('--resume')
    expect(program.options.map((o) => o.long)).toContain('--workspace')
  })
})

describe('store hero predicate', () => {
  test('an unused blank session shows the hero; content/running/attempted do not', () => {
    const store = new Store()
    const id = sid('hero-blank-session')
    store.setSession({ id } as never)
    rememberBlank(id, true)
    expect(store.hero).toBe(true)

    // No session bound yet: the hero is the safe default.
    const fresh = new Store()
    expect(fresh.hero).toBe(true)

    // First submit flips it locally, ahead of any harness round-trip.
    store.markPromptAttempted()
    expect(store.hero).toBe(false)

    // …and a blank flip (turn/start) keeps it off.
    store.setSession({ id } as never) // resets the attempt
    rememberBlank(id, false)
    expect(store.hero).toBe(false)

    // A running turn never renders the hero even if the blank bit is stale.
    const running = new Store()
    const id2 = sid('hero-running-session')
    running.setSession({ id: id2 } as never)
    rememberBlank(id2, true)
    running.setRunning(true)
    expect(running.hero).toBe(false)
  })

  test('a resumed session with content is docked, not hero', () => {
    const store = new Store()
    const id = sid('hero-content-session')
    store.setSession({ id } as never)
    rememberBlank(id, false)
    expect(store.hero).toBe(false)
  })
})

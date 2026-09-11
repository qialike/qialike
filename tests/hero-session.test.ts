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
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { parseResumeMode, tuiCommand } from '../packages/dsh-tui-app/src/startup.ts'
import { Store,
  orderResumeCandidates,
} from '../packages/dsh-tui-app/src/index.tsx'
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

describe('store hero predicate while a launch is opening', () => {
  test('a blank-landing launch keeps the hero; a /sessions switch does not', () => {
    // `dsh-tui` with no args can only land on an unused blank session, so the
    // hero must be the FIRST frame — before this it painted the docked chrome
    // (status bar + `Load session:`) for the ~0.4 s the host needed, then
    // replaced it (measured on a real terminal: DOCK at t=0.68 s, HERO at 1.04 s).
    const launching = new Store()
    launching.beginSessionLoading({ id: 'host', startedAt: Date.now(), keepHero: true })
    expect(launching.hero).toBe(true)

    // A switch to an existing session is a user call: docked chrome from frame 1,
    // because that is where the load progress lives.
    const switching = new Store()
    switching.beginSessionLoading({ id: 'sess-1', startedAt: Date.now() })
    expect(switching.hero).toBe(false)

    // `/new` is an EXPLICIT session request: it lands on a blank session, but the
    // docked conversation view is the right screen — the hero is launch-only.
    const fresh = new Store()
    fresh.leaveHero()
    fresh.beginSessionLoading({ id: 'new', startedAt: Date.now() })
    expect(fresh.hero).toBe(false)
    fresh.endSessionLoading()
    const id3 = sid('new-blank-session')
    fresh.setSession({ id: id3 } as never)
    rememberBlank(id3, true)
    expect(fresh.hero).toBe(false)

    // A FAILED load must win over keepHero: the hero has no status bar, so an
    // error there would be invisible.
    launching.failSessionLoad('host attach failed')
    expect(launching.hero).toBe(false)
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

describe('leaveHero (explicit session actions)', () => {
  test('a blank session shows the hero only until the user asks for one', () => {
    const store = new Store()
    const id = sid('leave-hero-session')
    store.setSession({ id } as never)
    rememberBlank(id, true)
    // A bare launch: the hero is the launch placeholder.
    expect(store.hero).toBe(true)
    // `/new` or a `/sessions` switch: docked from now on, blank or not.
    store.leaveHero()
    expect(store.hero).toBe(false)
    // …and it stays left across later sessions in the same process.
    const id2 = sid('leave-hero-session-2')
    store.setSession({ id: id2 } as never)
    rememberBlank(id2, true)
    expect(store.hero).toBe(false)
    store.leaveHero() // idempotent
    expect(store.hero).toBe(false)
  })
})

describe('resume targets the most recently active session, content or not', () => {
  const source = readFileSync(new URL('../packages/dsh-tui-app/src/index.tsx', import.meta.url), 'utf8')

  test('the picker has no content filter any more', () => {
    // Requiring >32 events fell through to an older session the user was not
    // working in, which is the opposite of "resume what I was just using".
    const picker = source.slice(source.indexOf('async function mostRecentlyActiveSession'))
    const body = picker.slice(0, picker.indexOf('\n}'))
    expect(body).toContain('return orderResumeCandidates(candidates)[0]?.id')
    expect(body).not.toContain('totalEvents()')
    expect(source).not.toContain('BLANK_SESSION_EVENTS')
  })
})

describe('orderResumeCandidates (what `dsh-tui resume` continues)', () => {
  test('activity (log mtime) wins over creation time', () => {
    // The daily driver is OLD but still in use; freshly created throwaways are
    // newer. Before this rule `resume` continued the throwaway.
    const daily = { id: 'daily', createdAt: 1_000, activeAt: 9_000 }
    const throwaway = { id: 'throwaway', createdAt: 5_000, activeAt: 6_000 }
    expect(orderResumeCandidates([throwaway, daily]).map((c) => c.id)).toEqual(['daily', 'throwaway'])
  })

  test('equal activity falls back to the newer creation time', () => {
    const older = { id: 'older', createdAt: 1_000, activeAt: 7_000 }
    const newer = { id: 'newer', createdAt: 2_000, activeAt: 7_000 }
    expect(orderResumeCandidates([older, newer]).map((c) => c.id)).toEqual(['newer', 'older'])
  })

  test('does not mutate the caller array', () => {
    const input = [{ id: 'a', createdAt: 1, activeAt: 1 }, { id: 'b', createdAt: 2, activeAt: 2 }]
    orderResumeCandidates(input)
    expect(input.map((c) => c.id)).toEqual(['a', 'b'])
  })
})

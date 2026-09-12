/**
 * Regression: ONE unreadable or torn session log must not kill the TUI.
 *
 * The `/sessions` dialog asks the harness for `persistence.list()`, which reads
 * every session log's generation header. That call rejects on the first
 * unreadable file, and because the call site had no rejection handler the
 * rejection became an `unhandledRejection` — which the harness's fail-loud hook
 * answers with `process.exit(1)`. Measured on a real pty: `chmod 000` on an
 * unrelated session log plus `/sessions` terminated the whole process with exit
 * code 1, losing the user's context and unsent input.
 *
 * The fix has three parts, all pinned here:
 *   1. the rejection is handled (no `unhandledRejection`, no exit);
 *   2. the user is told, in a transcript row the dialog cannot mask;
 *   3. the list still opens, via the file-backed reader — which drops the one
 *      unreadable session instead of failing, so the other sessions stay usable.
 *
 * Run with `bun test tests/sessions-list-failure.test.ts`.
 *
 * @module dsh-tui/sessions-list-failure-test
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../packages/dsh-tui-app/src/index.tsx'
import { apply } from '../packages/dsh-tui-app/src/sessions.tsx'
import { projectKey } from '../packages/dsh-tui-app/src/session-files.ts'

const WORKSPACE = '/home/pipo/deepseek'
let home: string
let realHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-tui-list-failure-'))
  realHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
})

afterEach(() => {
  if (realHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = realHome
  rmSync(home, { recursive: true, force: true })
})

/** Register the panel against a minimal context and hand back the command. */
function mount(list: () => Promise<unknown>): { store: Store; open: () => void } {
  const store = new Store()
  store.setWorkspace(WORKSPACE)
  const commands = new Map<string, { run: () => void }>()
  const tui = {
    panels: { register: (): void => {} },
    commands: { register: (command: { name: string; run: () => void }): void => { commands.set(command.name, command) } },
  }
  const ctx = {
    get: (name: string): unknown => (name === 'tuiStore' ? store : name === 'tui' ? tui : { list }),
  }
  apply(ctx as never)
  const command = commands.get('sessions')
  if (command === undefined) throw new Error('/sessions was not registered')
  return { store, open: () => command.run() }
}

/** Let the promise chain (list → catch → fallback) run to completion. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

describe('/sessions list failure', () => {
  test('a rejecting list() is handled: no unhandledRejection, and the user is told', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      const { store, open } = mount(() => Promise.reject(new Error("EACCES: permission denied, open '/x/session.v3.jsonl.zstd'")))
      open()
      await settle()
      expect(rejections).toEqual([])
      const status = store.items.filter((item) => item.kind === 'status').map((item) => item.text)
      expect(status.some((text) => text.startsWith('sessions: '))).toBe(true)
      expect(status.find((text) => text.startsWith('sessions: '))).toContain('EACCES')
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  test('the list still opens through the file-backed fallback (defensive per session)', async () => {
    // One unreadable log inside the workspace's project dir: `listSessionFiles`
    // must DROP it rather than fail, which is what makes it the right fallback.
    const projectDir = join(home, 'sessions', projectKey(WORKSPACE))
    mkdirSync(join(projectDir, 'session-0309e08a-4ee4-45e9-95b7-6f225b3b7daf'), { recursive: true })
    writeFileSync(join(projectDir, 'session-0309e08a-4ee4-45e9-95b7-6f225b3b7daf', 'session.v3.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))

    const { store, open } = mount(() => Promise.reject(new Error('EACCES')))
    open()
    await settle()
    // `refreshSessionsDialog` is how any list reaches the dialog; it also opens
    // the panel. The unreadable log costs that row its HEADER FACTS, not its
    // row: the file-backed reader falls back to the directory name (see
    // `listSessionFiles`), so the list stays usable instead of empty — which is
    // the whole reason it is the fallback here.
    expect(store.panel).toBe('sessions')
    expect(store.sessionsDialog.map((row) => row.id)).toEqual(['session-0309e08a-4ee4-45e9-95b7-6f225b3b7daf'])
    // And the failure is still reported rather than silently swallowed.
    expect(store.items.some((item) => item.kind === 'status' && item.text.startsWith('sessions: '))).toBe(true)
  })

  test('a resolving list() still renders the rows (the happy path is unchanged)', async () => {
    const { store, open } = mount(() => Promise.resolve([
      { id: 'session-3c1c6602-1ddc-40ee-a295-f34348c87153', cwd: WORKSPACE, createdAt: 1 },
    ]))
    open()
    await settle()
    expect(store.panel).toBe('sessions')
    expect(store.sessionsDialog.map((row) => row.id)).toEqual(['session-3c1c6602-1ddc-40ee-a295-f34348c87153'])
  })

  test('a throw INSIDE the then-body is caught too (resolve-then-explode)', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      // `listRowHeaders` is the first thing the then-body does; a malformed
      // payload (a service that resolves with the wrong shape) throws there.
      // The handler must cover the whole chain, not only a rejected `list()`.
      const { store, open } = mount(() => Promise.resolve(null as never))
      open()
      await settle()
      expect(rejections).toEqual([])
      expect(store.items.some((item) => item.kind === 'status' && item.text.startsWith('sessions: '))).toBe(true)
      expect(store.panel).toBe('sessions')   // the file-backed fallback still opened it
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})

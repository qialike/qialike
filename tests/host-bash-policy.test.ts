/**
 * P4c M3 contract: the `read-only` bash fence is ONE rule shared by both
 * processes. In host mode the client draws the permission chip but the HOST
 * owns the session and enforces the fence, so a duplicated regex or a second
 * copy of the decision would let a write slip through exactly when the user
 * believes they are read-only.
 *
 * Anchors:
 *  - the rule itself (mutation detection + the `[sandbox: …]` denial marker);
 *  - the mirror source: cycling the mode notifies through the SHARED store, not
 *    a module export (the panel bundles each get their own module copies);
 *  - a source-level guard that `host.ts` uses the shared rule instead of its own.
 *
 * Run with `bun test tests/host-bash-policy.test.ts`.
 *
 * @module dsh-tui/host-bash-policy-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bashMutates, readOnlyBashDecision } from '../packages/dsh-tui-app/src/bash-policy.ts'
import { Store } from '../packages/dsh-tui-app/src/index.tsx'

describe('bashMutates detects filesystem mutations', () => {
  test('write-ish commands are mutations', () => {
    for (const command of [
      'rm -rf build',
      'mv a b',
      'mkdir -p x/y',
      'echo hi > file.txt',
      'printf a >> log',
      'sed -i s/a/b/ f',
      'chmod +x run.sh',
      'git commit -m x',
      'python3 -c "open(\'f\',\'w\')"',
    ]) {
      expect(bashMutates(command)).toBe(true)
    }
  })

  test('reads and empty commands are not', () => {
    for (const command of ['', '   ', 'ls -la', 'cat file', 'grep -rn foo .', 'git status', 'sed s/a/b/ f']) {
      expect(bashMutates(command)).toBe(false)
    }
  })
})

describe('readOnlyBashDecision fences bash only under read-only', () => {
  test('denies a mutating bash command with the escalation marker', () => {
    const decision = readOnlyBashDecision({ name: 'bash', args: { command: 'rm -rf /tmp/x' } }, 'read-only')
    expect(decision?.kind).toBe('deny')
    expect(decision?.reason).toContain('[sandbox: file access denied under read-only mode]')
  })

  test('read-only accepts an args STRING too (the harness also passes those)', () => {
    expect(readOnlyBashDecision({ name: 'bash', args: 'touch x' }, 'read-only')?.kind).toBe('deny')
  })

  test('a read-only command, another tool, and a wider mode all delegate', () => {
    expect(readOnlyBashDecision({ name: 'bash', args: { command: 'ls' } }, 'read-only')).toBeUndefined()
    expect(readOnlyBashDecision({ name: 'read', args: { command: 'rm x' } }, 'read-only')).toBeUndefined()
    expect(readOnlyBashDecision({ name: 'bash', args: { command: 'rm x' } }, 'workspace-write')).toBeUndefined()
    expect(readOnlyBashDecision({ name: 'bash', args: { command: 'rm x' } }, 'danger-full-access')).toBeUndefined()
  })
})

describe('the fence is shared, not duplicated', () => {
  test('host.ts applies the same rule (no second copy of the regexes)', () => {
    const host = readFileSync(join(process.cwd(), 'packages/dsh-tui-app/src/host.ts'), 'utf8')
    expect(host).toContain('readOnlyBashDecision')
    expect(host).not.toMatch(/\(rm\|mv\|cp\|mkdir/)
    const client = readFileSync(join(process.cwd(), 'packages/dsh-tui-app/src/index.tsx'), 'utf8')
    expect(client).toContain('readOnlyBashDecision')
    expect(client).not.toMatch(/function bashMutates/)
  })

  test('cycling the mode notifies through the SHARED store (host mirror)', () => {
    const store = new Store()
    const seen: string[] = []
    store.onPermissionChange = (mode) => { seen.push(mode) }
    expect(store.cyclePermission()).toBe('danger-full-access')
    expect(store.cyclePermission()).toBe('read-only')
    expect(seen).toEqual(['danger-full-access', 'read-only'])
  })
})

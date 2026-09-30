/**
 * The `read-only` bash fence is ONE rule: the TUI's own `tools/pre-execute`
 * handler applies `readOnlyBashDecision`, so a duplicated regex or a second
 * copy of the decision would let a write slip through exactly when the user
 * believes they are read-only.
 *
 * Anchors:
 *  - the rule itself (mutation detection + the `[sandbox: …]` denial marker);
 *  - the single source of truth: cycling the mode notifies through the SHARED
 *    store, not a module export (the panel bundles each get their own module
 *    copies).
 *
 * Run with `bun test tests/host-bash-policy.test.ts`.
 *
 * @module qialike/host-bash-policy-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bashMutates, partialEnforcementNotice, readOnlyBashDecision, unconfinedShellAskDecision } from '../packages/qialike-app/src/bash-policy.ts'
import { Store } from '../packages/qialike-app/src/index.tsx'

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
  test('denies a mutating bash command with the marker AND the escalation hint', () => {
    const decision = readOnlyBashDecision({ name: 'bash', arguments: { command: 'rm -rf /tmp/x' } }, 'read-only')
    expect(decision?.kind).toBe('deny')
    // Verbatim the harness's own marker + hint (dsh-sandbox): a second dialect
    // for the same refusal would leave the model without the sanctioned retry.
    expect(decision?.reason).toContain('[sandbox: file access denied under read-only mode]')
    expect(decision?.reason).toContain('escalation available')
    expect(decision?.reason).toContain('sandbox_permissions')
  })

  test('the payload field is `arguments` — reading `args` fails OPEN (shipped bug)', () => {
    // The harness's ToolExecution carries parsed arguments on `arguments`. The
    // fence once read `args`, saw '' every time and never denied anything.
    expect(readOnlyBashDecision({ name: 'bash', arguments: { command: 'touch x' } }, 'read-only')?.kind).toBe('deny')
    expect(readOnlyBashDecision({ name: 'bash', args: { command: 'touch x' } }, 'read-only')).toBeUndefined()
  })

  test('a string payload is accepted too (tools with a bare-string schema)', () => {
    expect(readOnlyBashDecision({ name: 'bash', arguments: 'touch x' }, 'read-only')?.kind).toBe('deny')
  })

  test('a read-only command, another tool, and a wider mode all delegate', () => {
    expect(readOnlyBashDecision({ name: 'bash', arguments: { command: 'ls' } }, 'read-only')).toBeUndefined()
    expect(readOnlyBashDecision({ name: 'read', arguments: { command: 'rm x' } }, 'read-only')).toBeUndefined()
    expect(readOnlyBashDecision({ name: 'bash', arguments: { command: 'rm x' } }, 'workspace-write')).toBeUndefined()
    expect(readOnlyBashDecision({ name: 'bash', arguments: { command: 'rm x' } }, 'danger-full-access')).toBeUndefined()
  })

  test('pwsh and bash-flavoured tool names are fenced as well', () => {
    expect(readOnlyBashDecision({ name: 'pwsh', arguments: { command: 'mkdir x' } }, 'read-only')?.kind).toBe('deny')
    expect(readOnlyBashDecision({ name: 'bash-bg', arguments: { command: 'mkdir x' } }, 'read-only')?.kind).toBe('deny')
  })
})

describe('unconfinedShellAskDecision gates a shell that no kernel confines', () => {
  const unconfined = { permission: 'workspace-write', shellConfines: false } as const

  test('asks for a shell tool when the mounted executor applies no confinement', () => {
    const decision = unconfinedShellAskDecision({ name: 'pwsh', arguments: { command: 'Get-ChildItem' } }, unconfined)
    expect(decision?.kind).toBe('ask')
    // The prompt is the whole boundary on such a host, so it must state the
    // stake rather than read like a routine confirmation.
    expect(decision?.reason).toContain('no kernel sandbox')
    expect(decision?.reason).toContain('full user authority')
    expect(decision?.reason).toContain('"pwsh"')
  })

  test('delegates once a confining executor is mounted — the capability fact decides, not the platform', () => {
    expect(unconfinedShellAskDecision({ name: 'pwsh', arguments: {} }, { permission: 'workspace-write', shellConfines: true })).toBeUndefined()
  })

  test('danger-full-access is exempt: the user already chose "no boundary"', () => {
    expect(unconfinedShellAskDecision({ name: 'pwsh', arguments: {} }, { permission: 'danger-full-access', shellConfines: false })).toBeUndefined()
  })

  test('read-only still asks (the deny fence runs first and is stronger)', () => {
    // Both fences apply; index.tsx consults readOnlyBashDecision first, so a
    // mutating command under read-only is denied rather than merely asked.
    expect(unconfinedShellAskDecision({ name: 'bash', arguments: {} }, { permission: 'read-only', shellConfines: false })?.kind).toBe('ask')
  })

  test('a non-shell tool is never gated here', () => {
    expect(unconfinedShellAskDecision({ name: 'read', arguments: {} }, unconfined)).toBeUndefined()
    expect(unconfinedShellAskDecision({ arguments: {} }, unconfined)).toBeUndefined()
  })

  test('bash-flavoured names are gated too', () => {
    expect(unconfinedShellAskDecision({ name: 'bash-bg', arguments: {} }, unconfined)?.kind).toBe('ask')
  })
})

describe('the fence is shared, not duplicated', () => {
  test('index.tsx applies the shared rule (no second copy of the regexes)', () => {
    const client = readFileSync(join(process.cwd(), 'packages/qialike-app/src/index.tsx'), 'utf8')
    expect(client).toContain('readOnlyBashDecision')
    expect(client).toContain('unconfinedShellAskDecision')
    expect(client).not.toMatch(/function bashMutates/)
  })

  test('cycling the mode notifies through the SHARED store (not a module copy)', () => {
    const store = new Store()
    const seen: string[] = []
    store.onPermissionChange = (mode) => { seen.push(mode) }
    expect(store.cyclePermission()).toBe('danger-full-access')
    expect(store.cyclePermission()).toBe('read-only')
    expect(seen).toEqual(['danger-full-access', 'read-only'])
  })
})

describe('partial enforcement is surfaced, not silently implied', () => {
  test('a partial settlement produces a notice naming the mode and the gap', () => {
    const notice = partialEnforcementNotice({ mode: 'workspace-write', enforcement: 'partial' })
    expect(notice).toContain('PARTIAL')
    expect(notice).toContain('workspace-write')
    expect(notice).toContain('not for reads')
  })

  test('a full or absent enforcement produces nothing', () => {
    expect(partialEnforcementNotice({ mode: 'workspace-write', enforcement: 'full' })).toBeUndefined()
    expect(partialEnforcementNotice({ mode: 'workspace-write' })).toBeUndefined()
    expect(partialEnforcementNotice(undefined)).toBeUndefined()
  })

  test('the notice is derived from the settled result, never from the platform', () => {
    // A missing mode must not invent one: the mode label is the harness's.
    const notice = partialEnforcementNotice({ enforcement: 'partial' })
    expect(notice).toContain('this mode')
    expect(notice).not.toContain('win32')
  })

  test('index.tsx announces it from the post-execute result', () => {
    const client = readFileSync(join(process.cwd(), 'packages/qialike-app/src/index.tsx'), 'utf8')
    expect(client).toContain('partialEnforcementNotice')
    expect(client).toContain("'tools/post-execute'")
  })

  test('the harness really publishes enforcement on a settled shell result', () => {
    // P2-A reads `result.value.sandbox.enforcement`. That path belongs to the
    // harness, so pin it here: a bump that moves the field must fail THIS test,
    // not leave the TUI silently announcing nothing.
    const bundle = readFileSync(
      join(process.cwd(), 'apps/tui-bin/x/-deepseek-ai-dsh-tool-pwsh/lib/index.js'),
      'utf8',
    )
    // The dispatched value carries the settled facts …
    expect(bundle).toContain('...result.sandbox !== void 0 ? { sandbox: {')
    // … and the output schema declares the field, so normalization keeps it.
    expect(bundle).toMatch(/sandbox: \{[\s\S]{0,400}enforcement: \{ type: "string" \}/)
  })
})

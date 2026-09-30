/**
 * The secrets read guard: qialike refuses tool reads of `.env`-family files,
 * `.git` internals, and the harness credential document.
 *
 * Why it exists: the harness's `SandboxMode` promises FILE EFFECTS only, and
 * every backend grants the whole host root read-only — so nothing below the tool
 * layer stops a model (or an injected page driving it) from reading the user's
 * secrets. This guard is mode-INDEPENDENT by design: it is a confidentiality
 * rule, not a file-effect boundary the user widens with `danger-full-access`.
 *
 * Anchors:
 *  - the secret-name family, including the `.env.example` exception that keeps
 *    ordinary project setup readable;
 *  - the deny's reason, which must say no escalation lifts it (otherwise the
 *    harness's escalation hint invites the model to ask for a wider mode);
 *  - the shell gap is deliberate and documented, not accidental.
 *
 * Run with `bun test tests/read-policy.test.ts`.
 *
 * @module qialike/read-policy-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { blockedPathSegment, blockedReadDecision, isBlockedSecretSegment } from '../packages/qialike-app/src/read-policy.ts'

describe('isBlockedSecretSegment', () => {
  test('the .env family is secret', () => {
    for (const segment of ['.env', '.env.local', '.env.production', 'prod.env', 'secrets.env']) {
      expect(isBlockedSecretSegment(segment)).toBe(true)
    }
  })

  test('.env.example is NOT secret — it is the committed template an agent should read', () => {
    for (const segment of ['.env.example', 'prod.env.example']) {
      expect(isBlockedSecretSegment(segment)).toBe(false)
    }
  })

  test('lookalikes are not false positives', () => {
    for (const segment of ['environment.ts', '.environment', 'env.ts', 'env.example']) {
      expect(isBlockedSecretSegment(segment)).toBe(false)
    }
  })
})

describe('blockedPathSegment', () => {
  test('finds the offending segment in POSIX and Windows paths', () => {
    expect(blockedPathSegment('a/.env')).toBe('.env')
    expect(blockedPathSegment('.git/config')).toBe('.git')
    expect(blockedPathSegment('C:\\proj\\.env.local')).toBe('.env.local')
    expect(blockedPathSegment('~/.dsh/.credentials.yaml')).toBe('.credentials.yaml')
    expect(blockedPathSegment('**/*.env')).toBe('*.env')
  })

  test('ordinary source paths pass', () => {
    for (const path of ['src/index.ts', 'docs/guide.md', 'a/b/c.txt', '', '.', '..', './src/main.rs']) {
      expect(blockedPathSegment(path)).toBeUndefined()
    }
  })
})

describe('blockedReadDecision', () => {
  test('denies a read of a secret file and says no escalation lifts it', () => {
    const decision = blockedReadDecision({ name: 'read', arguments: { file_path: '.env' } })
    expect(decision?.kind).toBe('deny')
    expect(decision?.reason).toContain('.env')
    expect(decision?.reason).toContain('no sandbox_permissions escalation lifts it')
  })

  test('guards every read tool and every path-carrying argument', () => {
    expect(blockedReadDecision({ name: 'read_image', arguments: { file_path: 'x/.env' } })?.kind).toBe('deny')
    expect(blockedReadDecision({ name: 'grep', arguments: { path: '.git' } })?.kind).toBe('deny')
    expect(blockedReadDecision({ name: 'glob', arguments: { pattern: '**/*.env' } })?.kind).toBe('deny')
  })

  test('a grep whose PATTERN merely mentions .env is not a secret read', () => {
    // `grep` searches for `pattern` under `path`; only `path` names a file here.
    const decision = blockedReadDecision({ name: 'grep', arguments: { path: 'src', pattern: '\\.env' } })
    expect(decision).toBeUndefined()
  })

  test('the template and ordinary paths read normally', () => {
    expect(blockedReadDecision({ name: 'read', arguments: { file_path: '.env.example' } })).toBeUndefined()
    expect(blockedReadDecision({ name: 'read', arguments: { file_path: 'src/index.ts' } })).toBeUndefined()
  })

  test('non-read tools and malformed payloads delegate', () => {
    expect(blockedReadDecision({ name: 'write', arguments: { file_path: '.env' } })).toBeUndefined()
    expect(blockedReadDecision({ arguments: { file_path: '.env' } })).toBeUndefined()
    expect(blockedReadDecision({ name: 'read' })).toBeUndefined()
  })
})

describe('the guard is wired and its shell gap is deliberate', () => {
  test('index.tsx applies the shared rule', () => {
    const client = readFileSync(join(process.cwd(), 'packages/qialike-app/src/index.tsx'), 'utf8')
    expect(client).toContain('blockedReadDecision')
    // The gap is stated in the module that owns the rule, not left implicit.
    const policy = readFileSync(join(process.cwd(), 'packages/qialike-app/src/read-policy.ts'), 'utf8')
    expect(policy).toContain('deliberate gap')
    expect(policy).toContain('not the shell')
  })
})

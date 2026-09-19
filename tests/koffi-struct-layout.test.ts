/**
 * The koffi shim's Win64 struct layout (P4-step1).
 *
 * Why this is a load-bearing test: `@deepseek-ai/dsh-win32-process` asserts two
 * struct sizes at MODULE SCOPE and throws on mismatch, so a wrong layout breaks
 * the import on EVERY platform — including the Linux/macOS builds that load the
 * module but never call a Win32 function. That is exactly the crash the previous
 * `unusable` stub existed to dodge
 * (`STARTUPINFOW layout mismatch: koffi computed undefined, expected 104`).
 *
 * The two real structs below mirror the harness declarations verbatim; the
 * drift guard at the end fails if the harness adds or renames a field without
 * this file following, because such a change moves the expected size.
 *
 * Run with `bun test tests/koffi-struct-layout.test.ts`.
 *
 * @module qialike/koffi-struct-layout-test
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import koffi from '../apps/tui-bin/stub/koffi.js'

/** `STARTUPINFOW` as `win32-process/src/ffi.ts` declares it. */
function startupInfoW() {
  return koffi.struct('DSH_STARTUPINFOW', {
    cb: 'uint32',
    lpReserved: 'str16',
    lpDesktop: 'str16',
    lpTitle: 'str16',
    dwX: 'uint32',
    dwY: 'uint32',
    dwXSize: 'uint32',
    dwYSize: 'uint32',
    dwXCountChars: 'uint32',
    dwYCountChars: 'uint32',
    dwFillAttribute: 'uint32',
    dwFlags: 'uint32',
    wShowWindow: 'uint16',
    cbReserved2: 'uint16',
    lpReserved2: koffi.pointer('uint8'),
    hStdInput: koffi.pointer('void'),
    hStdOutput: koffi.pointer('void'),
    hStdError: koffi.pointer('void'),
  })
}

/** `PROCESS_INFORMATION` as `win32-process/src/ffi.ts` declares it. */
function processInformation() {
  return koffi.struct('DSH_PROCESS_INFORMATION', {
    hProcess: koffi.pointer('void'),
    hThread: koffi.pointer('void'),
    dwProcessId: 'uint32',
    dwThreadId: 'uint32',
  })
}

describe('the two structs the harness asserts at module scope', () => {
  test('STARTUPINFOW lays out to exactly 104 bytes (abi.ts:46)', () => {
    // 4 (cb) + 4 pad + 3 pointers + 8 x uint32 + 2 x uint16 + 4 pad + 4 pointers.
    expect(startupInfoW().size).toBe(104)
  })

  test('PROCESS_INFORMATION lays out to exactly 24 bytes (abi.ts:48)', () => {
    expect(processInformation().size).toBe(24)
  })

  test('a missing size is what the harness guard reports, so sizes must never be undefined here', () => {
    expect(startupInfoW().size).toBeDefined()
    expect(processInformation().size).toBeDefined()
  })
})

describe('Win64 member alignment and padding', () => {
  test('a pointer after a uint32 pads to 8', () => {
    const s = koffi.struct('S1', { a: 'uint32', b: koffi.pointer('void') })
    expect(s.offsets).toEqual({ a: 0, b: 8 })
    expect(s.size).toBe(16)
  })

  test('two uint16 then uint32 pack without padding', () => {
    const s = koffi.struct('S2', { a: 'uint16', b: 'uint16', c: 'uint32' })
    expect(s.offsets).toEqual({ a: 0, b: 2, c: 4 })
    expect(s.size).toBe(8)
  })

  test('a uint8 before a uint64 pads to 8 and the total rounds to the struct alignment', () => {
    const s = koffi.struct('S3', { a: 'uint8', b: 'uint64' })
    expect(s.offsets).toEqual({ a: 0, b: 8 })
    expect(s.size).toBe(16)
  })

  test('a trailing uint8 pads the total up to the largest member alignment', () => {
    const s = koffi.struct('S4', { a: 'uint32', b: 'uint8' })
    expect(s.offsets).toEqual({ a: 0, b: 4 })
    expect(s.size).toBe(8)
  })

  test('str16 is a pointer, not an inline buffer', () => {
    const s = koffi.struct('S5', { a: 'str16', b: 'uint32' })
    expect(s.offsets).toEqual({ a: 0, b: 8 })
    expect(s.size).toBe(16)
  })

  test('an array member is elementSize x length at the element alignment', () => {
    const s = koffi.struct('S6', { a: 'uint8', b: koffi.array('uint32', 4) })
    expect(s.offsets).toEqual({ a: 0, b: 4 })
    expect(s.size).toBe(20)
  })

  test('a nested struct keeps its own layout and alignment', () => {
    const inner = koffi.struct('Inner', { x: 'uint32', y: koffi.pointer('void') })
    const outer = koffi.struct('Outer', { a: 'uint8', b: inner })
    expect(outer.offsets).toEqual({ a: 0, b: 8 })
    expect(outer.size).toBe(24)
  })

  test('an unsupported field leaves the size undefined rather than guessing', () => {
    // The harness's own guard then reports `koffi computed undefined`, which is
    // more precise than any size this shim could invent.
    const s = koffi.struct('Unsupported', { a: 'some_unknown_type' })
    expect(s.size).toBeUndefined()
  })

  test('pointer and array descriptors report their own kinds', () => {
    expect(koffi.pointer('void').kind).toBe('pointer')
    expect(koffi.array('uint16', 3).kind).toBe('array')
  })
})

describe('decoding honours the computed offsets (not a guessed walk)', () => {
  test('PROCESS_INFORMATION decodes pointers as bigint/null and ids as numbers', () => {
    const s = processInformation()
    const bytes = new Uint8Array(s.size)
    const view = new DataView(bytes.buffer)
    view.setBigUint64(0, 0x1234n, true) // hProcess
    view.setBigUint64(8, 0n, true) // hThread → null pointer
    view.setUint32(16, 4242, true) // dwProcessId
    view.setUint32(20, 7, true) // dwThreadId

    const decoded = koffi.decode(bytes, s) as Record<string, unknown>
    expect(decoded.hProcess).toBe(0x1234n)
    expect(decoded.hThread).toBeNull()
    expect(decoded.dwProcessId).toBe(4242)
    expect(decoded.dwThreadId).toBe(7)
  })

  test('the offset+type overload fails loud instead of reading from offset 0', () => {
    const bytes = new Uint8Array(8)
    // @ts-expect-error -- intentionally exercising the unsupported overload
    expect(() => koffi.decode(bytes, 4, 'uint32')).toThrow(/not implemented/)
  })
})

describe('drift guards', () => {
  const harness = join(process.cwd(), '..', 'deepseek-harness', 'packages', 'subprocess', 'win32-process', 'src', 'ffi.ts')
  const skip = !existsSync(harness)

  test.skipIf(skip)('the harness still declares exactly the fields mirrored above', () => {
    const source = readFileSync(harness, 'utf8')
    for (const field of Object.keys(startupInfoW().fields)) {
      expect(source).toContain(`${field}:`)
    }
    for (const field of Object.keys(processInformation().fields)) {
      expect(source).toContain(`${field}:`)
    }
  })

  test.skipIf(skip)('the harness still asserts the sizes this shim computes', () => {
    const abi = readFileSync(join(process.cwd(), '..', 'deepseek-harness', 'packages', 'subprocess', 'win32-process', 'src', 'abi.ts'), 'utf8')
    expect(abi).toContain('STARTUPINFOW_SIZE = 104')
    expect(abi).toContain('PROCESS_INFORMATION_SIZE = 24')
  })
})

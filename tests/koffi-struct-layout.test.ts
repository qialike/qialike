/**
 * The koffi shim's native memory codec (P4-step2).
 *
 * P4-step1 proved the shim's *layout* (`.size` / `.offsets`). This file covers
 * what P4-step2 added on top: `alloc` / `free`, `encode`, the
 * `decode(buffer, offset, type)` overload, `address` / `sizeof`, and marshalling
 * a whole struct instance into a `koffi.pointer(<struct>)` argument.
 *
 * Why the assertions are written against BYTES as well as round trips: a codec
 * that is wrong in the same way in both directions round-trips perfectly. The
 * `PROCESS_INFORMATION` cases therefore read the raw buffer with a DataView at
 * the offsets `abi.ts` pins on the native side (pointer at 0, id at 16), and the
 * `STARTUPINFOW` case pins `cb` at 0, `dwFlags` at 60, and the three std handles
 * at 80/88/96 — the exact standard-handle triple `CreateProcessAsUserW` reads.
 *
 * The last two groups need the Win32 heap, because that is what backs
 * `koffi.alloc` (a JavaScript buffer's `ptr()` is not a trustworthy native
 * address — see the shim's `allocateBytes`), so they run on Windows only; every
 * other group is platform-independent.
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

/** The raw bytes behind an allocation, for wire-level assertions. */
function bytesOf(address: unknown, length: number): DataView {
  const bytes = koffi.decode(address, undefined) as Uint8Array
  return new DataView(bytes.buffer, bytes.byteOffset, Math.min(length, bytes.byteLength))
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

  test('a char16 array member is an inline UTF-16 buffer, two bytes per unit', () => {
    const s = koffi.struct('S7', { a: 'uint32', name: koffi.array('char16', 4) })
    expect(s.offsets).toEqual({ a: 0, name: 4 })
    expect(s.size).toBe(12)
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

  test('the offset+type overload reads from that offset', () => {
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setUint32(4, 0xdeadbeef, true)
    expect(koffi.decode(bytes, 4, 'uint32')).toBe(0xdeadbeef)
    expect(koffi.decode(bytes, 0, 'uint32')).toBe(0)
  })

  test('an offset pointer read decodes to a bigint, and a null to null', () => {
    const bytes = new Uint8Array(16)
    new DataView(bytes.buffer).setBigUint64(8, 0x5a5an, true)
    expect(koffi.decode(bytes, 8, koffi.pointer('void'))).toBe(0x5a5an)
    expect(koffi.decode(bytes, 0, koffi.pointer('void'))).toBeNull()
  })

  // Windows only, for the same reason as the block below: this case reads back
  // through `alloc`, which is a Win32 `HeapAlloc`, so it cannot run here. The
  // every-platform decode coverage is the `Uint8Array` overload above.
  test.skipIf(process.platform !== 'win32')('a char16 array decodes to a NUL-terminated string', () => {
    const s = koffi.struct('S8', { name: koffi.array('char16', 8) })
    const buffer = koffi.alloc(s, 1)
    koffi.encode(buffer, s, { name: 'qia' })
    expect(koffi.decode(buffer, s)).toEqual({ name: 'qia' })
    koffi.free(buffer)
  })
})

/**
 * The codec as `alloc`/`encode`/`free` actually present it. Windows only,
 * because `koffi.alloc` is a Win32 `HeapAlloc` — see the shim's `allocateBytes`
 * for why a JavaScript buffer cannot back a native address. `decode` from a
 * caller-supplied `Uint8Array` stays covered above on every platform.
 */
describe.skipIf(process.platform !== 'win32')('alloc, encode and free', () => {
  test('alloc zeroes the block and returns a non-null address', () => {
    const address = koffi.alloc('uint32', 4)
    expect(typeof address).toBe('bigint')
    expect(address).not.toBe(0n)
    expect(bytesOf(address, 16).getUint32(0, true)).toBe(0)
    // Zeroing is what lets a partially encoded STARTUPINFOW be passed straight
    // to CreateProcessAsUserW: every unnamed field must already be NULL.
    expect(bytesOf(address, 16).getUint32(12, true)).toBe(0)
    koffi.free(address)
  })

  test('alloc sizes a struct and an array of structs', () => {
    const s = processInformation()
    const one = koffi.alloc(s, 1)
    koffi.encode(one, s, { hProcess: 1n, hThread: 2n, dwProcessId: 3, dwThreadId: 4 })
    expect(bytesOf(one, 24).getUint32(16, true)).toBe(3)
    koffi.free(one)

    const two = koffi.alloc(s, 2)
    koffi.encode(two, 24, s, { hProcess: 5n, hThread: 6n, dwProcessId: 7, dwThreadId: 8 })
    expect(koffi.decode(two, 24, s)).toEqual({
      hProcess: 5n,
      hThread: 6n,
      dwProcessId: 7,
      dwThreadId: 8,
    })
    koffi.free(two)
  })

  test('sizeof reports the same bytes the layout computes', () => {
    expect(koffi.sizeof('void *')).toBe(8)
    expect(koffi.sizeof('uint32')).toBe(4)
    expect(koffi.sizeof(koffi.pointer('void'))).toBe(8)
    expect(koffi.sizeof(startupInfoW())).toBe(104)
  })

  test('address returns the allocation address it was given', () => {
    const address = koffi.alloc('uint8', 8)
    expect(koffi.address(address)).toBe(address)
    koffi.free(address)
  })

  test('encoding PROCESS_INFORMATION writes each field at its declared offset', () => {
    const s = processInformation()
    const address = koffi.alloc(s, 1)
    koffi.encode(address, s, { hProcess: 0xaaaan, hThread: 0xbbbbn, dwProcessId: 1234, dwThreadId: 5678 })
    const view = bytesOf(address, 24)
    expect(view.getBigUint64(0, true)).toBe(0xaaaan)
    expect(view.getBigUint64(8, true)).toBe(0xbbbbn)
    expect(view.getUint32(16, true)).toBe(1234)
    expect(view.getUint32(20, true)).toBe(5678)
    koffi.free(address)
  })

  test('encoding STARTUPINFOW writes cb, dwFlags and the three std handles where CreateProcessAsUserW reads them', () => {
    const s = startupInfoW()
    const address = koffi.alloc(s, 1)
    koffi.encode(address, s, {
      cb: 104,
      dwFlags: 0x100,
      hStdInput: 0x11n,
      hStdOutput: 0x22n,
      hStdError: 0x33n,
    })
    const view = bytesOf(address, 104)
    expect(view.getUint32(0, true)).toBe(104)
    expect(view.getUint32(60, true)).toBe(0x100)
    expect(view.getBigUint64(80, true)).toBe(0x11n)
    expect(view.getBigUint64(88, true)).toBe(0x22n)
    expect(view.getBigUint64(96, true)).toBe(0x33n)
    expect(koffi.decode(address, s)).toEqual({
      cb: 104,
      lpReserved: null,
      lpDesktop: null,
      lpTitle: null,
      dwX: 0,
      dwY: 0,
      dwXSize: 0,
      dwYSize: 0,
      dwXCountChars: 0,
      dwYCountChars: 0,
      dwFillAttribute: 0,
      dwFlags: 0x100,
      wShowWindow: 0,
      cbReserved2: 0,
      lpReserved2: null,
      hStdInput: 0x11n,
      hStdOutput: 0x22n,
      hStdError: 0x33n,
    })
    koffi.free(address)
  })

  test('a struct field that is a str16 carries a pointer, and a null stays null', () => {
    const s = koffi.struct('S9', { lpTitle: 'str16', flag: 'uint32' })
    const address = koffi.alloc(s, 1)
    koffi.encode(address, s, { lpTitle: 'qialike' })
    const view = bytesOf(address, 16)
    expect(view.getUint32(8, true)).toBe(0)
    const pointer = view.getBigUint64(0, true)
    expect(pointer).not.toBe(0n)
    // The string itself was copied into native memory, as UTF-16LE with a NUL.
    const text = new DataView(bytesOf(pointer, 16).buffer)
    expect(String.fromCharCode(text.getUint16(0, true), text.getUint16(2, true))).toBe('qi')
    expect(text.getUint16(14, true)).toBe(0)
    koffi.free(address)
  })

  test('a Buffer field encodes and decodes through its own offsets', () => {
    const bytes = new Uint8Array(12)
    koffi.encode(bytes, 4, 'uint32', 0x01020304)
    expect(koffi.decode(bytes, 4, 'uint32')).toBe(0x01020304)
    expect(bytes[4]).toBe(0x04)
    expect(bytes[7]).toBe(0x01)
  })

  test('free drops the shim’s own bookkeeping and tolerates a foreign address', () => {
    const address = koffi.alloc('uint32', 1)
    koffi.free(address)
    // A freed block is no longer addressable by the shim (it holds no reference).
    expect(() => koffi.decode(address, 'uint32')).toThrow()
    expect(() => koffi.free(undefined)).not.toThrow()
  })
})

describe.skipIf(process.platform !== 'win32')('arguments that need marshalling into native memory', () => {
  test('null is a NULL pointer for a pointer argument or pointer field', () => {
    const s = koffi.struct('S10', { p: koffi.pointer('void') })
    const address = koffi.alloc(s, 1)
    koffi.encode(address, s, { p: null })
    expect(bytesOf(address, 8).getBigUint64(0, true)).toBe(0n)
    koffi.free(address)
  })

  test('unsupported type spellings fail loud instead of guessing a width', () => {
    expect(() => koffi.alloc('some_unknown_type', 1)).toThrow(/unsupported type/)
    expect(() => koffi.sizeof('some_unknown_type')).toThrow(/unsupported type/)
  })
})

/**
 * Real Win32 calls through the shim. Windows only: every other group proves the
 * codec, and these prove the pieces the codec cannot — that bun:ffi accepts the
 * shim's `FFIType` mapping, that `koffi.load(null)` resolves a current-process
 * symbol, and that a struct pointer argument arrives intact in native code.
 */
describe.skipIf(process.platform !== 'win32')('real Win32 calls through the shim', () => {
  test('a bound kernel32 call returns a pointer-sized bigint', () => {
    const kernel32 = koffi.load('kernel32.dll')
    const getCurrentProcessId = kernel32.func('__stdcall', 'GetCurrentProcessId', 'uint32', [])
    const getStdHandle = kernel32.func('__stdcall', 'GetStdHandle', koffi.pointer('void'), ['int'])
    expect(Number(getCurrentProcessId())).toBe(process.pid)
    expect(typeof getStdHandle(-11)).toBe('bigint')
  })

  test('an out-parameter written by Win32 decodes through the shim', () => {
    const kernel32 = koffi.load('kernel32.dll')
    const getCurrentProcessId = kernel32.func('__stdcall', 'GetCurrentProcessId', 'uint32', [])
    const openProcess = kernel32.func('__stdcall', 'OpenProcess', koffi.pointer('void'), [
      'uint32', 'int', 'uint32',
    ])
    const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int', [koffi.pointer('void')])
    const handle = openProcess(0x0400, 0, getCurrentProcessId())
    expect(handle).not.toBe(0n)
    expect(closeHandle(handle)).toBe(1)
  })

  test('a struct instance reaches native code through a pointer-to-struct argument', () => {
    const kernel32 = koffi.load('kernel32.dll')
    const getCurrentProcessId = kernel32.func('__stdcall', 'GetCurrentProcessId', 'uint32', [])
    const pointer = koffi.pointer('void')
    const getProcessTimes = kernel32.func('__stdcall', 'GetProcessTimes', 'int', [
      pointer, pointer, pointer, pointer, pointer,
    ])
    const fileTime = koffi.struct('DSH_FILETIME', { dwLowDateTime: 'uint32', dwHighDateTime: 'uint32' })
    const openProcess = kernel32.func('__stdcall', 'OpenProcess', pointer, ['uint32', 'int', 'uint32'])
    const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int', [pointer])
    const handle = openProcess(0x0400, 0, getCurrentProcessId())
    const slots = [koffi.alloc(fileTime, 1), koffi.alloc(fileTime, 1), koffi.alloc(fileTime, 1), koffi.alloc(fileTime, 1)]
    try {
      // `GetProcessTimes` writes all four FILETIME out-parameters, so this
      // exercises both a struct-pointer argument and a native write into memory
      // the shim allocated. (This process has used CPU time, but on an idle host
      // the quad can still round to zero, so the assertion pins the write-back
      // shape rather than a magnitude.)
      expect(getProcessTimes(handle, ...slots)).toBe(1)
      const kernel = koffi.decode(slots[2], fileTime) as { dwLowDateTime: number; dwHighDateTime: number }
      const user = koffi.decode(slots[3], fileTime) as { dwLowDateTime: number; dwHighDateTime: number }
      for (const time of [kernel, user]) {
        expect(Number.isInteger(time.dwLowDateTime)).toBe(true)
        expect(Number.isInteger(time.dwHighDateTime)).toBe(true)
        expect(time.dwLowDateTime).toBeGreaterThanOrEqual(0)
        expect(time.dwHighDateTime).toBeGreaterThanOrEqual(0)
      }
    } finally {
      closeHandle(handle)
      for (const slot of slots) koffi.free(slot)
    }
  })

  test('koffi.load(null) resolves a current-process CRT symbol', () => {
    const process32 = koffi.load(null)
    const getOsfhandle = process32.func('__stdcall', 'uv_get_osfhandle', koffi.pointer('void'), ['int'])
    // fd 1 is this process's own stdout descriptor, so the CRT lookup is safe.
    const handle = getOsfhandle(1)
    expect(typeof handle).toBe('bigint')
    expect(handle).not.toBe(0n)
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

  test.skipIf(skip)('every koffi API the harness calls is implemented by this shim', () => {
    // The shim must cover the whole surface, because a missing member fails at
    // the call site inside a single-file binary with no fallback.
    const sources = [
      join(process.cwd(), '..', 'deepseek-harness', 'packages', 'subprocess', 'win32-process', 'src', 'ffi.ts'),
      join(process.cwd(), '..', 'deepseek-harness', 'packages', 'subprocess', 'win32-process', 'src', 'process.ts'),
      join(process.cwd(), '..', 'deepseek-harness', 'packages', 'sandbox', 'sandbox-windows-acl', 'src', 'ffi.ts'),
    ].filter((file) => existsSync(file))
    const used = new Set<string>()
    for (const file of sources) {
      // `(?<![\w./-])` — NOT a bare \b: 0.1.7-alpha.2 spells its internal import
      // `from './koffi.ts'`, whose file-name tail `koffi.ts` matched the old
      // pattern and reported a phantom missing member (`ts`). Only a real member
      // access counts, so nothing may precede the name except a non-identifier.
      for (const match of readFileSync(file, 'utf8').matchAll(/(?<![\w./-])koffi\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        used.add(match[1])
      }
    }
    expect(used.size).toBeGreaterThan(4)
    for (const member of used) {
      expect(typeof (koffi as Record<string, unknown>)[member]).toBe('function')
    }
  })
})

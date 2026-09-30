/**
 * Real process-level `flock(2)` for the session write lease.
 *
 * Why this exists: `apps/tui-bin/build.mjs` used to install a NO-OP stub in
 * place of `@deepseek-ai/node-addon-system/flock` (`tryLockExclusive` granted
 * immediately), on the harness's browser-worker assumption that one process
 * owns the store. A qialike host does NOT own the store: it shares `~/.dsh`
 * sessions with `dsh web` (and with a second qialike). With the no-op stub the
 * harness's `SessionWriteLease` never excluded anybody, so two hosts could
 * append the SAME log concurrently — the source of the observed `seq gap`
 * (duplicate/rewound seq) and `torn JSONL record` corruptions.
 *
 * The single-file binary cannot ship the harness's native addon, so the
 * primitive is obtained at runtime, in order:
 *
 *  1. `bun:ffi` → `dlopen` libc → `flock(fd, LOCK_EX | LOCK_NB)` plus
 *     `__errno_location` for the failure code. The Bun SEA runtime is the only
 *     runtime this product supports, and `apps/tui-bin/stub/koffi.js` already
 *     proves out `bun:ffi` inside a compiled binary.
 *  2. the harness's own native addon (`@deepseek-ai/node-addon-system-<platform>-<arch>`,
 *     `bin/{glibc,musl}/system.node`) — the exact lookup the harness performs in
 *     `native/system/packages/entry/lib/flock.js`. This is what makes the module
 *     work under plain Node (unit tests, `tsc`-driven tooling).
 *  3. neither available (Windows, or a stripped runtime): grant and warn ONCE.
 *     Granting preserves the previous behaviour for hosts that genuinely cannot
 *     lock, but it is now visible in the transcript instead of silent.
 *
 * The contract matches the harness's own entry so this file can be installed as
 * the `/flock` subpath stub: resolve on acquisition, reject with `code`
 * `EAGAIN`/`EWOULDBLOCK` on contention, reject with the syscall's code
 * otherwise. The caller keeps the descriptor open — closing it (or process
 * death) releases the lock, which is why no separate release function exists.
 *
 * @module @qialike/qialike-app/flock
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { getSystemErrorName } from 'node:util'

/** `flock(2)` operation bits. */
const LOCK_EX = 2
const LOCK_NB = 4

/** One locking backend: `tryLock` resolves `0` on acquisition, else an errno. */
export interface FlockBinding {
  readonly backend: 'ffi' | 'addon'
  tryLock(fd: number): Promise<number>
}

/** The `bun:ffi` surface this module uses (typed locally: `bun:ffi` has no @types). */
interface FfiModule {
  dlopen(
    path: string,
    definition: Record<string, { args: number[]; returns: number }>,
  ): { symbols: Record<string, (...args: number[]) => number> }
  FFIType: { i32: number; ptr: number }
  toArrayBuffer(pointer: number | bigint, byteOffset: number, byteLength: number): ArrayBuffer
}

/** Linux musl sonames are architecture-spelled differently from `process.arch`. */
function muslArch(): string {
  if (process.arch === 'x64') return 'x86_64'
  if (process.arch === 'arm64') return 'aarch64'
  return process.arch
}

/**
 * libc sonames worth trying, most specific first. A wrong soname throws from
 * `dlopen` and the loop moves on, so this list is a probe, not a decision.
 * @returns candidate library names for the running platform.
 */
function libcCandidates(): readonly string[] {
  if (process.platform === 'darwin') return ['libSystem.B.dylib']
  if (process.platform !== 'linux') return []
  let glibc = false
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
    glibc = Boolean(report?.header?.glibcVersionRuntime)
  } catch { /* no report available: fall through to the musl names */ }
  if (glibc) return ['libc.so.6']
  return [`libc.musl-${muslArch()}.so.1`, `libc.musl-${process.arch}.so.1`, 'libc.so']
}

/** Whether the running runtime exposes `bun:ffi`. */
async function ffiModule(): Promise<FfiModule | undefined> {
  try {
    // A computed specifier keeps `bun:ffi` out of TypeScript's module graph
    // (`tsc -p tsconfig.typecheck.json` has no Bun types) and out of esbuild's
    // static resolution when the tui-app lib is bundled.
    const specifier = 'bun:ffi'
    const loaded = await import(specifier)
    const ffi = loaded as unknown as FfiModule
    return typeof ffi?.dlopen === 'function' ? ffi : undefined
  } catch {
    return undefined
  }
}

/**
 * Lock through `bun:ffi` + libc.
 * @returns the backend, or undefined when FFI/libc is unavailable.
 */
async function loadFfiBinding(): Promise<FlockBinding | undefined> {
  const ffi = await ffiModule()
  if (ffi === undefined) return undefined
  for (const soname of libcCandidates()) {
    try {
      const lib = ffi.dlopen(soname, {
        flock: { args: [ffi.FFIType.i32, ffi.FFIType.i32], returns: ffi.FFIType.i32 },
        __errno_location: { args: [], returns: ffi.FFIType.ptr },
      })
      const flock = lib.symbols.flock
      const errnoLocation = lib.symbols.__errno_location
      if (typeof flock !== 'function' || typeof errnoLocation !== 'function') continue
      const readErrno = (): number => new Int32Array(ffi.toArrayBuffer(errnoLocation(), 0, 4))[0] ?? 0
      return {
        backend: 'ffi',
        tryLock: async (fd: number): Promise<number> => {
          const result = flock(fd, LOCK_EX | LOCK_NB)
          return result === 0 ? 0 : readErrno()
        },
      }
    } catch { /* wrong soname or missing symbol: try the next candidate */ }
  }
  return undefined
}

/**
 * Lock through the harness's native addon, mirroring its own entry point.
 * @returns the backend, or undefined when the platform package is absent.
 */
async function loadAddonBinding(): Promise<FlockBinding | undefined> {
  const { platform, arch } = process
  if (platform !== 'linux' && platform !== 'darwin') return undefined
  try {
    const require = createRequire(import.meta.url)
    const manifest = require.resolve(`@deepseek-ai/node-addon-system-${platform}-${arch}/package.json`)
    let filename = 'system.node'
    if (platform === 'linux') {
      const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
      filename = join(report?.header?.glibcVersionRuntime ? 'glibc' : 'musl', filename)
    }
    const binding = require(join(dirname(manifest), 'bin', filename)) as {
      tryLock(fd: number, callback: (errno: number) => void): void
    }
    return {
      backend: 'addon',
      tryLock: (fd: number): Promise<number> => new Promise((resolve) => { binding.tryLock(fd, resolve) }),
    }
  } catch {
    return undefined
  }
}

let resolved: Promise<FlockBinding | undefined> | undefined
let warned = false

/** Resolve (once) whichever backend this runtime can offer. */
function resolveBinding(): Promise<FlockBinding | undefined> {
  resolved ??= (async () => (await loadFfiBinding()) ?? await loadAddonBinding())()
  return resolved
}

/**
 * Attempt an exclusive, non-blocking `flock(2)` on the caller's descriptor.
 *
 * The descriptor stays owned by the caller: keep it open until the lock is no
 * longer wanted, because closing it (or exiting the process) is what releases
 * the lock. On a host with no locking backend this resolves WITHOUT locking and
 * prints one warning, so a lease-less session is diagnosable rather than silent.
 *
 * @param fd - open file descriptor of the session's `session.lock`.
 * @returns nothing; the lock is held on resolution.
 * @throws an error carrying `code` (`EAGAIN`/`EWOULDBLOCK` on contention) and
 *   `errno` when the syscall fails.
 */
export async function tryLockExclusive(fd: number): Promise<void> {
  const binding = await resolveBinding()
  if (binding === undefined) {
    if (!warned) {
      warned = true
      process.stderr.write(
        'qialike: no flock backend (bun:ffi failed and the harness native addon is absent) — '
        + 'the session write lease is advisory only; another host writing the same session is not excluded\n',
      )
    }
    return
  }
  const errno = await binding.tryLock(fd)
  if (errno === 0) return
  const code = getSystemErrorName(errno > 0 ? -errno : errno)
  throw Object.assign(new Error(`${code}: flock failed`), { code, errno, syscall: 'flock' })
}

/**
 * Whether a failed lock means "somebody else holds it" (as opposed to a broken
 * descriptor or an unsupported platform).
 * @param error - the rejection from {@link tryLockExclusive}.
 * @returns true for `EAGAIN`/`EWOULDBLOCK`.
 */
export function isFlockContention(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  return code === 'EAGAIN' || code === 'EWOULDBLOCK'
}

/**
 * Which backend this runtime resolved to. Diagnostics and tests only.
 * @returns the backend name, or 'unavailable'.
 */
export async function flockBackend(): Promise<'ffi' | 'addon' | 'unavailable'> {
  return (await resolveBinding())?.backend ?? 'unavailable'
}

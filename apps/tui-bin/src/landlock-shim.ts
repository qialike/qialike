/**
 * qialike — the Landlock launcher shim.
 *
 * The DeepSeek Harness reaches Linux confinement through
 * `@deepseek-ai/node-addon-system/landlock-run`, whose real implementation is a
 * ~300-line statically linked musl C executable (`native/system/packages/entry/
 * src/main.c`). A `bun build --compile` single file cannot carry that artifact,
 * so qialike previously stubbed the module to report `unusable` — which forced
 * Linux onto the **bwrap** rung and made bubblewrap a hard host requirement.
 *
 * This module is the replacement: the same launcher, implemented over
 * `bun:ffi` and re-executed as a subcommand of the qialike binary itself. It
 * applies a Landlock ruleset to its own process, then spawns the wrapped
 * command; Landlock restrictions are inherited across `fork`/`execve`, so the
 * command and every descendant stay confined without `execve` in-process.
 *
 * It reproduces the launcher's CLI contract verbatim, because the harness
 * classifies runner failure and denial from that exact dialect:
 *  - every launcher-level failure prints `landlock-run: <detail>` on stderr
 *    and exits {@link LAUNCHER_FAILURE_EXIT} (125) WITHOUT running the command;
 *  - an older-ABI run prints `landlock-run: partial enforcement (older Landlock
 *    ABI)` — an informational line the harness excludes before fatal matching;
 *  - `--probe` enforces a maximal ruleset for real and reports
 *    `landlock: fully enforced` / `landlock: partially enforced (older ABI)`.
 *
 * @module @qialike/qialike/landlock-shim
 */

import { dlopen, FFIType } from 'bun:ffi'
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'

/** The launcher's file name, re-exported by the module the harness imports. */
export const LAUNCHER_BIN = 'landlock-run'

/**
 * Exit code for every launcher-level failure. After a successful spawn the
 * wrapped command may itself return 125, so the harness also requires a
 * matching `landlock-run:` fatal line to attribute launcher failure.
 */
export const LAUNCHER_FAILURE_EXIT = 125

/** Fatal-diagnostic prefix; the harness matches `${LAUNCHER_BIN}: `. */
const FATAL_PREFIX = `${LAUNCHER_BIN}: `

/** The informational line the harness removes before fatal matching. */
const PARTIAL_NOTICE = `${FATAL_PREFIX}partial enforcement (older Landlock ABI)`

// ---- Landlock UAPI (mirrors the kernel header and the C launcher) ----

const SYS_LANDLOCK_CREATE_RULESET = 444n
const SYS_LANDLOCK_ADD_RULE = 445n
const SYS_LANDLOCK_RESTRICT_SELF = 446n
const LANDLOCK_CREATE_RULESET_VERSION = 1
const LANDLOCK_RULE_PATH_BENEATH = 1
const PR_SET_NO_NEW_PRIVS = 38
const O_PATH = 0o10000000
const O_CLOEXEC = 0o2000000

const LL_FS_EXECUTE = 1n << 0n
const LL_FS_WRITE_FILE = 1n << 1n
const LL_FS_READ_FILE = 1n << 2n
const LL_FS_READ_DIR = 1n << 3n
const LL_FS_REMOVE_DIR = 1n << 4n
const LL_FS_REMOVE_FILE = 1n << 5n
const LL_FS_MAKE_CHAR = 1n << 6n
const LL_FS_MAKE_DIR = 1n << 7n
const LL_FS_MAKE_REG = 1n << 8n
const LL_FS_MAKE_SOCK = 1n << 9n
const LL_FS_MAKE_FIFO = 1n << 10n
const LL_FS_MAKE_BLOCK = 1n << 11n
const LL_FS_MAKE_SYM = 1n << 12n
const LL_FS_REFER = 1n << 13n // ABI 2
const LL_FS_TRUNCATE = 1n << 14n // ABI 3
const LL_FS_IOCTL_DEV = 1n << 15n // ABI 5

/** Bits 0..12: every ABI-1 access, nothing newer. */
const LL_ABI1_MASK = LL_FS_REFER - 1n

/** Newest ABI this build knows; negotiation scales the actual mask down. */
const MAX_ABI = 5

/**
 * The ABI the PATH-based workspace-write promise needs: `REFER` (ABI 2) and
 * `TRUNCATE` (ABI 3) are the rights a path grant actually relies on. `MAX_ABI`
 * is what the launcher can USE, not what the policy NEEDS — the only gap above
 * this floor is ABI 5's `LANDLOCK_ACCESS_FS_IOCTL_DEV`, which device ioctl
 * restriction a path-based write policy never claimed. Reporting "partial" for
 * that gap printed a line on every confined run (and every tool result's
 * stderr) without describing a weaker boundary.
 */
const REQUIRED_ABI = 3

// `syscall()` is variadic and each Landlock call has a different argument
// shape, so each call site gets its own declared signature over its own
// dlopen handle (the library itself is opened once by Bun's loader).
const createRuleset = dlopen('libc.so.6', {
  syscall: { args: [FFIType.i64, FFIType.ptr, FFIType.u64, FFIType.u32], returns: FFIType.i64 },
}).symbols.syscall
const addRule = dlopen('libc.so.6', {
  syscall: { args: [FFIType.i64, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i64 },
}).symbols.syscall
const restrictSelf = dlopen('libc.so.6', {
  syscall: { args: [FFIType.i64, FFIType.i32, FFIType.u32], returns: FFIType.i64 },
}).symbols.syscall
const { prctl, open, close } = dlopen('libc.so.6', {
  prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  open: { args: [FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
}).symbols

/** The filesystem accesses the running kernel's ABI can govern. */
function fsMaskForAbi(abi: number): bigint {
  let mask = LL_ABI1_MASK
  if (abi >= 2) mask |= LL_FS_REFER
  if (abi >= 3) mask |= LL_FS_TRUNCATE
  if (abi >= 5) mask |= LL_FS_IOCTL_DEV
  return mask
}

/**
 * The running kernel's Landlock ABI, or `undefined` when the kernel has the
 * syscalls but refuses to enforce (ENOSYS: built without Landlock;
 * EOPNOTSUPP: built with it disabled). Both mean "not enforceable".
 */
function detectAbi(): number | undefined {
  const abi = createRuleset(SYS_LANDLOCK_CREATE_RULESET, null, 0n, LANDLOCK_CREATE_RULESET_VERSION)
  return abi < 0n ? undefined : Number(abi)
}

/** Add one path-beneath rule; throws on any launcher-level failure. */
function addPathRule(rulesetFd: number, path: string, access: bigint): void {
  const pathFd = open(Buffer.from(`${path}\0`, 'utf8'), O_PATH | O_CLOEXEC)
  if (pathFd < 0) {
    // Fail closed on an unopenable grant root: running under a profile the
    // caller did not get is worse than refusing.
    throw new Error(`cannot open rule path: ${path}`)
  }
  // The kernel rejects directory-only accesses on a non-directory rule
  // (EINVAL), so a file grant keeps only the file-compatible bits — how the
  // `--rw /dev/null` grant works.
  let isDirectory = false
  try {
    isDirectory = statSync(path).isDirectory()
  } catch {
    // The open above succeeded, so a stat failure only means the entry vanished
    // between the two calls; treat it as a non-directory (the narrower grant).
    isDirectory = false
  }
  const effective = isDirectory
    ? access
    : access & (LL_FS_EXECUTE | LL_FS_WRITE_FILE | LL_FS_READ_FILE | LL_FS_TRUNCATE | LL_FS_IOCTL_DEV)

  // struct landlock_path_beneath_attr is __attribute__((packed)): u64 + s32 = 12 bytes.
  const attr = Buffer.alloc(12)
  attr.writeBigUInt64LE(effective, 0)
  attr.writeInt32LE(pathFd, 8)
  const rc = addRule(SYS_LANDLOCK_ADD_RULE, rulesetFd, LANDLOCK_RULE_PATH_BENEATH, attr, 0)
  close(pathFd)
  if (rc !== 0n) throw new Error(`landlock ruleset error for ${path}`)
}

/** One confined run's grant set, as the launcher CLI expresses it. */
export interface LauncherGrants {
  readonly readOnly: readonly string[]
  readonly readWrite: readonly string[]
}

/** Install the ruleset on this process. Returns whether enforcement is per-ABI partial. */
export function restrictSelfWith(grants: LauncherGrants): { partial: boolean; abi: number } {
  const abi = detectAbi()
  if (abi === undefined) {
    throw new Error('landlock is not enforced by this kernel (ABI unsupported or disabled)')
  }
  const partial = abi < MAX_ABI
  const handled = fsMaskForAbi(Math.min(abi, MAX_ABI))

  const attr = Buffer.alloc(8)
  attr.writeBigUInt64LE(handled, 0)
  const fd = createRuleset(SYS_LANDLOCK_CREATE_RULESET, attr, 8n, 0)
  if (fd < 0n) throw new Error('landlock ruleset error')
  const rulesetFd = Number(fd)

  // `--ro` grants the read side (the wrapped `bash` and everything it spawns
  // must stay executable); `--rw` grants every access the ABI can govern.
  const readSide = LL_FS_EXECUTE | LL_FS_READ_FILE | LL_FS_READ_DIR
  for (const path of grants.readOnly) addPathRule(rulesetFd, path, readSide & handled)
  for (const path of grants.readWrite) addPathRule(rulesetFd, path, handled)

  // Mandatory before an unprivileged restrict; also neutralizes setuid/setgid
  // escalation inside the sandbox.
  if (prctl(PR_SET_NO_NEW_PRIVS, 1n, 0n, 0n, 0n) !== 0) throw new Error('landlock ruleset error')
  const rc = restrictSelf(SYS_LANDLOCK_RESTRICT_SELF, rulesetFd, 0)
  close(rulesetFd)
  if (rc !== 0n) throw new Error('landlock ruleset error')
  return { partial, abi }
}

/** Parsed launcher command line. */
interface ParsedCli {
  readonly probe: boolean
  readonly grants: LauncherGrants
  readonly command: string[]
}

/** Parse `[--probe] | [--ro <p>]... [--rw <p>]... -- <argv>...`. */
export function parseLauncherArgs(args: readonly string[]): ParsedCli {
  const readOnly: string[] = []
  const readWrite: string[] = []
  let index = 0
  let probe = false

  for (; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--') { index++; break }
    if (arg === '--probe') { probe = true; continue }
    if (arg === '--ro' || arg === '--rw') {
      const value = args[++index]
      if (value === undefined) throw new Error(`usage error: ${arg} requires a path`)
      ;(arg === '--ro' ? readOnly : readWrite).push(value)
      continue
    }
    throw new Error(`usage error: unknown argument ${JSON.stringify(arg)}`)
  }

  return { probe, grants: { readOnly, readWrite }, command: args.slice(index) }
}

/** Print a launcher-level fatal diagnostic and exit with the reserved code. */
function fail(message: string): never {
  process.stderr.write(`${FATAL_PREFIX}${message}\n`)
  process.exit(LAUNCHER_FAILURE_EXIT)
}

/** Forward the four terminating signals to the confined child. */
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const

/**
 * Run the launcher. Never returns: every path exits the process, so the caller
 * in `main.ts` can hand the whole command line over without a return value to
 * handle.
 *
 * @param args - the launcher's arguments, i.e. `process.argv.slice(2)`.
 */
export function runLandlockLauncher(args: readonly string[]): void {
  let cli: ParsedCli
  try {
    cli = parseLauncherArgs(args)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  if (cli.probe) {
    // The functional probe: actually restrict THIS short-lived process, because
    // a `--version`-style check would miss a kernel that has the syscalls but
    // refuses enforcement.
    try {
      const { partial } = restrictSelfWith({ readOnly: ['/'], readWrite: [] })
      process.stdout.write(`landlock: ${partial ? 'partially enforced (older ABI)' : 'fully enforced'}\n`)
      process.exit(0)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }

  try {
    const { partial, abi } = restrictSelfWith(cli.grants)
    // Quiet unless the host is below what the policy needs; `partial` (ABI < MAX_ABI) is what `--probe` still reports, so the harness's enforcement classification is unchanged.
    if (partial && abi < REQUIRED_ABI) process.stderr.write(`${PARTIAL_NOTICE}\n`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  const [program, ...rest] = cli.command
  if (program === undefined) fail('usage error: no command given')

  const child = spawn(program, rest, { stdio: 'inherit', env: process.env })
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => {
      try { child.kill(signal) } catch { /* the child already settled */ }
    })
  }
  child.on('error', (error: NodeJS.ErrnoException) => fail(`exec failed: ${error.message}`))
  child.on('exit', (code, signal) => {
    // Mirror a signal death by re-raising it, so the caller's wait status
    // carries the same signal the confined command died from.
    if (signal !== null) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? LAUNCHER_FAILURE_EXIT)
  })
}

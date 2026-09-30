/**
 * qialike — the `landlock-run` module the DeepSeek Harness imports.
 *
 * Replaces the previous stub (which reported `unusable` and pushed Linux onto
 * the bubblewrap rung). This one is real: the launcher itself is implemented in
 * `apps/tui-bin/src/landlock-shim.ts` over `bun:ffi`, and `launcherPath()`
 * points at the qialike binary, which re-enters that shim from its own argv.
 *
 * The two halves must agree on the launcher CLI contract, so this file owns
 * only the argv spelling and the probe report parsing; the shim owns the
 * enforcement and the diagnostics. See `landlock-shim.ts` for the contract.
 *
 * @module qialike/landlock-run
 */

import { spawnSync } from 'node:child_process'

/** The launcher binary's file name inside the harness's platform packages. */
export const LAUNCHER_BIN = 'landlock-run'

/**
 * The exit code for every launcher-level failure. Part of the CLI contract:
 * after a successful spawn the wrapped command may also return 125, so the
 * harness additionally requires a matching `landlock-run:` fatal line.
 */
export const LAUNCHER_FAILURE_EXIT = 125

/**
 * Absolute path of the launcher to probe and exec. The single-file qialike
 * binary IS the launcher: its entry dispatches the reserved `--ro` / `--rw` /
 * `--probe` arguments to the embedded shim before the TUI owns the command
 * line. Never cwd-relative — a spawnable relative path here would hand the
 * working directory control over which binary confines a process.
 * @returns the qialike executable's absolute path.
 */
export function launcherPath() {
  return process.execPath
}

/**
 * The launcher grant arguments for one set of filesystem grants — everything
 * before the `--` argv separator. Read-only roots first, in the caller's order.
 * @param grants - the read-only and read-write roots to allow.
 * @returns the `--ro <path>` / `--rw <path>` argument list.
 */
export function grantArgs(grants) {
  return [
    ...(grants.readOnly ?? []).flatMap((root) => ['--ro', root]),
    ...(grants.readWrite ?? []).flatMap((root) => ['--rw', root]),
  ]
}

/**
 * Functional probe: `--probe` builds and enforces a maximal ruleset in a
 * short-lived child and exits 0 only when the running kernel actually enforces
 * it. A failed or timed-out spawn (no Landlock, kernel without the syscalls, a
 * disabled LSM) probes `unusable`, which is the single availability signal the
 * harness consults.
 * @param launcher - the launcher path to probe; defaults to this executable.
 * @param options - `timeoutMs` bounds the probe child (default 2000).
 * @returns `full`, `partial`, or `unusable`.
 */
export function probe(launcher = launcherPath(), options = {}) {
  const result = spawnSync(launcher, ['--probe'], {
    timeout: options.timeoutMs ?? 2000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.status !== 0) return 'unusable'
  return /partially enforced/.test(result.stdout ?? '') ? 'partial' : 'full'
}

export default ''

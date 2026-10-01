/**
 * qialike — the `koffi` a single-file build is allowed to use, carried as a
 * STATIC import instead of a runtime one.
 *
 * The harness reaches koffi through `@deepseek-ai/dsh-lazy-require`, whose whole
 * job is a runtime `createRequire(parentURL)(specifier)`. Inside a `bun build
 * --compile` single file that call cannot be answered by the bundle: it leaves
 * for the real filesystem, and Bun anchors the walk at the process's CURRENT
 * WORKING DIRECTORY rather than at the executable. Measured with a probe of the
 * same shape (bun 1.4.2):
 *
 *  - an artifact started from a directory that carries `node_modules/koffi`
 *    resolves; the SAME artifact started anywhere else throws
 *    `Cannot find module 'koffi'`;
 *  - MOVING the binary to another directory changes nothing — with the shim in
 *    the cwd a relocated copy still resolves, and the in-tree copy fails once
 *    the cwd has none. The executable's own location is not what decides.
 *
 * Windows pays for that on the FIRST confined shell call, because the ACL rung
 * mints its restricted token through koffi: the runner never starts, the tool
 * layer reports the sandbox unavailable (fail-closed under `workspace-write`),
 * and the shell tool is unusable. The artifact therefore only worked when it
 * happened to be launched from a tree that carries the shim — a build output,
 * never a release, since `dist/*.zip` is written with `zip -j` (the bare exe).
 *
 * This module carries the shim as a static import so the bundler INLINES it and
 * nothing is left to resolve at runtime. The build points the loader's `koffi`
 * specifier here (`patchKoffiLazyResolution` in `apps/tui-bin/build.mjs`); every
 * other specifier keeps the harness's caller-relative resolution untouched, and
 * a checkout that loads the real native koffi is unaffected.
 *
 * It lives in the app package because that is the one module surface BOTH the
 * patched harness package and the launcher can import by name — the same
 * constraint that puts `windows-acl-mode` here.
 *
 * @module @qialike/qialike-app/koffi-shim
 */

import * as koffi from 'koffi'

/**
 * The koffi binding table, shaped exactly like `require('koffi')`.
 *
 * A namespace import is the faithful stand-in: the CJS/ESM interop value Bun
 * hands back for `require('koffi')` also carries `default` alongside the named
 * API, and every harness call site only ever reads members off it
 * (`koffi.load`, `koffi.pointer`, `koffi.struct`, …). The build's shim exports
 * the same members as the native addon, so no call site can tell the two apart.
 */
export const KOFFI_MODULE: unknown = koffi

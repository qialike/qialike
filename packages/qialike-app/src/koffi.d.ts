/**
 * Types for the bare `koffi` specifier, which this package imports in
 * `koffi-shim.ts`.
 *
 * koffi ships as a native N-API addon with no declarations, and the single-file
 * build replaces it with a pure-JS `bun:ffi` shim (`apps/tui-bin/stub/koffi.js`,
 * installed as `node_modules/koffi` by `installKoffiShim`). The two are the same
 * shape: a binding table whose members are FFI surface — opaque pointers, struct
 * descriptors, callbacks. What the compiler must know here is that the SPECIFIER
 * resolves; naming every member would be a second, drifting copy of an API this
 * package only re-exports.
 *
 * @module @qialike/qialike-app/koffi
 */

declare module 'koffi' {
  /** The binding table `require('koffi')` returns; members are FFI surface. */
  const koffi: Record<string, unknown>
  export default koffi
  export { koffi }
}

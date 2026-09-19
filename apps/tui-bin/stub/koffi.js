/**
 * A minimal, pure-JS `koffi` replacement built on `bun:ffi` for the single-file
 * qialike bundle.
 *
 * Real koffi is a native N-API addon (its `.node` ships in the
 * `@koromix/koffi-win32-x64` optional dependency), which a `bun build
 * --compile` single file cannot embed. The harness loads koffi lazily on
 * Windows to drive durable file/session operations (`MoveFileExW`,
 * `GetFileSecurityW`, `ReplaceFileW`, ...) and process-table inspection.
 *
 * This shim implements exactly the koffi API surface the bundled harness code
 * touches on Windows, backed by Bun's built-in FFI (`bun:ffi`). Unsupported
 * constructs fail loud with a clear message instead of silently no-op'ing.
 *
 * Struct layout is REAL Win64 layout (member alignment, padding, and a total
 * rounded up to the struct's alignment), because the Windows FFI modules assert
 * two struct sizes at MODULE SCOPE: a wrong layout would break the import on
 * every platform, including the Linux/macOS builds that never call it.
 *
 * Still unimplemented, and deliberately loud about it (P4-step2, which needs a
 * Windows host): `alloc` / `encode`, the `decode(buffer, offset, type)`
 * overload, and marshalling a pointer-to-struct argument through `bind`.
 *
 * @module qialike/koffi-shim
 */

import { dlopen, FFIType, ptr } from 'bun:ffi'

/** Map a koffi primitive/pointer type name to a bun:ffi FFIType. */
function ffiType(name) {
  switch (name) {
    case 'void': return FFIType.void
    case 'bool': return FFIType.bool
    case 'char': case 'int8': case 'int8_t': return FFIType.i8
    case 'uchar': case 'uint8': case 'uint8_t': return FFIType.u8
    case 'short': case 'int16': case 'int16_t': return FFIType.i16
    case 'ushort': case 'uint16': case 'uint16_t': return FFIType.u16
    case 'int': case 'int32': case 'int32_t': return FFIType.i32
    case 'uint': case 'uint32': case 'uint32_t': return FFIType.u32
    case 'long': case 'int64': case 'int64_t': return FFIType.i64
    case 'ulong': case 'uint64': case 'uint64_t': return FFIType.u64
    case 'intptr_t': case 'ssize_t': return FFIType.isize
    case 'uintptr_t': case 'size_t': return FFIType.usize
    case 'float': case 'float32': return FFIType.f32
    case 'double': case 'float64': return FFIType.f64
    default: return FFIType.ptr // pointer-like custom types default to pointer
  }
}

/** Pointer-like argument kinds (passed as a memory buffer / null). */
function isPointerKind(kind) {
  return kind.endsWith('*') || kind === 'void' || kind === 'cstring'
}

/** Split a koffi C-style declaration into abi + name + args + return. */
function parseDeclaration(decl) {
  const abiMatch = decl.match(/__stdcall|__cdecl|__fastcall|__thiscall/)
  const abi = abiMatch ? abiMatch[0] : '__cdecl'
  const body = decl.replace(/\b__stdcall\b|\b__cdecl\b|\b__fastcall\b|\b__thiscall\b/g, '')
  const nameMatch = body.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
  if (!nameMatch) throw new Error(`koffi shim: cannot parse declaration "${decl}"`)
  const name = nameMatch[1]
  const ret = body.slice(0, body.indexOf(name)).trim()
  const open = body.indexOf('(')
  const close = body.lastIndexOf(')')
  const rawArgs = body.slice(open + 1, close === -1 ? body.length : close).split(',')
  const args = rawArgs
    .map((a) => a.trim())
    .filter((a) => a.length > 0)
    .map((a) => {
      // strip `_Out_`/`_In_`/`_Inout_` SAL annotations and const qualifiers
      return a.replace(/\b_(?:In|Out|Inout|In_opt|Out_opt|Inout_opt|Reserved)_?\b/g, '').trim()
    })
  return { abi, name, ret, args }
}

/** A wrapper descriptor for pointer-typed FFI values passed through calls. */
class PtrValue {
  constructor(addr) {
    this.__ptr = addr
  }
}

/** Normalize one koffi arg type expression to a bun:ffi arg spec + a marshaller. */
function argSpec(kind) {
  // strip const qualifiers, SAL annotations, and any trailing parameter name
  let clean = kind
    .replace(/\b_(?:In|Out|Inout|In_opt|Out_opt|Inout_opt|Reserved)_?\b/g, '')
    .replace(/^const\s+/, '')
    .replace(/\s+$/, '')
    .trim()
  // pointer args: "const char16_t *path" -> "char16_t*"; "uint32_t *needed" -> "uint32_t*"
  const ptrMatch = clean.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\*\s*[A-Za-z_][A-Za-z0-9_]*$/)
  if (ptrMatch) clean = `${ptrMatch[1]}*`
  // char16_t * (UTF-16 string) and const char16_t *
  if (clean === 'char16_t*' || clean === 'str16') {
    return {
      ffiArgs: FFIType.ptr,
      toFfi: (value) => {
        if (value === null || value === undefined) return 0
        const str = String(value)
        return ptr(Buffer.from(str + '\0', 'utf16le'))
      },
    }
  }
  // pointer / _Out_ uint32_t *needed → pointer to a caller-allocated buffer
  if (clean === 'uint32_t*' || clean === 'uint32_t *needed' || clean === 'void*'
    || clean === 'void* descriptor' || clean === 'void *descriptor') {
    return {
      ffiArgs: FFIType.ptr,
      toFfi: (value) => (value instanceof Uint8Array || Buffer.isBuffer(value) ? ptr(value) : 0),
    }
  }
  if (isPointerKind(clean)) {
    return {
      ffiArgs: FFIType.ptr,
      toFfi: (value) => {
        if (value === null || value === undefined) return 0
        if (value instanceof Uint8Array || Buffer.isBuffer(value)) return ptr(value)
        if (typeof value === 'object' && value.__ptr !== undefined) return value.__ptr
        return value
      },
    }
  }
  return { ffiArgs: ffiType(clean), toFfi: (value) => value }
}

/** A bound native function: captures the dll symbol and marshals arguments. */
function bind(dll, name, retKind, argKinds) {
  const ret = retKind.replace(/^const\s+/, '')
  const returnType = ret === 'uint32_t' ? FFIType.u32 : ret === 'int' ? FFIType.i32 : ffiType(ret)
  const specs = argKinds.map(argSpec)
  const symbols = dlopen(dll, {
    [name]: {
      args: specs.map((s) => s.ffiArgs),
      returns: returnType,
    },
  })
  const fn = symbols.symbols[name]
  return (...values) => {
    const args = specs.map((s, i) => s.toFfi(values[i]))
    return fn(...args)
  }
}

/** A loaded DLL handle exposing koffi-style `.func(...)`. */
class Lib {
  constructor(name) {
    this.name = name
  }

  func(...signature) {
    let name
    let ret
    let args
    if (typeof signature[0] === 'string' && signature[0].includes('(')) {
      // C-style single-string declaration
      const parsed = parseDeclaration(signature[0])
      name = parsed.name
      ret = parsed.ret
      args = parsed.args
    } else {
      // (abi, name, ret, args[])
      name = String(signature[1])
      ret = String(signature[2])
      args = signature[3].map(String)
    }
    return bind(this.name, name, ret, args)
  }
}

/**
 * Scalar sizes and alignments under the Windows x64 ABI.
 *
 * This is the layout koffi computes natively, and the bundled harness DEPENDS
 * on getting it right: `@deepseek-ai/dsh-win32-process` asserts two struct sizes
 * at module scope (`STARTUPINFOW.size === 104`, `PROCESS_INFORMATION.size === 24`)
 * and throws otherwise, so a wrong layout breaks the import on every platform —
 * including the Linux/macOS builds that only ever load the module, never call it.
 */
const SCALAR_LAYOUT = {
  void: { size: 8, align: 8 },
  bool: { size: 1, align: 1 },
  char: { size: 1, align: 1 },
  int8: { size: 1, align: 1 },
  int8_t: { size: 1, align: 1 },
  uint8: { size: 1, align: 1 },
  uint8_t: { size: 1, align: 1 },
  uchar: { size: 1, align: 1 },
  int16: { size: 2, align: 2 },
  int16_t: { size: 2, align: 2 },
  uint16: { size: 2, align: 2 },
  uint16_t: { size: 2, align: 2 },
  short: { size: 2, align: 2 },
  ushort: { size: 2, align: 2 },
  int32: { size: 4, align: 4 },
  int32_t: { size: 4, align: 4 },
  uint32: { size: 4, align: 4 },
  uint32_t: { size: 4, align: 4 },
  int: { size: 4, align: 4 },
  uint: { size: 4, align: 4 },
  int64: { size: 8, align: 8 },
  int64_t: { size: 8, align: 8 },
  uint64: { size: 8, align: 8 },
  uint64_t: { size: 8, align: 8 },
  long: { size: 8, align: 8 },
  ulong: { size: 8, align: 8 },
  intptr_t: { size: 8, align: 8 },
  uintptr_t: { size: 8, align: 8 },
  ssize_t: { size: 8, align: 8 },
  size_t: { size: 8, align: 8 },
  float: { size: 4, align: 4 },
  double: { size: 8, align: 8 },
  // `str16` / `str` / `cstring` are POINTERS to the character data, not inline
  // buffers, so they occupy 8 bytes at 8-byte alignment on x64.
  str16: { size: 8, align: 8 },
  str: { size: 8, align: 8 },
  cstring: { size: 8, align: 8 },
}

/** Every pointer type lays out identically on x64. */
const POINTER_LAYOUT = { size: 8, align: 8 }

/** Round `offset` up to the next multiple of `align` (both powers of two). */
function alignUp(offset, align) {
  return Math.ceil(offset / align) * align
}

/** Whether a koffi type expression denotes a pointer (decoded to a BigInt). */
function isPointerType(type) {
  if (type instanceof Composite) return type.kind === 'pointer'
  if (typeof type !== 'string') return false
  const clean = type.trim()
  return clean === 'void' || clean === 'str16' || clean === 'str' || clean === 'cstring' || isPointerKind(clean)
}

/**
 * The size and alignment of one koffi type expression, or `undefined` when this
 * shim cannot lay it out. An unknown type leaves the owning struct's `size`
 * undefined rather than guessing, so the harness's own layout guard reports the
 * mismatch with its precise message instead of a wrong size passing silently.
 * @param type - a scalar name or a {@link Composite}.
 * @returns `{ size, align }`, or `undefined` when the type is not supported.
 */
function typeLayout(type) {
  if (type instanceof Composite) {
    if (type.kind === 'pointer') return POINTER_LAYOUT
    if (type.kind === 'array') {
      const inner = typeLayout(type.inner)
      return inner === undefined ? undefined : { size: inner.size * type.length, align: inner.align }
    }
    if (type.kind === 'struct') {
      return type.size === undefined ? undefined : { size: type.size, align: type.align }
    }
    return undefined
  }
  if (typeof type !== 'string') return undefined
  const scalar = SCALAR_LAYOUT[type.trim()]
  if (scalar !== undefined) return scalar
  if (isPointerKind(type.trim())) return POINTER_LAYOUT
  return undefined
}

/**
 * Lay out one struct: each member starts at its own alignment, and the total is
 * rounded up to the struct's alignment (the largest member alignment).
 * @param fields - the koffi field map, in declaration order.
 * @returns `{ offsets, size, align }`, or `undefined` for an unsupported field.
 */
function structLayout(fields) {
  const offsets = {}
  let offset = 0
  let align = 1
  for (const [field, raw] of Object.entries(fields)) {
    const layout = typeLayout(raw)
    if (layout === undefined) return undefined
    offset = alignUp(offset, layout.align)
    offsets[field] = offset
    offset += layout.size
    if (layout.align > align) align = layout.align
  }
  return { offsets, size: alignUp(offset, align), align }
}

/**
 * A koffi composite type (struct/pointer/array). The shim keeps these as
 * lightweight descriptors. A struct additionally carries the Win64 layout
 * (`.size` / `.align` / `.offsets`) its consumers read and assert on.
 */
class Composite {
  constructor(kind, name, fields, inner, length) {
    this.kind = kind
    this.name = name
    this.fields = fields
    this.inner = inner
    this.length = length
  }
}

/**
 * Read one scalar at `offset`.
 *
 * Integers up to 32 bits decode to `number`; 64-bit integers and pointers
 * decode to `bigint`, which is what the harness's `NativePtr` is. A null
 * pointer decodes to `null`, matching koffi's own convention.
 * @param view - a little-endian DataView over the whole buffer.
 * @param offset - byte offset from the buffer start.
 * @param type - the koffi type expression of the field.
 * @returns the decoded value.
 */
function decodeScalar(view, offset, type) {
  if (isPointerType(type)) {
    const address = view.getBigUint64(offset, true)
    return address === 0n ? null : address
  }
  const layout = typeLayout(type) ?? { size: 4, align: 4 }
  if (layout.size === 1) return view.getUint8(offset)
  if (layout.size === 2) return view.getUint16(offset, true)
  if (layout.size === 4) return view.getUint32(offset, true)
  return view.getBigUint64(offset, true)
}

/** Decode one field at its laid-out offset. */
function decodeField(view, offset, type) {
  if (type instanceof Composite && type.kind === 'struct') return decodeStruct(view, type, offset)
  if (type instanceof Composite && type.kind === 'array') {
    const inner = typeLayout(type.inner) ?? { size: 1, align: 1 }
    return new Uint8Array(view.buffer, view.byteOffset + offset, inner.size * type.length).slice()
  }
  return decodeScalar(view, offset, type)
}

/**
 * Decode a struct instance from `base` using its computed layout (never a
 * guessed walk: an unsupported layout throws rather than mis-reading fields).
 * @param view - a little-endian DataView over the whole buffer.
 * @param type - the struct Composite.
 * @param base - byte offset of the instance.
 * @returns the decoded field map.
 */
function decodeStruct(view, type, base = 0) {
  if (type.offsets === undefined) {
    throw new Error(`koffi shim: cannot decode ${type.name}: unsupported field layout`)
  }
  const out = {}
  for (const [field, raw] of Object.entries(type.fields)) {
    out[field] = decodeField(view, base + type.offsets[field], raw)
  }
  return out
}

/** The exported koffi-shaped module namespace. */
const koffi = {
  load(name) {
    return new Lib(name)
  },
  pointer(type) {
    return new Composite('pointer', typeof type === 'string' ? type : type.name)
  },
  struct(name, fields) {
    const composite = new Composite('struct', name, fields)
    // The Win64 layout is computed once, here, and read by both the harness's
    // module-scope size assertions and this shim's own field decoding.
    const layout = structLayout(fields)
    if (layout !== undefined) {
      composite.size = layout.size
      composite.align = layout.align
      composite.offsets = layout.offsets
    }
    return composite
  },
  array(type, length) {
    return new Composite('array', 'array', undefined, type, length)
  },
  decode(buffer, type) {
    // The offset+type overload koffi offers (`decode(buffer, offset, type)`) is
    // NOT implemented: fail loud rather than decode from offset 0 and hand back
    // a plausible-looking wrong value. It is part of P4-step2.
    if (typeof type === 'number') {
      throw new Error('koffi shim: decode(buffer, offset, type) is not implemented; pass the type only')
    }
    const bytes = buffer instanceof Uint8Array ? buffer : buffer.value ?? buffer
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (type instanceof Composite && type.kind === 'struct') return decodeStruct(view, type)
    if (type === undefined) return bytes
    return decodeScalar(view, 0, type)
  },
  view(buffer, type) {
    return koffi.decode(buffer, type)
  },
  register() {
    // callback registration is unused by the bundled TUI paths
  },
  unregister() {
  },
}

export default koffi
export const load = koffi.load
export const pointer = koffi.pointer
export const struct = koffi.struct
export const array = koffi.array
export const decode = koffi.decode
export const view = koffi.view
export const register = koffi.register
export const unregister = koffi.unregister
export { koffi }
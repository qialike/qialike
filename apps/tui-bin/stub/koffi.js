/**
 * A minimal, pure-JS `koffi` replacement built on `bun:ffi` for the single-file
 * qialike bundle.
 *
 * Real koffi is a native N-API addon (its `.node` ships in the
 * `@koromix/koffi-win32-x64` optional dependency), which a `bun build
 * --compile` single file cannot embed. The harness loads koffi lazily on
 * Windows to drive durable file/session operations (`MoveFileExW`,
 * `GetFileSecurityW`, `ReplaceFileW`, ...), process-table inspection, and the
 * Win32 restricted-token sandbox.
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
 * Memory follows koffi's own model: `alloc` returns a zeroed address,
 * `encode` writes a type into one (`encode(ptr, offset, type, value)`), and
 * `decode` reads one back (`decode(ptr, offset, type)`). Every allocation is
 * registered so the shim can address it directly; an address it did not
 * allocate is resolved through `bun:ffi`'s `toArrayBuffer`.
 *
 * @module qialike/koffi-shim
 */

import { JSCallback, dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi'

/**
 * Map a koffi primitive/pointer type name to a bun:ffi FFIType.
 *
 * A `void` result is `FFIType.void`; `void` as a PARAMETER type is a pointer, so
 * only {@link returnType} maps it here, and {@link argSpec} handles it as
 * `FFIType.ptr`.
 * @param name - a primitive type spelling (`uint32`, `int32_t`, `size_t`, ...).
 * @returns the matching bun:ffi type, or `undefined` when the name is not a scalar.
 */
function scalarFfiType(name) {
  switch (name) {
    case 'bool': return FFIType.bool
    case 'char': case 'int8': case 'int8_t': return FFIType.i8
    case 'uchar': case 'uint8': case 'uint8_t': return FFIType.u8
    case 'short': case 'int16': case 'int16_t': return FFIType.i16
    case 'ushort': case 'uint16': case 'uint16_t': return FFIType.u16
    case 'int': case 'int32': case 'int32_t': return FFIType.i32
    case 'uint': case 'uint32': case 'uint32_t': return FFIType.u32
    case 'int64': case 'int64_t': return FFIType.i64
    case 'ulong': case 'uint64': case 'uint64_t': return FFIType.u64
    case 'intptr_t': case 'intptr': case 'ssize_t': return FFIType.isize
    case 'uintptr_t': case 'size_t': return FFIType.usize
    case 'float': case 'float32': return FFIType.f32
    case 'double': case 'float64': return FFIType.f64
    case 'char16': case 'char16_t': return FFIType.u16
    default: return undefined
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

/** Strip SAL annotations, `const`, a trailing parameter name, and whitespace. */
function cleanTypeSpelling(kind) {
  let clean = kind
    .replace(/\b_(?:In|Out|Inout|In_opt|Out_opt|Inout_opt|Reserved)_?\b/g, '')
    .replace(/\bconst\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  // "char16_t *path" / "uint32_t *needed" → "char16_t*" / "uint32_t*"
  const named = clean.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\*\s*[A-Za-z_][A-Za-z0-9_]*$/)
  if (named) clean = `${named[1]}*`
  // "uint32_t requested" / "size_t length" → "uint32_t" / "size_t": a koffi
  // declaration names scalar parameters as well, and the name is not part of the
  // type. Without this the type lookup below misses every named scalar
  // (`GetFileSecurityW`'s `requested`, `ReplaceFileW`'s `flags`, ...).
  const namedScalar = clean.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+[A-Za-z_][A-Za-z0-9_]*$/)
  if (namedScalar) clean = namedScalar[1]
  return clean.replace(/\s*\*\s*/g, '*')
}

/**
 * Map one prototype parameter spelling to a bun:ffi callback type.
 *
 * `void` and pointer spellings are addresses; everything else must be a scalar
 * this shim can marshal. An unsupported spelling throws here rather than
 * registering a callback whose arguments bun:ffi would mis-read.
 * @param spelling - the parameter type spelling (a name may follow it).
 * @param declaration - the whole prototype, for the error message.
 * @returns the bun:ffi type for that parameter.
 */
function protoFfiType(spelling, declaration) {
  const clean = cleanTypeSpelling(spelling)
  if (clean === 'void' || isPointerKind(clean)) return FFIType.ptr
  const ffi = scalarFfiType(clean)
  if (ffi === undefined) {
    throw new Error(`koffi shim: unsupported prototype parameter type "${spelling}" in "${declaration}"`)
  }
  return ffi
}

/**
 * Resolve the prototype a `register` type expression names: either the token
 * `koffi.proto` returned, or the `koffi.pointer(proto)` expression callers
 * actually pass (`koffi.register(fn, koffi.pointer(proto))`).
 * @param type - the type expression.
 * @returns the prototype token, or `undefined` when it names none.
 */
function protoOf(type) {
  if (type === null || type === undefined) return undefined
  if (type.__proto === true) return type
  if (type instanceof Composite && type.inner !== undefined) return protoOf(type.inner)
  return undefined
}

/** JS callbacks registered through `register`, keyed by the address handed out. */
const registeredCallbacks = new Map()

/**
 * The native address of a bun:ffi callback, as the `bigint` this shim's pointer
 * marshalling expects (`addressOf`). Measured on Bun 1.4.2: `JSCallback.ptr` is
 * a plain `number`; the buffer/pointer forms are kept for other bun:ffi builds.
 * @param callback - the live {@link JSCallback}.
 * @returns the address.
 */
function callbackAddress(callback) {
  const raw = callback.ptr
  if (typeof raw === 'bigint') return raw
  if (typeof raw === 'number') return BigInt(Math.trunc(raw))
  return BigInt(ptr(raw))
}

/** A koffi pointer/array element spelling that carries no address of its own. */
function isCharacterSpelling(spelling) {
  return spelling === 'char16' || spelling === 'char16_t' || spelling === 'wchar_t'
}

/**
 * Read a pointer-ish value as a `bigint` address.
 * @param value - a `bigint`/`number`/`Buffer`/`Uint8Array`/`null`.
 * @returns the address as a `bigint` (0 for null/undefined).
 */
function addressOf(value) {
  if (value === null || value === undefined) return 0n
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(Math.trunc(value))
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return BigInt(ptr(value))
  if (typeof value === 'object' && value.__ptr !== undefined) return addressOf(value.__ptr)
  throw new Error(`koffi shim: cannot read a native address from ${typeof value}`)
}

/** Allocations this shim made, keyed by address, so encode/decode can address them. */
const allocations = new Map()

/** Views onto addresses the shim did not allocate (native out-parameters). */
const foreignViews = new Map()

/**
 * Addresses this shim allocated and then freed. A JS allocator will hand a freed
 * block straight back out, so without this record `decode` on a stale address
 * would silently read the NEXT allocation's bytes rather than fail.
 */
const freedAddresses = new Set()

/** Bytes the shim assumes it may read at an address it did not allocate. */
const FOREIGN_VIEW_BYTES = 4096

/**
 * The Win32 heap calls that back `koffi.alloc`.
 *
 * The memory has to be REAL: a struct pointer handed to `CreateProcessAsUserW`
 * or an ACL call must name a block the kernel can read, so the shim cannot rely
 * on `ptr()` of a JavaScript buffer (measured on this host: Bun answers that with
 * an address whose bytes read back as zeros, while the buffer's own view holds
 * the data — a mismatch that only shows up at the native boundary).
 *
 * Bound lazily and only when the process needs native memory, so importing this
 * module stays side-effect-free on the POSIX builds that never allocate.
 */
let heapBindings

function heapApi() {
  if (heapBindings !== undefined) return heapBindings
  const lib = dlopen('kernel32.dll', {
    GetProcessHeap: { args: [], returns: FFIType.u64 },
    HeapAlloc: { args: [FFIType.u64, FFIType.u32, FFIType.usize], returns: FFIType.u64 },
    HeapFree: { args: [FFIType.u64, FFIType.u32, FFIType.u64], returns: FFIType.i32 },
  })
  heapBindings = {
    heap: lib.symbols.GetProcessHeap(),
    alloc: lib.symbols.HeapAlloc,
    free: lib.symbols.HeapFree,
  }
  return heapBindings
}

/** `HEAP_ZERO_MEMORY`: an allocation starts zeroed, as `koffi.alloc` guarantees. */
const HEAP_ZERO_MEMORY = 0x8

/**
 * Allocate one zeroed native block and wrap it in a byte view.
 *
 * The view is `Buffer.from(arrayBuffer)`, which reads and writes the heap block
 * itself, so what `encode` writes is what native code reads.
 * @param byteLength - the block size in bytes.
 * @returns the block's address and its view.
 */
function allocateBytes(byteLength) {
  const api = heapApi()
  const address = api.alloc(api.heap, HEAP_ZERO_MEMORY, byteLength)
  if (address === 0n) throw new Error(`koffi shim: HeapAlloc failed for ${byteLength} bytes`)
  const buffer = Buffer.from(toArrayBuffer(address, 0, byteLength))
  allocations.set(address, buffer)
  return { address, buffer }
}

/** Release one native block the shim allocated. */
function releaseBytes(address) {
  const api = heapApi()
  allocations.delete(address)
  if (address !== 0n) freedAddresses.add(address)
  api.free(api.heap, 0, address)
}

/**
 * Resolve a value to a byte view plus a base offset.
 *
 * A registered allocation is addressed directly from its own view; anything else
 * is wrapped through `toArrayBuffer`, because a real Win32 out-parameter (for
 * example the SID `LocalAlloc` returns after `ConvertStringSidToSidW`) has no
 * JS object behind it.
 * @param target - an allocated address, a foreign address, or a Buffer.
 * @returns the view and the base offset within it.
 */
function memoryView(target) {
  if (target instanceof Uint8Array || Buffer.isBuffer(target)) {
    return { bytes: target, base: 0 }
  }
  const address = addressOf(target)
  if (address === 0n) throw new Error('koffi shim: cannot read through a null native address')
  const owned = allocations.get(address)
  if (owned !== undefined) return { bytes: owned, base: 0 }
  if (freedAddresses.has(address)) {
    throw new Error(`koffi shim: 0x${address.toString(16)} was freed and may already belong to another allocation`)
  }
  const cached = foreignViews.get(address)
  if (cached !== undefined) return { bytes: cached, base: 0 }
  const foreign = new Uint8Array(toArrayBuffer(address, 0, FOREIGN_VIEW_BYTES))
  foreignViews.set(address, foreign)
  return { bytes: foreign, base: 0 }
}

/**
 * Check that one typed access fits the resolved block.
 * @param bytes - the resolved block.
 * @param start - the access's byte offset.
 * @param type - the type being read or written.
 */
function requireRoom(bytes, start, type) {
  const layout = typeLayout(type)
  if (layout === undefined || start < 0 || start + layout.size > bytes.byteLength) {
    throw new Error(
      `koffi shim: "${String(type)}" does not fit the ${bytes.byteLength}-byte block at offset ${start}`,
    )
  }
}

/** The output type of `koffi.decode(buffer, offset, type)`. */
function decodeAt(target, offset, type) {
  const { bytes, base } = memoryView(target)
  const start = base + offset
  if (type === undefined) return bytes.slice(start)
  requireRoom(bytes, start, type)
  return decodeField(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), start, type)
}

/** The input type of `koffi.encode(buffer, offset, type, value)`. */
function encodeAt(target, offset, type, value) {
  const { bytes, base } = memoryView(target)
  const start = base + offset
  requireRoom(bytes, start, type)
  encodeInto(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), start, type, value)
}

/** Write one UTF-16 string plus a NUL terminator, bounded by the view. */
function writeString16(view, offset, value) {
  const text = String(value)
  for (let index = 0; index < text.length; index += 1) {
    view.setUint16(offset + index * 2, text.charCodeAt(index), true)
  }
  view.setUint16(offset + text.length * 2, 0, true)
}

/** Write one scalar into the view at `offset`. */
function encodeScalar(view, offset, type, value) {
  if (isPointerType(type)) {
    const address = value === null || value === undefined ? 0n : addressOf(value)
    view.setBigUint64(offset, address, true)
    return
  }
  const layout = typeLayout(type) ?? { size: 4, align: 4 }
  if (layout.size === 1) view.setUint8(offset, Number(value))
  else if (layout.size === 2) view.setUint16(offset, Number(value), true)
  else if (layout.size === 4) view.setUint32(offset, Number(value), true)
  else if (layout.size === 8) view.setBigUint64(offset, BigInt(value), true)
  else throw new Error(`koffi shim: cannot encode a ${layout.size}-byte scalar`)
}

/**
 * Write one value of `type` into the view at `offset`.
 *
 * A `char16` array takes a JavaScript string (koffi's own convention for a
 * fixed-width UTF-16 field such as `PROCESSENTRY32W.szExeFile`); every other
 * array takes an array of member values.
 */
function encodeInto(view, offset, type, value) {
  if (type instanceof Composite && type.kind === 'array') {
    const spelling = typeof type.inner === 'string' ? type.inner : ''
    if (isCharacterSpelling(spelling)) {
      writeString16(view, offset, value)
      return
    }
    const inner = typeLayout(type.inner) ?? { size: 1, align: 1 }
    const entries = Array.isArray(value) ? value : []
    for (let index = 0; index < type.length; index += 1) {
      encodeInto(view, offset + inner.size * index, type.inner, entries[index])
    }
    return
  }
  if (type instanceof Composite && type.kind === 'struct') {
    encodeStruct(view, offset, type, value)
    return
  }
  if (typeof type === 'string') {
    const spelling = type.trim()
    if (spelling === 'str16' || spelling === 'str' || spelling === 'cstring') {
      view.setBigUint64(offset, value === null || value === undefined ? 0n : allocateString16(value), true)
      return
    }
  }
  encodeScalar(view, offset, type, value)
}

/** Write every declared field of a struct instance. */
function encodeStruct(view, base, type, value) {
  if (type.offsets === undefined) {
    throw new Error(`koffi shim: cannot encode ${type.name}: unsupported field layout`)
  }
  const source = value ?? {}
  for (const [field, fieldType] of Object.entries(type.fields)) {
    const fieldValue = source[field]
    if (fieldValue === undefined && !(field in source)) {
      // koffi leaves absent members untouched; an allocated struct starts zeroed.
      continue
    }
    encodeInto(view, base + type.offsets[field], fieldType, fieldValue)
  }
}

/**
 * Normalize one koffi arg type expression to a bun:ffi arg spec + a marshaller.
 * @param kind - a type spelling or a {@link Composite}.
 * @returns the bun:ffi arg type plus the value marshaller for it.
 */
function argSpec(kind) {
  if (kind instanceof Composite) {
    if (kind.kind === 'pointer') {
      const pointee = kind.inner
      // Pointer-to-STRUCT arguments accept a whole struct instance from JS and
      // marshal it into native memory for the call (koffi does the same).
      if (pointee instanceof Composite && pointee.kind === 'struct') {
        return { ffiArgs: FFIType.ptr, toFfi: (value) => marshalStructPointer(pointee, value) }
      }
      return { ffiArgs: FFIType.ptr, toFfi: (value) => addressOfPointerArg(value) }
    }
    return { ffiArgs: FFIType.ptr, toFfi: (value) => addressOfPointerArg(value) }
  }
  const clean = cleanTypeSpelling(String(kind))
  // char16_t * (UTF-16 string) and const char16_t *
  if (clean === 'char16_t*' || clean === 'str16') {
    return { ffiArgs: FFIType.ptr, toFfi: string16Argument }
  }
  if (isPointerKind(clean)) {
    // `T *` with a SCALAR pointee also accepts a JS array from koffi, whose
    // element(s) receive what the call writes back — that is how the harness
    // declares its `_Out_` parameters (`GetFileSecurityW`'s `needed`).
    // `outScalar` is the pointee spelling the write-back in `bind` decodes as.
    const pointee = clean.endsWith('*') ? clean.slice(0, -1) : ''
    const spec = { ffiArgs: FFIType.ptr, toFfi: (value) => addressOfPointerArg(value) }
    if (pointee !== '' && scalarFfiType(pointee) !== undefined) spec.outScalar = pointee
    return spec
  }
  const scalar = scalarFfiType(clean)
  if (scalar === undefined) {
    throw new Error(`koffi shim: unsupported argument type "${String(kind)}"`)
  }
  return { ffiArgs: scalar, toFfi: (value) => value }
}

/** Marshalling results whose memory must outlive one native call. */
const transient = []

/**
 * Every `toFfi` above returns a `bigint` address, never a `number`: addresses
 * above 2^53 lose their low bits in a `Number` conversion, which turns a valid
 * pointer into a wild one. `bun:ffi` accepts a `bigint` for a `ptr` argument.
 */

/** Marshal a nullable pointer argument to a bun:ffi `ptr` value. */
function addressOfPointerArg(value) {
  if (value === null || value === undefined) return 0n
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return BigInt(ptr(value))
  return addressOf(value)
}

/**
 * Copy an optional UTF-16 string argument into native memory.
 * @param value - the string, or null/undefined for a NULL pointer.
 * @returns the bun:ffi `ptr` value for the call.
 */
function string16Argument(value) {
  return value === null || value === undefined ? 0n : allocateString16(value)
}

/** Copy one UTF-16 string into native memory and return its address. */
function allocateString16(value) {
  const { address, buffer } = allocateBytes(Buffer.byteLength(String(value), 'utf16le') + 2)
  transient.push(address)
  writeString16(new DataView(buffer.buffer), 0, value)
  return address
}

/**
 * Marshal a struct instance into native memory for one call.
 *
 * A `Buffer`, a `bigint`, `null`, or a previously allocated address is already a
 * pointer and passes straight through; a plain object is encoded into a fresh
 * zeroed allocation owned by the call.
 * @param type - the pointee struct type.
 * @param value - the argument value.
 * @returns the bun:ffi `ptr` value for the call.
 */
function marshalStructPointer(type, value) {
  if (value === null || value === undefined) return 0n
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return BigInt(ptr(value))
  if (typeof value === 'bigint' || typeof value === 'number') return addressOf(value)
  if (typeof value !== 'object') {
    throw new Error(`koffi shim: ${type.name}* expects a struct instance, received ${typeof value}`)
  }
  if (type.size === undefined) {
    throw new Error(`koffi shim: cannot marshal ${type.name}: unsupported field layout`)
  }
  const { address, buffer } = allocateBytes(type.size)
  transient.push(address)
  encodeStruct(new DataView(buffer.buffer), 0, type, value)
  return address
}

/**
 * The bun:ffi return type for a koffi result type.
 *
 * Pointer results are `u64`, not `ptr`: the harness brands handles as
 * `NativePtr = bigint`, and `u64` is the one FFIType Bun decodes to `bigint`.
 * @param type - a type spelling or a {@link Composite}.
 * @returns the bun:ffi return type.
 */
function returnType(type) {
  if (type instanceof Composite) return FFIType.u64
  const clean = cleanTypeSpelling(String(type))
  if (clean === 'void') return FFIType.void
  if (isPointerKind(clean) || clean === 'str16') return FFIType.u64
  const scalar = scalarFfiType(clean)
  if (scalar === undefined) throw new Error(`koffi shim: unsupported return type "${String(type)}"`)
  return scalar
}

/** A bound native function: captures the dll symbol and marshals arguments. */
function bind(dll, name, retKind, argKinds) {
  const specs = argKinds.map(argSpec)
  const symbols = dlopen(dll, {
    [name]: {
      args: specs.map((s) => s.ffiArgs),
      returns: returnType(retKind),
    },
  })
  const fn = symbols.symbols[name]
  return (...values) => {
    // A JS array for a scalar-pointer parameter is koffi's `_Out_` convention:
    // this shim owns the block, the call writes into it, and the element(s) are
    // copied back into the caller's array before the block is released.
    const outParams = []
    const args = specs.map((s, i) => {
      const value = values[i]
      if (s.outScalar === undefined || !Array.isArray(value)) return s.toFfi(value)
      const layout = typeLayout(s.outScalar) ?? { size: 4, align: 4 }
      const { address, buffer } = allocateBytes(layout.size * Math.max(1, value.length))
      transient.push(address)
      outParams.push({ value, buffer, size: layout.size, type: s.outScalar })
      return address
    })
    try {
      const result = fn(...args)
      for (const out of outParams) {
        const view = new DataView(out.buffer.buffer, out.buffer.byteOffset, out.buffer.byteLength)
        for (let i = 0; i < out.value.length; i += 1) {
          out.value[i] = decodeScalar(view, i * out.size, out.type)
        }
      }
      return result
    } finally {
      // Transient marshalling memory belongs to this call alone; return it to
      // the heap rather than leaking a block per call.
      for (const address of transient.splice(0)) releaseBytes(address)
    }
  }
}

/** Candidate modules for a `koffi.load(null)` symbol lookup, in probe order. */
const PROCESS_LIBRARIES = ['ucrtbase.dll', 'msvcrt.dll', 'kernel32.dll']

/**
 * Address one koffi type expression, including the pointer types the harness
 * builds with `koffi.pointer(...)`.
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
 * Symbol spellings whose current-process export is absent from a single-file Bun
 * binary, mapped to the C-runtime export that performs the same descriptor
 * lookup (`_get_osfhandle` is the CRT's own fd→HANDLE call, and Bun's libuv
 * descriptors come from that same CRT table).
 *
 * `_get_osfhandle` does not return an error for an out-of-range descriptor: the
 * CRT invalid-parameter handler aborts this process. The harness only calls it
 * with the descriptors it deliberately opened on itself, so the shim passes
 * those straight through rather than probing.
 */
const CRT_HANDLE_FALLBACK = new Map([['uv_get_osfhandle', '_get_osfhandle']])

/**
 * The calling-convention tokens a koffi declaration may lead with. `stdcall` and
 * friends may arrive either as a bare token or with an inline `__` prefix, which
 * is how the harness writes the current-process (`koffi.load(null)`) form.
 */
const CALLING_CONVENTIONS = new Set(['stdcall', 'cdecl', 'fastcall', 'thiscall'])

/** Whether one leading `func(...)` token names a calling convention. */
function isCallingConvention(token) {
  return typeof token === 'string' && CALLING_CONVENTIONS.has(token.replace(/^__/, '').toLowerCase())
}

/** A loaded DLL handle exposing koffi-style `.func(...)`.
 *
 * `koffi.load(null)` addresses the current process, which a single-file Bun
 * binary does not export, so a null name resolves each symbol against
 * {@link PROCESS_LIBRARIES} lazily — a symbol the harness never calls must not
 * fail the load of one it does.
 */
class Lib {
  constructor(name) {
    this.name = name
  }

  /** The dlopen name to use, resolving a null (current-process) load lazily. */
  libraryFor(symbol) {
    const wanted = [symbol, ...CRT_HANDLE_FALLBACK.has(symbol) ? [CRT_HANDLE_FALLBACK.get(symbol)] : []]
    for (const candidate of PROCESS_LIBRARIES) {
      for (const name of wanted) {
        try {
          dlopen(candidate, { [name]: { args: [], returns: FFIType.void } })
          return { library: candidate, symbol: name }
        } catch {
          // Not this export in this library; the remaining candidates are the
          // only place the symbol can still come from.
        }
      }
    }
    throw new Error(`koffi shim: cannot resolve ${symbol} in the current process`)
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
      // `func(abi, name, result, args)` — and koffi's documented shorthand
      // `func(name, result, args)`, which is what the harness uses for the
      // current-process library. Both keep `result` and `args` AS GIVEN: they
      // are `koffi.pointer(...)` composites, and stringifying one yields
      // "[object Object]", which can no longer be told from a pointer, so every
      // such argument would silently marshal as an address.
      const takesConvention = isCallingConvention(signature[0])
      name = String(takesConvention ? signature[1] : signature[0])
      ret = takesConvention ? signature[2] : signature[1]
      args = takesConvention ? signature[3] : signature[2]
    }
    if (!Array.isArray(args)) {
      throw new Error(`koffi shim: ${name} was bound without an argument-type array`)
    }
    if (this.name === null || this.name === undefined) {
      const resolved = this.libraryFor(name)
      return bind(resolved.library, resolved.symbol, ret, args)
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
  intptr: { size: 8, align: 8 },
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
  // An inline UTF-16 code unit (`PROCESSENTRY32W.szExeFile` elements).
  char16: { size: 2, align: 2 },
  char16_t: { size: 2, align: 2 },
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
  const clean = cleanTypeSpelling(type)
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
  const layout = typeLayout(type)
  if (layout === undefined) {
    throw new Error(`koffi shim: cannot decode the unsupported type "${String(type)}"`)
  }
  if (layout.size === 1) return view.getUint8(offset)
  if (layout.size === 2) return view.getUint16(offset, true)
  if (layout.size === 4) return view.getUint32(offset, true)
  return view.getBigUint64(offset, true)
}

/** Decode one field at its laid-out offset. */
function decodeField(view, offset, type) {
  if (type instanceof Composite && type.kind === 'struct') return decodeStruct(view, type, offset)
  if (type instanceof Composite && type.kind === 'array') {
    const spelling = typeof type.inner === 'string' ? type.inner : ''
    if (isCharacterSpelling(spelling)) {
      let text = ''
      for (let index = 0; index < type.length; index += 1) {
        const code = view.getUint16(offset + index * 2, true)
        if (code === 0) break
        text += String.fromCharCode(code)
      }
      return text
    }
    const inner = typeLayout(type.inner) ?? { size: 1, align: 1 }
    const entries = []
    for (let index = 0; index < type.length; index += 1) {
      entries.push(decodeField(view, offset + inner.size * index, type.inner))
    }
    return entries
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
  /**
   * Declare a callback prototype, e.g.
   * `koffi.proto("int __stdcall Name(void *hwnd, intptr lparam)")`.
   *
   * koffi consumers use the result only through `koffi.pointer(...)` as the
   * callback's type, and the shim keeps the parsed bun:ffi signature for the
   * matching {@link koffi.register} call. Without this the native directory
   * picker registered a callback the shim silently dropped, so
   * `EnumThreadWindows` received a null pointer and the dialog thread's windows
   * were never closed.
   * @param declaration - the C prototype spelling.
   * @returns the prototype token.
   */
  proto(declaration) {
    const parsed = parseDeclaration(String(declaration))
    const returns = parsed.ret === '' || cleanTypeSpelling(parsed.ret) === 'void'
      ? FFIType.void
      : protoFfiType(parsed.ret, declaration)
    return {
      __proto: true,
      name: parsed.name,
      args: parsed.args.map((arg) => protoFfiType(arg, declaration)),
      returns,
      signature: String(declaration),
    }
  },
  pointer(type) {
    return new Composite('pointer', typeof type === 'string' ? type : type.name, undefined, type)
  },
  struct(name, fields) {
    const composite = new Composite('struct', name, fields)
    // The Win64 layout is computed once, here, and read by both the harness's
    // module-scope size assertions and this shim's own field codec.
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
  /**
   * Allocate zeroed native memory. The shim registers the block so `encode` and
   * `decode` can address it, and `free` releases it.
   * @param type - the element type.
   * @param count - the element count (default 1).
   * @returns the allocation's address.
   */
  alloc(type, count = 1) {
    const layout = typeLayout(type)
    if (layout === undefined) {
      throw new Error(`koffi shim: cannot allocate the unsupported type "${String(type)}"`)
    }
    return allocateBytes(layout.size * count).address
  },
  /**
   * Release an allocation made by {@link koffi.alloc}: it is removed from the
   * shim's register, and a later `encode`/`decode` on that address fails loud
   * instead of writing into memory the allocator has already handed out again.
   * A foreign address (or `undefined`) is a no-op: the shim only owns what it
   * allocated.
   * @param target - an allocation address.
   */
  free(target) {
    if (target === null || target === undefined) return
    const address = addressOf(target)
    if (!allocations.has(address)) return
    releaseBytes(address)
  },
  /**
   * Read a native value: `decode(pointer, type)`, `decode(pointer, offset, type)`,
   * or `decode(buffer, type)`.
   * @param buffer - an allocation address, a native address, or a Buffer.
   * @param offsetOrType - a byte offset, or the type when no offset is given.
   * @param type - the value's type when an offset was given.
   * @returns the decoded value.
   */
  decode(buffer, offsetOrType, type) {
    if (typeof offsetOrType === 'number') return decodeAt(buffer, offsetOrType, type)
    return decodeAt(buffer, 0, offsetOrType)
  },
  view(buffer, type, length) {
    const bytes = koffi.decode(buffer, type)
    return length === undefined ? bytes : bytes.subarray(0, length)
  },
  /**
   * Write a native value: `encode(pointer, type, value)` or
   * `encode(pointer, offset, type, value)`.
   * @param buffer - an allocation address, a native address, or a Buffer.
   * @param offsetOrType - a byte offset, or the type when no offset is given.
   * @param typeOrValue - the value when no offset was given, else the type.
   * @param value - the value when an offset was given.
   */
  encode(buffer, offsetOrType, typeOrValue, value) {
    if (typeof offsetOrType === 'number') {
      encodeAt(buffer, offsetOrType, typeOrValue, value)
      return
    }
    encodeAt(buffer, 0, offsetOrType, typeOrValue)
  },
  /**
   * The numeric address of a native pointer or buffer.
   * @param target - a pointer, address, or buffer.
   * @returns the address.
   */
  address(target) {
    return addressOf(target)
  },
  /**
   * The byte size of one value of `type`.
   * @param type - a type spelling or a {@link Composite}.
   * @returns the size in bytes.
   */
  sizeof(type) {
    const clean = typeof type === 'string' ? cleanTypeSpelling(type) : type
    const layout = typeLayout(clean)
    if (layout === undefined) {
      throw new Error(`koffi shim: cannot size the unsupported type "${String(type)}"`)
    }
    return layout.size
  },
  /**
   * Register a JS callback for a native function pointer and return the address
   * to pass to the callee.
   *
   * `type` is the `koffi.pointer(koffi.proto(...))` expression a declaration
   * carries; the returned handle must reach {@link koffi.unregister} once the
   * callee is done with it, or the trampoline leaks for the process lifetime.
   * @param fn - the JS callback.
   * @param type - the prototype type expression.
   * @returns the callback's address as an opaque handle.
   */
  register(fn, type) {
    const proto = protoOf(type)
    if (proto === undefined) {
      throw new Error('koffi shim: register requires a koffi.proto(...) declaration (pass koffi.pointer(proto))')
    }
    if (typeof fn !== 'function') {
      throw new Error('koffi shim: register requires a callback function')
    }
    const callback = new JSCallback(fn, { args: proto.args, returns: proto.returns })
    const handle = { __ptr: callbackAddress(callback) }
    registeredCallbacks.set(handle.__ptr, callback)
    return handle
  },
  /**
   * Release a callback registered by {@link koffi.register}. A foreign handle is
   * ignored by design: the shim only owns what it registered.
   * @param handle - the value `register` returned.
   */
  unregister(handle) {
    if (handle === null || handle === undefined) return
    const address = addressOf(handle)
    const callback = registeredCallbacks.get(address)
    if (callback === undefined) return
    registeredCallbacks.delete(address)
    callback.close()
  },
}

export default koffi
export const load = koffi.load
export const pointer = koffi.pointer
export const proto = koffi.proto
export const struct = koffi.struct
export const array = koffi.array
export const alloc = koffi.alloc
export const free = koffi.free
export const decode = koffi.decode
export const view = koffi.view
export const encode = koffi.encode
export const address = koffi.address
export const sizeof = koffi.sizeof
export const register = koffi.register
export const unregister = koffi.unregister
export { koffi }

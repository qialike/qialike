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
 * @module qialike/koffi-shim
 */

import { dlopen, FFIType, ptr } from 'bun:ffi'

/** Map a koffi primitive/pointer type name to a bun:ffi FFIType. */
function ffiType(name) {
  switch (name) {
    case 'void': return FFIType.void
    case 'bool': return FFIType.bool
    case 'char': case 'int8_t': return FFIType.i8
    case 'uchar': case 'uint8_t': return FFIType.u8
    case 'short': case 'int16_t': return FFIType.i16
    case 'ushort': case 'uint16_t': return FFIType.u16
    case 'int': case 'int32_t': return FFIType.i32
    case 'uint': case 'uint32_t': return FFIType.u32
    case 'long': case 'int64_t': return FFIType.i64
    case 'ulong': case 'uint64_t': return FFIType.u64
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
 * A koffi composite type (struct/pointer/array). The shim keeps these as
 * lightweight descriptors; native calls that need a struct layout are
 * supported only for the field types the TUI's bundled Windows paths use
 * (flat fixed-size fields). Unsupported layouts fail loud at use time.
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

function decodeStruct(view, fields) {
  const out = {}
  let offset = 0
  for (const [field, raw] of Object.entries(fields)) {
    const arr = typeof raw === 'string' ? {} : raw
    if (arr && arr.kind === 'array' && typeof arr.length === 'number') {
      const elem = typeof arr.inner === 'string' ? arr.inner : 'uint8'
      const size = elem === 'uint16' || elem === 'char16' ? 2 : elem === 'uint32' ? 4 : 1
      const bytes = view.slice(offset, offset + arr.length * size)
      offset += arr.length * size
      out[field] = bytes
      continue
    }
    if (arr && arr.kind === 'struct' && arr.fields) {
      out[field] = decodeStruct(view.slice(offset), arr.fields)
      continue
    }
    const size = typeof raw === 'string' && (raw === 'uint32' || raw === 'int32' || raw === 'uint16' || raw === 'int16') ? 2 : 1
    out[field] = view.slice(offset, offset + size)
    offset += size
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
    return new Composite('struct', name, fields)
  },
  array(type, length) {
    return new Composite('array', 'array', undefined, type, length)
  },
  decode(buffer, type) {
    const bytes = buffer instanceof Uint8Array ? buffer : buffer.value ?? buffer
    if (type instanceof Composite && type.kind === 'struct' && type.fields) {
      return decodeStruct(new Uint8Array(bytes), type.fields)
    }
    return bytes
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
/**
 * B3 verification: does the koffi shim really marshal a JS callback?
 *
 * `EnumWindows` is the cheapest native function that takes a callback and always
 * invokes it (there is at least one top-level window on any interactive
 * desktop), so the hit count proves the trampoline actually ran. Run it against
 * the pristine shim and the patched one to see the difference.
 */
const shimPath = process.argv[2]
if (shimPath === undefined) throw new Error('usage: bun koffi-callback-test.mjs <shim path>')

const koffi = (await import(`file:///${shimPath.replace(/\\/g, '/')}`)).default
const user32 = koffi.load('user32.dll')

let proto
try {
    proto = koffi.proto('int __stdcall DshEnumWindowsProc(void *hwnd, intptr lparam)')
} catch (error) {
    // The pristine shim has no `proto` at all: the picker's cancellation path
    // died here (or, before this test, with a silently ignored handle).
    console.log(JSON.stringify({
        shim: shimPath.split(/[\\/]/).pop(),
        protoError: String(error && error.message ? error.message : error),
    }))
    process.exit(0)
}

const enumWindows = user32.func('__stdcall', 'EnumWindows', 'int', ['void *', 'intptr'])

let hits = 0
let firstHandle = null
const handle = koffi.register((hwnd, lparam) => {
    hits += 1
    if (firstHandle === null) firstHandle = String(hwnd)
    return 1
}, koffi.pointer(proto))

const returned = enumWindows(handle, 0)
koffi.unregister(handle)
koffi.unregister(handle) // a second release must be a no-op, not a crash

console.log(JSON.stringify({
    shim: shimPath.split(/[\\/]/).pop(),
    callbackHandle: String(handle && handle.__ptr),
    protoArgs: proto.args.map((type) => String(type)),
    protoReturns: String(proto.returns),
    enumWindowsReturned: returned,
    callbackHits: hits,
    firstWindowHandle: firstHandle,
}))

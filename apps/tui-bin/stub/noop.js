// Native-addon and optional-tool stubs: the TUI patch disables the OS sandbox
// rows, so these modules are never activated. A no-op with a default export
// keeps esbuild from following the .node import (or the ink devtools import)
// while leaving a loadable namespace in place.
const noop = {}
export default noop
export {}

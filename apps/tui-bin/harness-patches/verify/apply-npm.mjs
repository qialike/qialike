/**
 * Deploy the same downstream patches to the npm-installed DSH host, mirroring
 * the fix-① precedent: the GUI/CLI host is a second entry point to the same
 * harness, so a confined shell started by it must get the same constraint.
 * The patches are idempotent and anchor-asserted, so a store copy that was
 * already patched (or a harness version that moved the anchors) reports itself.
 *
 * Adjust `NM` to the install under test; the default is this machine's global
 * npm prefix.
 */
import { patchDeleteConstraint } from '../delete-constraint.mjs'
import { patchPolicyAndHygiene } from '../policy-and-hygiene.mjs'

const NM = process.env.DSH_NPM_HARNESS
    ?? 'C:/Users/43418/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const changedAcl = patchDeleteConstraint({ root: `${NM}/dsh-sandbox-windows-acl/lib`, log: (line) => console.log(line) })
const changedPolicy = patchPolicyAndHygiene({
    dirs: {
        policy: `${NM}/dsh-sandbox-policy/lib/index.js`,
        sandboxLocal: `${NM}/dsh-sandbox-local/lib/index.js`,
    },
    log: (line) => console.log(line),
})
console.log(JSON.stringify({ changedAcl, changedPolicy }))

const hosts = [
    `${NM}/dsh-sandbox-windows-acl/lib/types-DuU3lSVe.js`,
    `${NM}/dsh-sandbox-policy/lib/index.js`,
    `${NM}/dsh-sandbox-local/lib/index.js`,
]
for (const host of hosts) {
    try {
        await import(`file:///${host}`)
        console.log(`imports OK: ${host.split('/@deepseek-ai/')[1]}`)
    } catch (error) {
        console.log(`import FAILED: ${host.split('/@deepseek-ai/')[1]}: ${error instanceof Error ? error.message : String(error)}`)
    }
}

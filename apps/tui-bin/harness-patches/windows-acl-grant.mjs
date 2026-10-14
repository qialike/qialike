/**
 * Move the Windows ACL workspace grant off the UI thread.
 *
 * `@deepseek-ai/dsh-sandbox-windows-acl` applies the standing `workspace-write`
 * capability ACE on the workspace ROOT with `SetNamedSecurityInfoW`, and Windows
 * inherits an inheritable ACE to every EXISTING descendant inside that one
 * synchronous call. The harness documents the cost itself — "eager inheritance;
 * minutes on large workspaces" — and mitigates only the REPEAT, through the
 * exact-ACE skip in `grantWrite`.
 *
 * That leaves the FIRST confined command of a session paying the whole tree on
 * the thread that also renders the UI. Measured on a 352,634-object workspace:
 * 188.5 s during which the interface answered nothing, while the process stayed
 * alive (qialike's 1 s heartbeat logged `[stall] main loop blocked for 188.5s`).
 *
 * This patch makes the harness's own mitigation reachable on the first call: it
 * awaits `QIALIKE_ENSURE_ACL_GRANT`, which applies the same grant in a CHILD
 * process (see `@qialike/qialike-app/windows-acl-grant.ts`). The harness's
 * `grant.add()` still runs afterwards and is still the authority — with the child
 * finished it takes the exact-ACE skip, which is the fast path this patch exists
 * to reach; with the child absent or failed it applies the grant itself, i.e.
 * today's behaviour rather than a workspace without a grant.
 *
 * `materializeAclGrant` therefore becomes async, and its two callers on the path
 * (`windowsAclRunnerArgv` and `runnerArgv`) become async with it. `confine()` is
 * already async and awaits the result, so nothing else in the seam changes.
 *
 * Windows-only in effect: `ensureAclGrant` returns immediately off win32, so
 * Linux and macOS keep their rungs byte for byte.
 *
 * Applied to `apps/tui-bin/x/**` (our transform of the harness's compiled
 * `lib/`), never to the harness checkout.
 *
 * @module qialike/harness-patches/windows-acl-grant
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** Idempotency marker of the import edit. */
export const GRANT_IMPORT_MARKER = 'from "@qialike/qialike-app/src/windows-acl-grant.ts"';
/** Idempotency marker of the waited-grant edit. */
export const GRANT_GATE_MARKER = 'qialike: wait for the one in-flight workspace grant';

/** The name the patched file calls the gate by. */
const GATE = 'QIALIKE_ENSURE_ACL_GRANT';

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

/**
 * Apply the anchored edits to one file. Each edit is skipped when its marker is
 * already present (idempotency) and otherwise requires its anchor exactly once.
 * @param file - absolute path of the file to edit.
 * @param edits - the edits, in order.
 * @param readFile - injected reader.
 * @param writeFile - injected writer.
 * @returns true when the file was modified.
 */
function applyEdits(file, edits, readFile, writeFile) {
    let source = readFile(file, 'utf8');
    let changed = false;
    for (const edit of edits) {
        if (source.includes(edit.marker)) continue;
        const anchorCount = occurrences(source, edit.anchor);
        if (anchorCount !== 1) {
            throw new Error(
                `windows-acl-grant: ${edit.name} anchor not found exactly once in ${file} (found ${anchorCount});`
                + ' re-check apps/tui-bin/harness-patches/windows-acl-grant.mjs against the harness version',
            );
        }
        source = source.replace(edit.anchor, edit.text);
        changed = true;
    }
    if (changed) writeFile(file, source, 'utf8');
    return changed;
}

/**
 * The edits, in the order they must apply.
 *
 * The import hangs off the runner-flag import because that line is qialike's own
 * insertion, so it is present exactly when `patchWindowsAclRunnerEntry` has run —
 * which is the ordering this patch requires and `build.mjs` guarantees. Anchoring
 * on the `node:fs` import instead would race the temp-sweep patch, which rewrites
 * that same line later in the build.
 * @returns the edit list.
 */
function grantEdits() {
    const gateCall = [
        '\t\t\t\t// qialike: wait for the one in-flight workspace grant, which a CHILD',
        '\t\t\t\t// process is applying (see @qialike/qialike-app/windows-acl-grant.ts).',
        '\t\t\t\t// `SetNamedSecurityInfoW` inherits an inheritable ACE to every existing',
        '\t\t\t\t// descendant inside this one synchronous call — minutes on a large',
        '\t\t\t\t// workspace, on the thread that also renders the UI (measured: 188.5 s',
        '\t\t\t\t// of frozen interface on a 352,634-object tree). The await moves it off',
        '\t\t\t\t// that thread; `grant.add` below stays the authority, so a child that',
        '\t\t\t\t// never ran leaves exactly the previous behaviour. Returns immediately',
        '\t\t\t\t// off Windows.',
        `\t\t\t\tawait ${GATE}(workspaceRoot, this.windowsAclRunnerInvocation());`,
        '\t\t\t\tgrant.add(workspaceRoot, true);',
    ].join('\n');
    return [
        {
            name: 'gate import',
            marker: GRANT_IMPORT_MARKER,
            anchor: 'import { WINDOWS_ACL_RUNNER_FLAG as QIALIKE_WINDOWS_ACL_RUNNER_FLAG } from "@qialike/qialike-app/src/windows-acl-mode.ts";\n',
            text: 'import { WINDOWS_ACL_RUNNER_FLAG as QIALIKE_WINDOWS_ACL_RUNNER_FLAG } from "@qialike/qialike-app/src/windows-acl-mode.ts";\n'
                + `import { ensureAclGrant as ${GATE} } from "@qialike/qialike-app/src/windows-acl-grant.ts";\n`,
        },
        {
            name: 'awaited workspace grant',
            marker: GRANT_GATE_MARKER,
            anchor: '\t\tif (!this.workspaceGrants.has(workspaceRoot)) {\n'
                + '\t\t\tconst grant = AclWriteGrant.create(writeSid);\n'
                + '\t\t\ttry {\n'
                + '\t\t\t\tgrant.add(workspaceRoot, true);\n',
            text: '\t\tif (!this.workspaceGrants.has(workspaceRoot)) {\n'
                + '\t\t\tconst grant = AclWriteGrant.create(writeSid);\n'
                + '\t\t\ttry {\n'
                + `${gateCall}\n`,
        },
        {
            name: 'async materializeAclGrant',
            marker: 'async materializeAclGrant(sessionId, workspaceRoot) {',
            anchor: '\tmaterializeAclGrant(sessionId, workspaceRoot) {\n',
            text: '\tasync materializeAclGrant(sessionId, workspaceRoot) {\n',
        },
        {
            name: 'awaited materializeAclGrant call',
            marker: 'await this.materializeAclGrant(',
            anchor: '\t\tconst temp = this.materializeAclGrant(sessionId, policy.workspaceRoot);\n',
            text: '\t\tconst temp = await this.materializeAclGrant(sessionId, policy.workspaceRoot);\n',
        },
        {
            name: 'async windowsAclRunnerArgv',
            marker: 'async windowsAclRunnerArgv(policy) {',
            anchor: '\twindowsAclRunnerArgv(policy) {\n',
            text: '\tasync windowsAclRunnerArgv(policy) {\n',
        },
        {
            name: 'async runnerArgv',
            marker: 'async runnerArgv(runner, policy) {',
            anchor: '\trunnerArgv(runner, policy) {\n',
            text: '\tasync runnerArgv(runner, policy) {\n',
        },
        {
            name: 'awaited runnerArgv call',
            marker: 'await this.runnerArgv(selected.runner, policy)',
            anchor: '\t\tconst runnerArgv = this.runnerArgv(selected.runner, policy);\n',
            text: '\t\tconst runnerArgv = await this.runnerArgv(selected.runner, policy);\n',
        },
    ];
}

/**
 * Apply the patch to the vendored `lib/` copy.
 * @param options - patch options.
 * @param options.root - the vendored `apps/tui-bin/x` directory.
 * @param options.file - explicit target path, for a tree whose package
 *   directories are not named the vendored way (the npm install).
 * @param options.readFile - injected reader (defaults to node:fs).
 * @param options.writeFile - injected writer (defaults to node:fs).
 * @param options.log - progress sink.
 * @returns the list of files actually modified.
 */
export function patchWindowsAclGrant({ root, file, readFile, writeFile, log = () => {} }) {
    const reader = readFile ?? readFileSync;
    const writer = writeFile ?? writeFileSync;
    const target = file ?? `${root}/-deepseek-ai-dsh-sandbox-local/lib/index.js`;
    // The live provider entry: the package's `exports["."].default` is
    // `./lib/index.js`, which inlines the `lib/types/index.js` region, so this one
    // file holds `confine()` and `materializeAclGrant` alike.
    if (applyEdits(target, grantEdits(), reader, writer)) {
        log(`windows-acl-grant: patched ${target}`);
        return [target];
    }
    log(`windows-acl-grant: already patched ${target}`);
    return [];
}

export { grantEdits as windowsAclGrantEdits };

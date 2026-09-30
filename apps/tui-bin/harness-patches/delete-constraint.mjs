/**
 * qialike build-time patch — P0-A: bring DELETE under the shell layer's
 * constraint by moving the confined token (and the trees it is granted) to Low
 * integrity.
 *
 * WHY THIS CARRIER: `deepseek-harness` is upstream and stays untouched, so every
 * harness-side fix is applied here, to the vendored `lib/` copy that
 * `pnpm build --single` stages under `apps/tui-bin/x/`. Anchors are literal and
 * asserted: a re-vendored harness that moved them fails the build loudly rather
 * than shipping a silently unconfined shell.
 *
 * WHY INTEGRITY LEVELS: the confined token is a WRITE_RESTRICTED restricted
 * token, and the kernel's pass-2 restricted check simply does not consider
 * DELETE / FILE_DELETE_CHILD — proven on `Documents\desktop.ini` (no restricting
 * SID in its DACL: GENERIC_WRITE denied, DELETE granted). Mandatory Integrity
 * Control DOES cover the write-class bits including DELETE while leaving read-up
 * alone, so the confined shell keeps "read everywhere" and loses only
 * out-of-scope write/delete, which then flows into the ordinary approval path.
 * The price is that an unlabeled (= Medium) object denies write-up from a Low
 * child, so the two trees the child is granted — the workspace root and the
 * session-private temp directory — must carry an inheritable Low label or the
 * shell could not write even where its ACL grant allows it.
 *
 * FAIL CLOSED: every step throws. A token that silently stayed Medium would
 * leave the delete hole open while looking confined, so the label is read back
 * and asserted; the same goes for a label that failed to stick on a granted
 * tree.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

/** Idempotency marker of the token-integrity edit. */
export const TOKEN_INTEGRITY_MARKER = 'setTokenIntegrityLow';
/** Idempotency marker of the granted-tree-label edit. */
export const LOW_LABEL_MARKER = 'setLowIntegrityLabel';
/** Path of the vendored package this patch targets, relative to `apps/tui-bin/x`. */
export const ACL_PACKAGE_DIR = '-deepseek-ai-dsh-sandbox-windows-acl/lib';

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

/**
 * Apply anchored edits to one file. Each edit is skipped when its marker is
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
        if (source.includes(edit.marker)) {
            if (occurrences(source, edit.marker) < edit.markerCount) {
                throw new Error(`delete-constraint: ${file} carries ${edit.name} incomplete (marker ${edit.marker})`);
            }
            continue;
        }
        const anchorCount = occurrences(source, edit.anchor);
        if (anchorCount !== 1) {
            throw new Error(
                `delete-constraint: ${edit.name} anchor not found exactly once in ${file} (found ${anchorCount});`
                + ' re-check apps/tui-bin/harness-patches/delete-constraint.mjs against the harness version',
            );
        }
        source = edit.position === 'after'
            ? source.replace(edit.anchor, `${edit.anchor}\n${edit.text}`)
            : source.replace(edit.anchor, `${edit.text}${edit.anchor}`);
        changed = true;
    }
    if (changed) writeFile(file, source, 'utf8');
    return changed;
}

/**
 * Stage 1 edits: create the Low-integrity restricted token.
 * @param indent - one indentation unit of the target file.
 * @param q - the target file's quote character.
 * @param tl - local name of the throwLastError helper in the target file.
 * @returns the edits for one file.
 */
function tokenIntegrityEdits(indent, q, tl) {
    const qq = (text) => `${q}${text}${q}`;
    const helper = [
        '/**',
        ' * qialike P0-A: lower the restricted token\'s integrity level to Low',
        ' * (S-1-16-4096). Mandatory Integrity Control covers the write-class bits',
        ' * (DELETE and FILE_DELETE_CHILD above all) that the WRITE_RESTRICTED pass-2',
        ' * check never inspects, and it leaves read-up allowed, so the confined shell',
        ' * keeps read-everywhere and loses only out-of-scope write/delete. FAILS',
        ' * CLOSED: any Win32 failure throws, and the label is read back and asserted',
        ' * \u2014 a token that silently kept Medium IL would look confined while the',
        ' * delete hole stayed open.',
        ' * @param api - the binding table.',
        ' * @param token - the restricted token to lower; SetTokenInformation',
        ' * TokenIntegrityLevel requires TOKEN_ADJUST_DEFAULT, which',
        ' * openCurrentProcessToken already requests.',
        ' */',
        'function setTokenIntegrityLow(api, token) {',
        `${indent}const sidSlot = allocPtrSlot();`,
        `${indent}if (api.convertStringSidToSidW(${qq('S-1-16-4096')}, sidSlot) === 0)`,
        `${indent}${indent}${tl}(api, ${qq('ConvertStringSidToSidW')}, ${qq('S-1-16-4096')});`,
        `${indent}const lowSid = decodePtr(sidSlot);`,
        `${indent}if (lowSid === null)`,
        `${indent}${indent}throwWin32(api, ${qq('ConvertStringSidToSidW')}, api.getLastError(), ${qq('null low-integrity SID')});`,
        `${indent}// TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES Label }: x64 is an 8-byte`,
        `${indent}// SID pointer, the 4-byte SE_GROUP_INTEGRITY(0x20) attributes, padding.`,
        `${indent}const label = Buffer.alloc(16);`,
        `${indent}label.writeBigUInt64LE(ptrAddress(lowSid), 0);`,
        `${indent}label.writeUInt32LE(0x20, 8);`,
        `${indent}// TokenIntegrityLevel === 25.`,
        `${indent}if (api.setTokenInformation(token, 25, label, label.length) === 0) {`,
        `${indent}${indent}const win32Code = api.getLastError();`,
        `${indent}${indent}api.localFree(lowSid);`,
        `${indent}${indent}throwWin32(api, ${qq('SetTokenInformation')}, win32Code, ${qq('TokenIntegrityLevel (Low)')});`,
        `${indent}}`,
        `${indent}api.localFree(lowSid);`,
        `${indent}// Read-back assertion: the label SID's last sub-authority must be 4096.`,
        `${indent}const sizeSlot = allocUint32();`,
        `${indent}api.getTokenInformation(token, 25, null, 0, sizeSlot);`,
        `${indent}const needed = decodeUint32(sizeSlot);`,
        `${indent}if (needed < 16)`,
        `${indent}${indent}throwWin32(api, ${qq('GetTokenInformation')}, api.getLastError(), \`implausible TokenIntegrityLevel size \${needed}\`);`,
        `${indent}const info = Buffer.alloc(needed);`,
        `${indent}if (api.getTokenInformation(token, 25, info, info.length, sizeSlot) === 0)`,
        `${indent}${indent}${tl}(api, ${qq('GetTokenInformation')}, ${qq('TokenIntegrityLevel')});`,
        `${indent}const labelSid = decodePtrAt(info, 0);`,
        `${indent}if (labelSid === null)`,
        `${indent}${indent}throwWin32(api, ${qq('GetTokenInformation')}, api.getLastError(), ${qq('null integrity SID')});`,
        `${indent}const rid = decodeUint32At(labelSid, 8 + (decodeUint8At(labelSid, 1) - 1) * 4);`,
        `${indent}if (rid !== 4096)`,
        `${indent}${indent}throw new Error(\`setTokenIntegrityLow: token integrity RID is \${rid}, expected 4096 (Low)\`);`,
        '}',
        '',
    ].join('\n');
    return [
        {
            name: 'token-integrity helper',
            marker: `${TOKEN_INTEGRITY_MARKER}(api, token) {`,
            markerCount: 1,
            anchor: `${q === '"' ? '' : 'export '}function createRestrictedToken(api, currentToken, logonSid, writeSids, known, mode) {`,
            position: 'before',
            text: helper,
        },
        {
            name: 'token-integrity call',
            marker: `${TOKEN_INTEGRITY_MARKER}(api, token);`,
            markerCount: 1,
            anchor: q === '"'
                ? `${indent}if (token === null) throwWin32(api, "CreateRestrictedToken", api.getLastError(), "null token handle");`
                : `${indent}if (token === null)\n${indent}${indent}throwWin32(api, 'CreateRestrictedToken', api.getLastError(), 'null token handle');`,
            position: 'after',
            text: `${indent}${TOKEN_INTEGRITY_MARKER}(api, token);`,
        },
    ];
}

/**
 * Stage 2 edits: label each granted tree Low, inside `AclSandbox.init()`.
 * @returns the edits for the bundled chunk (the file the runner loads).
 */
function lowLabelEdits() {
    const helper = [
        '/**',
        " * qialike P0-A: put the Low mandatory label (S-1-16-4096, policy",
        ' * SYSTEM_MANDATORY_LABEL_NO_WRITE_UP) on `path`, inherited by children.',
        ' *',
        ' * A Low-integrity child cannot write an unlabeled (= Medium) object at all,',
        ' * so both trees the child is granted — the workspace root and the',
        ' * session-private temp directory — must carry this label or the confined',
        ' * shell could not write even where its ACL grant allows it. (OI)(CI)',
        ' * inheritance is what carries the label onto files created later AND onto',
        ' * the pre-existing children Windows propagates an inheritable ACE to.',
        ' *',
        ' * A tree that already carries the label is left untouched: re-applying an',
        ' * inheritable ACE would re-propagate it over the whole tree on every',
        ' * session (the same reason the DACL grant path skips an exact ACE).',
        ' * Existing non-mandatory SACL ACEs (auditing) are preserved; a previous',
        ' * mandatory-label ACE is replaced. FAILS CLOSED: every Win32 failure',
        ' * throws, the descriptor is freed on every path, and the written label is',
        ' * read back and asserted.',
        ' * @param api - the binding table.',
        ' * @param path - the directory to label.',
        ' */',
        'function setLowIntegrityLabel(api, path) {',
        '\t// LABEL_SECURITY_INFORMATION === 0x10; the label lives in the SACL.',
        '\tconst saclSlot = allocPtrSlot();',
        '\tconst descriptorSlot = allocPtrSlot();',
        '\tconst queried = api.getNamedSecurityInfoW(path, 1, 16, null, null, null, saclSlot, descriptorSlot);',
        '\tif (queried !== 0) throwWin32(api, "GetNamedSecurityInfoW", queried, `LABEL_SECURITY_INFORMATION for ${path}`);',
        '\tconst descriptor = decodePtr(descriptorSlot);',
        '\tconst freeDescriptor = () => {',
        '\t\tif (!isNullPtr$1(descriptor) && !isNullPtr$1(api.localFree(descriptor))) throwLastError$1(api, "LocalFree", `LABEL_SECURITY_INFORMATION for ${path}`);',
        '\t};',
        '\tconst read16 = (ptr, offset) => decodeUint8At(ptr, offset) | (decodeUint8At(ptr, offset + 1) << 8);',
        '\tconst lowAce = (sacl) => {',
        '\t\tif (sacl === null) return false;',
        '\t\tconst aclSize = read16(sacl, 2);',
        '\t\tconst aceCount = read16(sacl, 4);',
        '\t\tlet offset = 8;',
        '\t\tfor (let index = 0; index < aceCount && offset + 4 <= aclSize; index++) {',
        '\t\t\tconst aceSize = read16(sacl, offset + 2);',
        '\t\t\tif (aceSize < 4) break;',
        '\t\t\tif (decodeUint8At(sacl, offset) === 17) {',
        '\t\t\t\tconst flags = decodeUint8At(sacl, offset + 1);',
        '\t\t\t\tconst sid = offset + 8;',
        '\t\t\t\tconst rid = decodeUint32At(sacl, sid + 8 + (decodeUint8At(sacl, sid + 1) - 1) * 4);',
        '\t\t\t\tif ((flags & 3) === 3 && rid === 4096) return true;',
        '\t\t\t}',
        '\t\t\toffset += aceSize;',
        '\t\t}',
        '\t\treturn false;',
        '\t};',
        '\tconst oldSacl = decodePtr(saclSlot);',
        '\tif (lowAce(oldSacl)) {',
        '\t\tfreeDescriptor();',
        '\t\treturn;',
        '\t}',
        '\tconst oldSize = oldSacl === null ? 0 : read16(oldSacl, 2);',
        '\tconst oldCount = oldSacl === null ? 0 : read16(oldSacl, 4);',
        '\tconst buffer = Buffer.alloc(oldSize + 32);',
        '\t// The mandatory-label ACE, written by hand: AddMandatoryAce (like AddAce)',
        '\t// validates a reused ACL against its AclSize capacity and rejects even a',
        '\t// valid empty ACL with ERROR_ALLOTTED_SPACE_EXCEEDED (1344, measured',
        '\t// here). The bytes are fixed: SYSTEM_MANDATORY_LABEL_ACE_TYPE(17),',
        '\t// (OI)(CI) inheritance, SYSTEM_MANDATORY_LABEL_NO_WRITE_UP(1), and the',
        '\t// Low SID S-1-16-4096 (revision 1, one sub-authority, authority 16).',
        '\t// The label ACE leads the SACL, the convention icacls produces.',
        '\tconst labelSid = [1, 1, 0, 0, 0, 0, 0, 16, 0, 16, 0, 0];',
        '\tconst labelSize = 8 + labelSid.length;',
        '\tbuffer.writeUInt8(17, 8);',
        '\tbuffer.writeUInt8(3, 9);',
        '\tbuffer.writeUInt16LE(labelSize, 10);',
        '\tbuffer.writeUInt32LE(1, 12);',
        '\tfor (let byte = 0; byte < labelSid.length; byte++) buffer.writeUInt8(labelSid[byte], 16 + byte);',
        '\tlet cursor = 8 + labelSize;',
        '\tlet kept = 1;',
        '\tif (oldSacl !== null) {',
        '\t\tlet offset = 8;',
        '\t\tfor (let index = 0; index < oldCount; index++) {',
        '\t\t\tconst aceSize = read16(oldSacl, offset + 2);',
        '\t\t\tif (aceSize < 4 || offset + aceSize > oldSize) {',
        '\t\t\t\tfreeDescriptor();',
        '\t\t\t\tthrow new Error(`setLowIntegrityLabel(${path}): malformed SACL ACE ${index}`);',
        '\t\t\t}',
        '\t\t\tif (decodeUint8At(oldSacl, offset) !== 17) {',
        '\t\t\t\tfor (let byte = 0; byte < aceSize; byte++) buffer.writeUInt8(decodeUint8At(oldSacl, offset + byte), cursor + byte);',
        '\t\t\t\tcursor += aceSize;',
        '\t\t\t\tkept += 1;',
        '\t\t\t}',
        '\t\t\toffset += aceSize;',
        '\t\t}',
        '\t}',
        '\tbuffer.writeUInt8(2, 0);',
        '\tbuffer.writeUInt8(0, 1);',
        '\tbuffer.writeUInt16LE(cursor, 2);',
        '\tbuffer.writeUInt16LE(kept, 4);',
        '\tbuffer.writeUInt16LE(0, 6);',
        '\tfreeDescriptor();',
        '\tconst written = api.setNamedSecurityInfoW(path, 1, 16, null, null, null, buffer);',
        '\tif (written !== 0) throwWin32(api, "SetNamedSecurityInfoW", written, `Low label for ${path}`);',
        '\t// Read-back: the object must now carry an (OI)(CI) Low mandatory ACE.',
        '\tconst verifySaclSlot = allocPtrSlot();',
        '\tconst verifyDescriptorSlot = allocPtrSlot();',
        '\tconst reverified = api.getNamedSecurityInfoW(path, 1, 16, null, null, null, verifySaclSlot, verifyDescriptorSlot);',
        '\tif (reverified !== 0) throwWin32(api, "GetNamedSecurityInfoW", reverified, `Low-label read-back for ${path}`);',
        '\tconst verifyDescriptor = decodePtr(verifyDescriptorSlot);',
        '\tconst labelled = lowAce(decodePtr(verifySaclSlot));',
        '\tif (!isNullPtr$1(verifyDescriptor)) api.localFree(verifyDescriptor);',
        '\tif (!labelled) throw new Error(`setLowIntegrityLabel(${path}): the Low label did not stick`);',
        '}',
        '',
    ].join('\n');
    return [
        {
            name: 'low-label helper',
            marker: `${LOW_LABEL_MARKER}(api, path) {`,
            markerCount: 1,
            anchor: 'function createRestrictedToken(api, currentToken, logonSid, writeSids, known, mode) {',
            position: 'before',
            text: helper,
        },
        {
            name: 'low-label call',
            marker: 'setLowIntegrityLabel(api, path);',
            markerCount: 1,
            anchor: '\t\t\tconst logonSid = findLogonSid(api, currentToken);',
            position: 'before',
            text: [
                '\t\t\t// qialike P0-A: the confined child runs at Low integrity, and the',
                '\t\t\t// kernel denies write-up to any unlabeled (= Medium) object, so both',
                '\t\t\t// granted trees must carry the Low label or the shell could not write',
                '\t\t\t// even where its ACL grant allows it. Read-only grants nothing and',
                '\t\t\t// labels nothing.',
                '\t\t\tfor (const path of this.writableDirs) setLowIntegrityLabel(api, path);',
                '\t\t\tif (tempDir !== null) setLowIntegrityLabel(api, tempDir);',
                '',
            ].join('\n'),
        },
    ];
}

/**
 * Find the bundled chunk that carries the ACL token code.
 *
 * The upstream bundler names split chunks with a CONTENT HASH
 * (`types-<hash>.js`), so a name pinned here goes stale on the next harness
 * rebuild: 0.1.5-rc.2 shipped `types-DuU3lSVe.js`, 0.1.7-alpha.2 ships
 * `types-DxezulnA.js` — and the pinned path turned the whole build into a raw
 * `ENOENT` from `readFileSync`. Resolve by CONTENT instead: the chunk carrying
 * any edit's anchor OR its idempotency marker (so the same search works before
 * and after patching).
 * @param root - the vendored package `lib` directory.
 * @param edits - the edits that must land in that chunk.
 * @param readFile - injected reader.
 * @returns the chunk path, or undefined when no chunk carries the anchor.
 */
function findTokenChunk(root, edits, readFile) {
    let entries;
    try {
        entries = readdirSync(root, { withFileTypes: true });
    } catch {
        return undefined;
    }
    for (const entry of entries) {
        if (!entry.isFile() || !/^types-.*\.js$/.test(entry.name)) continue;
        const file = `${root}/${entry.name}`;
        let source;
        try {
            source = String(readFile(file, 'utf8'));
        } catch {
            continue;
        }
        if (edits.some((edit) => source.includes(edit.anchor) || source.includes(edit.marker))) return file;
    }
    return undefined;
}

/**
 * Apply the P0-A delete-constraint patch to the vendored ACL package.
 * @param options - patch options.
 * @param options.root - the vendored package `lib` directory.
 * @param options.readFile - injected reader (defaults to node:fs).
 * @param options.writeFile - injected writer (defaults to node:fs).
 * @param options.log - progress sink.
 * @returns the list of files actually modified.
 */
export function patchDeleteConstraint({ root, readFile, writeFile, log = () => {} }) {
    const reader = readFile ?? readFileSync;
    const writer = writeFile ?? writeFileSync;
    const sourceToken = `${root}/types/token.js`;
    const tokenEdits = [...tokenIntegrityEdits('\t', '"', 'throwLastError$1'), ...lowLabelEdits()];
    const chunk = findTokenChunk(root, tokenEdits, reader);
    if (chunk === undefined) {
        throw new Error(
            `delete-constraint: no types-*.js under ${root} carries the ACL token anchor;`
            + ' the upstream bundle layout changed — re-check apps/tui-bin/harness-patches/delete-constraint.mjs'
            + ' against the harness version',
        );
    }
    const changed = [];
    if (applyEdits(chunk, tokenEdits, reader, writer)) {
        changed.push(chunk);
        log(`delete-constraint: patched ${chunk}`);
    } else {
        log(`delete-constraint: already patched ${chunk}`);
    }
    if (!existsSync(sourceToken)) {
        // The unbundled sources are a documentation mirror of the chunk, not a
        // runtime input; a farm that ships only the chunk is fine.
        log(`delete-constraint: ${sourceToken} not in the farm; the chunk carries the whole patch`);
        return changed;
    }
    if (applyEdits(sourceToken, tokenIntegrityEdits('    ', "'", 'throwLastError'), reader, writer)) {
        changed.push(sourceToken);
        log(`delete-constraint: patched ${sourceToken}`);
    } else {
        log(`delete-constraint: already patched ${sourceToken}`);
    }
    return changed;
}

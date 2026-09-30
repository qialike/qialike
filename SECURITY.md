# Security Policy

English | [中文](SECURITY.zh.md)

qialike runs an AI agent that reads your files, edits them and executes shell commands on your
machine. Its security properties are therefore part of the product, not an afterthought: the
sandbox rungs, the approval boundary, the credential store and the plugin trust ledger are all
described in the [README](README.md) under "Security boundaries", and a report that one of them can
be crossed is exactly the kind of report this file is about.

## Supported versions

Fixes ship as a **new release artifact**. There is no patch branch and no back-porting: the product
is distributed as a single-file binary per platform, so the fix reaches you by installing the new
version.

| Version | Supported |
| --- | --- |
| Latest release | ✅ |
| Previous minor release | ✅ (security fixes only) |
| Anything older | ❌ |

An upgrade is in place (`qialike upgrade`, or re-run the installer) and does not touch your sessions
or settings. See the README's "Updates" chapter.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

1. **Preferred** — open a private report through GitHub Security Advisories on this repository
   ("Security" → "Report a vulnerability"). The report, the discussion and the fix stay private
   until an advisory is published.
2. If you cannot use advisories, contact the maintainers through the address published on the
   project's website and say plainly that the message is a security report.

A useful report contains:

- the version (`qialike --version`) and the platform, terminal and OS build;
- the sandbox rung in force — `bubblewrap`, `landlock`, `seatbelt`, the Windows ACL runner, or
  `danger-full-access` if you deliberately switched to it;
- what you expected the boundary to do, what it did instead, and the smallest reproduction you
  have. Command lines, the relevant `~/.dsh/qialike.log` lines and a transcript beat a description;
- for a credential or prompt-injection issue: whether the model, a tool result, a skill, a plugin
  or a local file was the vector.

### What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement | 3 business days |
| Initial assessment (severity, affected versions, whether we can reproduce) | 10 business days |
| Fix or documented mitigation | Depends on severity; we will tell you the plan and keep you updated |

This is a volunteer community project: there is **no bug bounty**, and the timelines above are
best-effort commitments, not a contract. We will credit you in the advisory unless you ask us not
to.

## Scope

**In scope** — anything in this repository and in the artifacts it publishes:

- the TUI itself and its bundled plugins (`packages/qialike-app`, `apps/tui-bin`);
- the sandbox and approval boundary on every platform: bubblewrap and the embedded Landlock
  launcher on Linux, Seatbelt on macOS, the ACL restricted-token runner on Windows, and the
  `workspace-write` / `read-only` / `danger-full-access` policy ladder;
- the credential path: how API keys are stored, resolved, logged or leaked into a transcript,
  a session file or an export;
- the plugin trust ledger, and any way a local plugin can run without an explicit trust decision;
- the installer and the self-update path — signature/checksum handling, the release host selection,
  what is written to your shell profile;
- the read fence that keeps `.env`, `.git` internals and credential files out of the model's reach.

**Out of scope:**

- Vulnerabilities in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) or in any
  third-party dependency. Report them upstream; we will still act on anything that reaches qialike
  users through this repo (a version bump, a mitigation, a documented workaround).
- Vulnerabilities in a **model provider's** API or in a gateway you configured. qialike is a client;
  your prompts, code and keys go to whichever provider you selected, under that provider's terms.
- The website or any hosted service in a different repository — report those to the address
  published there, and say which project you mean.

## Behaviour that is by design, not a vulnerability

These are documented product decisions. A report about one of them will be answered with a pointer
to the docs, not a fix — unless you can show the documentation and the behaviour disagree:

- **`danger-full-access` reaches outside the workspace.** That is the point of the rung; it is
  opt-in, and the README says what it costs.
- **A local plugin runs in-process with full privileges.** Hence the explicit, revocable, per-harness
  -version trust decision (`qialike plugin trust`) and the hash that invalidates it on any edit.
- **The model sees your code, and the provider receives it.** That is what a coding agent does; the
  README's "Data and responsibility" chapter states it plainly.
- **A shell command you approve can do what you approved.** The approval dialog is the boundary;
  approving a command that writes outside the workspace is a decision, not a bypass.
- **Where no kernel confinement exists**, every shell call is approved one at a time instead of
  being silently allowed — the degraded mode is deliberate and announced (`SANDBOX_UNAVAILABLE`).

## Safe harbour

We will not pursue or support legal action against anyone who, in good faith, reports a
vulnerability, tests it against **their own** installation and data, and gives us a reasonable
window to fix it before publishing. Please do not test against other people's systems, do not
exfiltrate data that is not yours, and do not degrade anyone's service.

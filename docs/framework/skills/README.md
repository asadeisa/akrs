# Framework skills — the procedure bodies

These are the **canonical procedure templates** the specs point to. Each skill is the single
owner of one procedure; the specs and the kernel own only the *invariants* and reference the
skill by path. They live here, beside specs `01–11`, so they travel wherever the framework
travels — the npm tarball, `npx akrs-framework init`, a git clone — and sit in a plain visible
folder every agent can read (never a vendor dotfolder).

| Skill | Owns |
|---|---|
| [`akrs-close-out.md`](akrs-close-out.md) | The Road close-out procedure + the exact ledger-line format |
| [`akrs-live-verify.md`](akrs-live-verify.md) | The live-verification rig + the Test-Handoff template |

## How they are used (runtime)

At **Phase A**, the generating Leader instantiates each skill's canonical body at
`akrs/skills/<name>.md` (filling in any `<…>` slots) and emits a thin per-platform pointer at
`.claude/skills/<name>/SKILL.md` (frontmatter + one line: *"read and execute
`akrs/skills/<name>.md`"*) — see `02-Generation-Specification.md` and
`05-Platform-Adapter-Specification.md`. One body, thin pointers: the procedure never exists
twice.

Agents reach a skill only through its three routed discovery paths — the kernel pointer line, a
platform adapter, or a Task's `Skills:` field — never by ambient reading.

## Writing rule

Plain imperative markdown any model can execute. No vendor tool ids, no platform-only syntax;
shell steps as concrete runnable commands; browser automation described by capability, never by
a hardcoded tool name. Frontmatter is `name` + `description` only.

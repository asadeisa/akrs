# Framework skills — the procedure bodies

These are the **canonical procedure bodies** the specs point to. Each skill is the single owner
of one procedure; the specs and the kernel own only the *invariants* and reference the skill by
path. They live here, beside specs `01–11`, so they travel wherever the framework travels — the
npm tarball, `npx akrs-framework init`, a git clone — and sit in a plain visible folder every
agent can read (never a vendor dotfolder).

Skills teach the **intent commands first** (`work`, `done`, `yield`, `boot`, `test run`,
`test result`) and the primitives (`road finish`, `log append`, `test handoff`, ...) as the
fallback. The manifest help (`akrs --help`, `akrs <command> --help`) is the source of truth for
every command and flag a skill names.

| Skill | Role | Owns |
|---|---|---|
| [`akrs-classify-executors.md`](akrs-classify-executors.md) | Leader | The "which model, how strong?" question flow and `executor set` |
| [`akrs-road-author.md`](akrs-road-author.md) | Leader | Drafting from `template`, `road new/update/--patch`, fit, activation, the verification contract |
| [`akrs-work-loop.md`](akrs-work-loop.md) | Worker | The `work -> done` loop and `yield` |
| [`akrs-scope-request.md`](akrs-scope-request.md) | Worker + Leader | Asking for more scope, the Road envelope, `scope approve/reject/list` |
| [`akrs-close-out.md`](akrs-close-out.md) | Worker + Leader | The close-out procedure: `done`, `road finish`, the closure ledger, `state render` |
| [`akrs-live-verify.md`](akrs-live-verify.md) | Tester | The Plan-level live loop: `test-details -> test run -> test result` |

## How they are used (runtime)

`akrs agents setup` emits a thin per-agent pointer for each skill (`.agents/skills/<name>/SKILL.md`,
or a copy under `.claude/skills/` and `.qwen/skills/` for the agents that read only their own
folder) — frontmatter plus one line: *"Read and execute `<body path>`"*. The body is
`akrs/skills/<name>.md` when the project has such a folder, otherwise the copy that
`akrs init` installed under `docs/akrs/framework/skills/`. One body, thin pointers: the
procedure never exists twice. A skill needs no fill-in slots; project specifics (the launch
command, URL, budgets, evidence types) live in the Plan's verification contract.

Agents reach a skill only through its routed discovery paths — the kernel pointer line, the
agent's skill pointer, or the packet that names it — never by ambient reading.

## Writing rule

Plain imperative markdown any model can execute. No vendor tool IDs, no platform-only syntax;
shell steps as concrete runnable commands; browser automation described by capability, never by
a hardcoded tool name. Frontmatter is `name` + `description` only. A skill never repeats
another skill's procedure: it points to it by name.

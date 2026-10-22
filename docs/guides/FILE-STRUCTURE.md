# File Structure

> What every file is, who it's for, and what you must never edit.

There are two structures to understand:

1. **The repository** — this framework project (what you install/clone).
2. **A generated project** — what AKRS produces *inside your own project*.

---

## 1. This Repository

```text
akrs/
├── README.md                  Entry point + the philosophy behind AKRS
├── GETTING_STARTED.md         Human on-ramp — read this first
├── LICENSE                    MIT
├── CHANGELOG.md               What changed, per version
├── CONTRIBUTING.md            How to contribute
├── VERSIONING.md              Framework / Workflow / Kernel versioning
├── ROADMAP.md                 Where AKRS is going
├── RELEASE.md                 Maintainer release checklist
├── package.json               npm / pnpm / yarn metadata
│
├── bin/, lib/                 ← THE CLI (`akrs`): zero runtime dependencies, Node >= 22.17
│
├── docs/
│   ├── framework/             ← THE FRAMEWORK (the Leader reads this)
│   │   ├── 01-Constitution.md … 11-Change-Management-Specification.md
│   │   └── skills/            The procedure bodies (Leader, Worker, Tester)
│   │
│   ├── guides/                ← Human guides
│   │   ├── ROUTING-FLOW.md
│   │   ├── FILE-STRUCTURE.md  (this file)
│   │   └── TEAM-ADOPTION.md
│   │
│   ├── validation/            ← Proof it works (per-model + case study)
│   │
│   └── research/              ← History; not needed to use AKRS
│
├── examples/minimal/          ← A complete, runnable v2 workflow (validates clean)
└── templates/                 ← Reusable starting points (grows over time)
```

### Who reads what

| Audience | Reads |
|----------|-------|
| **You (first time)** | `README.md` → `GETTING_STARTED.md` → guides |
| **The Leader model** | `docs/framework/` (copied to `docs/akrs/framework/` by `akrs init`) |
| **The Worker / Tester model** | *Nothing here.* It runs `akrs work` / `akrs test-details` and reads the packet |
| **Contributors** | `CONTRIBUTING.md`, `docs/research/` |

> The Worker never reads this framework. That's the entire idea: heavy doctrine teaches the
> Leader; the Leader compiles a tiny **Kernel** and the CLI hands the Worker an exact packet.

---

## 2. A Generated Project (what AKRS creates in *your* repo)

```text
your-project/
├── AGENTS.md                  Canonical entry file (a managed block written by `akrs agents setup`)
├── CLAUDE.md, GEMINI.md       Thin pointers → AGENTS.md (per agent, managed blocks)
├── .agents/skills/ …          Thin skill pointers (or .claude/skills/, .qwen/skills/)
│
├── akrs/                      ← the workflow (the CLI's `--workflow-root`)
│   ├── kernel/                Compiled operating files — Leader-written Markdown
│   │   ├── CORE.md            Shared: route, modes, close-out, pointers (~1 page)
│   │   └── worker.md leader.md tester.md changer.md
│   ├── router.md              Routes only — "where next?"          (Leader-written Markdown)
│   ├── SOT-INDEX.md           SoT navigation index (only if the SoT is large / pre-exists)
│   ├── FEATURES.md            Landed-features index (one line per feature)
│   ├── changes/<id>.md        Ephemeral change files (deleted on merge-or-vanish)
│   │
│   ├── state.json             Canonical save-point             (CLI: `state set`)
│   ├── STATE.md               Derived, human-readable          (CLI: `state render`)
│   ├── executors.json         Executors + user-given classes   (CLI: `executor set`)
│   ├── roads/<id>.json        One per Task; reads/writes/checks/status (CLI: `road new/update`)
│   ├── roads/<plan>/<id>.json Same, grouped by Plan
│   ├── plans/<id>.json        Plan record: questions, seams, findings, closure   (CLI-owned)
│   ├── tasks/<id>.md          Narrative "what to build"        (CLI: `task new`; the model fills it)
│   ├── memory/<topic>.md      Reusable knowledge records       (CLI: `memory add`)
│   ├── log/NNNN.jsonl         Append-only closure ledger, rotated by the CLI (`log`, `log append`)
│   ├── scope/<road>.jsonl     Scope requests and yields        (CLI: `scope …`, `yield`)
│   ├── verifications/<plan>/
│   │   ├── contract.json      The Plan's verification contract (CLI: `test define`)
│   │   ├── handoff.jsonl      The Worker's baton, append-only  (CLI: `done`, `test handoff`)
│   │   ├── results.jsonl      Tester results, append-only      (CLI: `test result`)
│   │   └── evidence/<run>/    Run record + evidence files      (CLI: `test run`)
│   │
│   ├── drafts/                Agent-written input files, removed on success (git-ignored)
│   ├── .ops/                  Journal, locks, leases, guard allowlists — CLI only (git-ignored)
│   └── .cache/                Derived output: `view` board, `page` screenshots (git-ignored)
│
├── tests/                     Committed verification asserts (never discarded)
└── SOT/ or docs/              Your Source of Truth (you provide this)
```

> `akrs init --scaffold` writes a minimal working set (Road, Task, State, contract) in one
> transaction; the rest appears as you use it. Folders for large projects (per-domain Memory
> topics, a SoT Index) are optional.

### What each generated file owns

| File | Answers only | Written by | Must never contain |
|------|--------------|------------|--------------------|
| `kernel/CORE.md` + `kernel/<role>.md` | How do I operate here? | the Leader | Project knowledge / docs |
| `router.md` | Where do I go next? | the Leader | Explanations, implementation |
| `memory/*.md` | Which knowledge? (index) | `memory add` | Tutorials, duplicated docs |
| `roads/**/*.json` | Exactly what to read/change? | `road new/update`, lifecycle commands | Architecture essays |
| `tasks/*.md` | Exactly what to build? | `task new` + the model | Duplicated knowledge |
| `state.json` / `STATE.md` | Where did we leave off? | `state set` / `state render` | Knowledge (it points, never teaches) |
| `log/*.jsonl` | What closed, in what order? | `done`, `road finish`, `log append` | Telemetry, narrative |
| `verifications/**` | What must be tested, what happened? | `test …` | Anything deleted later |
| `FEATURES.md` | What has landed, and where? | the Leader | Teaching, implementation, rationale |

---

## What You Must Never Edit by Hand

- **Every machine file the CLI writes** — `roads/`, `plans/`, `state.json`, `executors.json`,
  `log/`, `verifications/`, `scope/`, `memory/`, `.ops/`. A hand-edited file fails its content
  hash and `akrs validate` reports it as unverified; nothing repairs it except restoring it from
  version control and using the command. To change one, write a draft and run the command (see
  `docs/framework/skills/akrs-road-author.md`).
- **`STATE.md`** — it is rendered output; `akrs state render` rewrites it.
- **`kernel/`** — it is *compiled* by the Leader (CORE + role files). Regenerate it; don't patch
  it ad hoc, or it drifts from the framework.
- **`router.md` / `memory/`** — only the **Leader** changes architecture. Workers reference these;
  they never redesign them.

What you *do* keep current, every time work lands: nothing by hand. The Worker's `akrs done`
closes the Road; the Leader runs `akrs state render` and `akrs validate`.

---

## After the Kernel exists, you can slim down

The framework docs you copied in with `npx akrs-framework init` (`docs/akrs/framework/`) are input
for the **Leader** — they matter while the workflow and the Kernel are being *generated*, and the
skills in `docs/akrs/framework/skills/` are what the agents' skill pointers read. Keep that
`skills/` folder (or copy it to `akrs/skills/`); the numbered specs can be deleted once your flow
works. Two things you should always **keep**:

- **`akrs/`** — your generated workflow. This *is* the system now.
- **Your Source of Truth** — the workflow points back to it as ground truth.

If you ever need the doctrine back, re-run `npx akrs-framework init --force`.

---

## The Framework-vs-Kernel Rule (the one to remember)

```
docs/framework/   =  source code   (versioned, teaches the Leader, ~6,000 words)
akrs/kernel/      =  compiled output (per-project, CORE + role files, ~1 page per session)
```

Only the framework is versioned and shared. The Kernel is regenerated for every project, from the
latest framework, using the strongest available model — so it keeps getting better over time
without you migrating anything.

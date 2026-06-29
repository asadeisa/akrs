# File Structure

> What every file is, who it's for, and what you must never edit.

There are two structures to understand:

1. **The repository** — this framework project (what you install/clone).
2. **A generated project** — what AKRS produces *inside your own project*.

---

## 1. This Repository

```text
akrs/
├── README.md                  Entry point + philosophy (the London story)
├── GETTING_STARTED.md         Human on-ramp — read this first
├── LICENSE                    MIT
├── CHANGELOG.md               What changed, per version
├── CONTRIBUTING.md            How to contribute
├── VERSIONING.md              Framework / Workflow / Kernel versioning
├── ROADMAP.md                 Where AKRS is going (CLI, generators…)
├── RELEASE.md                 Maintainer release checklist
├── package.json               npm / pnpm / yarn metadata
│
├── docs/
│   ├── framework/             ← THE FRAMEWORK (the Leader reads this)
│   │   ├── 01-Constitution.md
│   │   ├── 02-Generation-Specification.md
│   │   ├── 03-Execution-Contract.md
│   │   ├── 04-Developer-Interaction-Protocol.md
│   │   ├── 05-Platform-Adapter-Specification.md
│   │   ├── 06-Runtime-Boot-Protocol.md
│   │   ├── 07-State-And-Sync-Specification.md
│   │   └── 08-Kernel-Specification.md
│   │
│   ├── guides/                ← Human guides
│   │   ├── ROUTING-FLOW.md
│   │   └── FILE-STRUCTURE.md  (this file)
│   │
│   ├── validation/            ← Proof it works (per-model + case study)
│   │
│   └── research/              ← History; not needed to use AKRS
│       ├── v0/                Original v0 specification
│       ├── v0-benchmark/      v0 test harness (reference)
│       └── design-history/    v1 design analysis reports
│
├── examples/                  ← Sample projects (see examples/README.md)
└── templates/                 ← Reusable starting points (grows over time)
```

### Who reads what

| Audience | Reads |
|----------|-------|
| **You (first time)** | `README.md` → `GETTING_STARTED.md` → guides |
| **The Leader model** | `docs/framework/` |
| **The Worker model** | *Nothing here.* It reads the **Kernel** in your project |
| **Contributors** | `CONTRIBUTING.md`, `docs/research/` |

> The Worker never reads this framework. That's the entire idea: heavy doctrine
> teaches the Leader; the Leader compiles a tiny **Kernel** for the Worker.

---

## 2. A Generated Project (what AKRS creates in *your* repo)

After Phase A + first Phase B, your own project contains:

```text
your-project/
├── AGENTS.md                  Canonical entry file (boots the Kernel)
├── CLAUDE.md                  Thin pointer → @AGENTS.md (optional, per-tool)
│
├── akrs/
│   ├── KERNEL.md              ~1-page compiled operating file (the Worker boots this)
│   ├── router.md              Routes only — "where next?"
│   ├── STATE.md               Portable save-point — "where did we leave off?"
│   │
│   ├── memory/                Reusable knowledge, one owner per concept
│   │   ├── domain-model.md
│   │   ├── technical-stack.md
│   │   └── …
│   │
│   ├── tasks/                 "What to build" — generated on demand
│   │   └── <task>.md
│   │
│   └── roads/                 "What to read & change" — one per Task, has a Status
│       └── <task>.md
│
└── docs/
    └── app-info.md            Your Source of Truth (you provide this)
```

### What each generated file owns

| File | Answers only | Must never contain |
|------|--------------|--------------------|
| `KERNEL.md` | How do I operate here? | Project knowledge / docs |
| `router.md` | Where do I go next? | Explanations, implementation |
| `memory/*.md` | Which knowledge? (index) | Tutorials, duplicated docs |
| `roads/*.md` | Exactly what to read/change? | Architecture essays |
| `tasks/*.md` | Exactly what to build? | Duplicated knowledge |
| `STATE.md` | Where did we leave off? | Knowledge (it points, never teaches) |

---

## What You Must Never Edit by Hand (carelessly)

- **`KERNEL.md`** — it is *compiled* by the Leader. Regenerate it; don't patch it
  ad hoc, or it drifts from the framework.
- **`router.md` / `memory/`** — only the **Leader** changes architecture. Workers
  reference these; they never redesign them.

What you *do* keep current, every time work lands:

- **`STATE.md`** and the active **Road's Status** — via **close-out**.

---

## The Framework-vs-Kernel Rule (the one to remember)

```
docs/framework/   =  source code   (versioned, teaches the Leader, ~6,000 words)
akrs/KERNEL.md    =  compiled output (per-project, teaches the Worker, ~1 page)
```

Only the framework is versioned and shared. The Kernel is regenerated for every
project, from the latest framework, using the strongest available model — so it
keeps getting better over time without you migrating anything.

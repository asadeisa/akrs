# AKRS — Adaptive Knowledge Routing System

<img src="assets/banner.svg" alt="Without routing, an agent opens eleven whole files to find the three that mattered. With AKRS, it opens the same three — at the lines that mattered." width="100%">

> Deliver the smallest correct knowledge, to the correct agent, at the correct moment.

---

## What it is

Point an agent at a small project and it just works.

Point it at a real codebase and you watch it open eleven files to find the three
that mattered, reach for an approach you rejected two weeks ago, edit something
outside the ticket, and leave your docs describing code that no longer exists.
Every one of those files is still sitting in the context window when it finally
starts writing.

AKRS moves the thinking out of the prompt and into the repo.

Your strongest model reads the specification once and compiles a routing layer
into `akrs/`: a one-page Kernel, a Router, a Memory index, and one Road per task
naming exactly what to read, what to change, and where to stop. Every agent
after that boots from the routing layer instead of from your codebase — and
opens a **window** into each file it needs, never the whole file.

AKRS is not a memory system, not a documentation tool and not a planning tool.

**AKRS is a knowledge-routing doctrine plus the small CLI that runs it.** The
doctrine is a specification your strong model reads once and compiles into a
project-specific routing layer. The `akrs` CLI (zero runtime dependencies,
Node >= 22.17) then writes the workflow's records and hands every later agent —
on any model — **one exact packet** for what it is about to do, instead of
telling it to go find the context:

| Role | Entry | Happy path |
|---|---|---|
| Leader | `akrs boot` | classify executors, draft Roads, `road activate`, `plan finish` |
| Worker | `akrs work` | edit inside the packet, then `akrs done` (two calls) |
| Tester | `akrs test-details` | `akrs test run`, then `akrs test result` (three calls) |

The agent supplies the content; the CLI owns the form, so a weak model never
juggles hashes, request IDs or hand-written ledgers. Everything is plain files
in git, and every command also speaks `--json`, so a future app can consume the
same packets. It works with **any agent that boots from `AGENTS.md`**: Claude
Code, Codex, Gemini CLI, Pi, opencode, Kimi Code CLI, Qwen Code, Cursor,
Freebuff — through the CLI and skills everywhere, and through MCP
(`akrs mcp`) where the agent supports it.

---

## The Problem It Solves

Large projects create three challenges for AI agents:

- **Too much context** — Agent must scan thousands of files
- **Too many possible files** — Agent doesn't know what to read
- **Too many possible solutions** — Agent has no clear execution path

Large, expensive models survive this through brute force. Small models fail.

The objective is **not** reducing tokens. The objective is reducing the agent's
**decision space** before reasoning begins — the smaller the decision space, the
more predictable and reliable even a small execution model becomes.

AKRS doesn't make agents smarter. **It makes decision spaces smaller.**

---

## The Philosophy Behind AKRS

Imagine you land in London and need to find your friend's house.

**The way we usually do it:** you stop a random stranger and ask, *"Hey, where's my friend's house?"* The stranger has never met you, doesn't know your friend, and has no idea where you started from — so of course you get a shrug, or worse, a confident wrong turn.

That is almost exactly how we talk to an AI. We drop a whole problem on it and just *describe what we want* — with none of the context that would let it actually know where to go — and then we're surprised when it wanders, guesses, or builds the wrong thing.

**A better way** is to narrow the question down, one step at a time:
1. First the **city** — which district am I even in?
2. Then the **neighborhood** — which streets, which landmarks?
3. Then the **exact directions** to the door.

Each question is smaller and more specific than the last, so each answer gets sharper. By the final step there's really only one place left to go.

**AKRS works the same way:**
- **Router** knows the city (which Plan?)
- **Memory** knows the neighborhood (which Knowledge?)
- **Road** knows the street (which files?)
- **Worker** executes with perfect clarity

---

## How It Works

Every execution follows **one path** — each step narrows the decision space
before the AI reasons:

```mermaid
flowchart LR
    P[Prompt] --> M{Mode}
    M --> R[Router]
    R --> Mem[Memory]
    Mem --> Road[Road]
    Road --> E[Execute]
    M -. "fast path (Mode 0/1)" .-> Road

    classDef plan fill:#1f6feb,stroke:#0b3d91,color:#fff;
    classDef exec fill:#2da44e,stroke:#116329,color:#fff;
    class P,M,R,Mem plan;
    class Road,E exec;
```

> Full diagrams (modes, lifecycle, close-out) are in
> [`docs/guides/ROUTING-FLOW.md`](docs/guides/ROUTING-FLOW.md).

Each layer answers exactly one question:

| Layer | Answers |
|-------|---------|
| **Router** | Where should execution go? |
| **Memory** | Which knowledge do I need? |
| **Road** | Exactly what should I read? |
| **Task** | Exactly what should I build? |

Nothing is duplicated. Nothing is guessed. Everything is prepared.

### Not every prompt walks the full path

AKRS isn't a cage. The very first thing it does is pick a **Mode** that matches
what you actually asked — and most prompts never touch the full chain:

| Mode | When you'd use it | What runs |
|------|-------------------|-----------|
| **Mode 0** | You already know the exact file/area | Memory + the named files only — no routing |
| **Mode 1** | A small, isolated change | A single Road, fast path |
| **Mode 2** | A Task + Road already exist | Just execute the existing Road |
| **Mode 3** | New work that needs thinking | The Leader **plans**: one Task + one Road |
| **Mode 4** | Architecture / cross-cutting change | Leader only |

So a quick question, a one-file tweak, a "just try this and see," or a prompt
that has nothing to do with writing code at all — planning, exploring, asking
*"what would break if…"* — doesn't get dragged through the whole machine. You
pay for the full funnel only when the work is big enough to deserve it, and you
can always step outside the system entirely when you just want to talk to the
model directly.

> Full mode diagrams are in
> [`docs/guides/ROUTING-FLOW.md`](docs/guides/ROUTING-FLOW.md).

---

## Works With Any Agent

AKRS standardizes on **`AGENTS.md`** as the single canonical entry file. Every
other tool gets a thin pointer that just refers back to it — so the same
workflow behaves identically no matter which CLI you run it in, and a plan
started in one tool resumes in another from `STATE.md`.

```bash
akrs agents setup          # wire all nine agents (--agent <id> for one, --dry-run to preview)
akrs agents doctor         # what is current, missing or hand-modified, and the repair command
```

| Tool | Entry file | Skills | MCP |
|---|---|---|---|
| Claude Code | `CLAUDE.md` → `@AGENTS.md` | `.claude/skills/` | `.mcp.json` |
| Codex CLI, Pi, opencode, Kimi Code CLI, Cursor, Freebuff | `AGENTS.md` | `.agents/skills/` | per-agent config |
| Gemini CLI | `GEMINI.md` → `@./AGENTS.md` | `.agents/skills/` | `.gemini/settings.json` |
| Qwen Code | `AGENTS.md` | `.qwen/skills/` | `.qwen/settings.json` |

`akrs agents list` is the source of truth for each agent's verified facts. Setup only
merges managed blocks and entries inside the repository and never overwrites your content.
Specification: [`05-Platform-Adapter-Specification.md`](docs/framework/05-Platform-Adapter-Specification.md).

---

## Core Principles

- Knowledge has **exactly one owner**. Everything else references it.
- Knowledge is **never duplicated** across files.
- Knowledge is **only loaded when required**.
- Every file answers **one purpose**. If it solves two, split it.
- **Planning and execution** are different jobs. They never share the same path.

---

## Installation

The fastest way to use AKRS is to copy the framework into your project with a
single command — no permanent dependency, nothing buried in `node_modules`:

```bash
npx akrs-framework init
```

This drops the framework into **`docs/akrs/`** in your current project:

```
docs/akrs/
├── GETTING_STARTED.md   ← the human on-ramp
└── framework/           ← the doctrine the Leader reads (01..11 + skills/)
```

The files now live in your repo, ready to read and to hand to your Leader model. The same
package is the `akrs` CLI (`npx akrs-framework <command>`, or `akrs <command>` when installed).
Re-run `init` with `--force` to replace the copied doctrine and `akrs sync` to refresh it while
keeping local edits. The human guides live on GitHub (linked below).

<details>
<summary>Prefer a managed dependency, or just want to read the docs?</summary>

```bash
# Add as a dependency — a postinstall hook auto-syncs the framework
# out of node_modules into your project's docs/akrs/:
npm install akrs-framework      # or: pnpm add / yarn add akrs-framework

# Or simply clone the repo and read docs/ directly:
git clone https://github.com/asadeisa/akrs
```

Installing the package as a dependency runs a postinstall that syncs the doctrine into
`docs/akrs/framework/` so your workflow reads local files, never `node_modules`; it never
overwrites a local edit and always exits 0. (Set `AKRS_SKIP_POSTINSTALL=1` to opt out.)
</details>

---

## Quick Start (2 Minutes)

1. Run `npx akrs-framework init` in your project
2. Read `docs/akrs/GETTING_STARTED.md`
3. Let your Leader model build the workflow: it asks which models you use and how strong each
   is, then runs `akrs init --scaffold`
4. Wire your agents with `akrs agents setup`, and start your first Road
   (`akrs work` → `akrs done`)

---

## Validate Your Workflow

Once you have a generated `akrs/` workflow, keep it honest with the built-in validator:

```bash
npx akrs-framework validate            # 19 mechanical checks; exit 1 on a finding
npx akrs-framework validate --json     # one packet, for CI and tools
npx akrs-framework explain AKRS-S008   # rationale + remediation of any finding code
```

`validate` is read-only: it never fixes, rotates or deletes anything. A finding is repaired by
the writer command it names (for a stale `STATE.md`, `akrs state render`). Coverage is honest —
each check is `passed`, `failed`, `skipped` or `not_applicable`, and a skip is never counted as a
pass. It checks Roads (schema, identity, paths, dependencies, class fit), executors, `state.json`
and its rendered `STATE.md`, the closure ledger, scope requests, Memory records, verification
contracts and results, left-over drafts and the git posture. Run it at every close-out and in CI —
**CI green = workflow valid.** Zero dependencies.

> Declared Road checks are repository commands. `akrs done`, `akrs road finish` and
> `akrs verify` run them: use them only on workflows you trust, never on an untrusted checkout.

---

## Documentation

| Document | Purpose |
|----------|---------|
| [GETTING_STARTED.md](GETTING_STARTED.md) | Complete beginner guide (step-by-step) |
| [docs/guides/ROUTING-FLOW.md](docs/guides/ROUTING-FLOW.md) | Visual explanation of the execution path · *read online (GitHub) — not copied by `init`* |
| [docs/guides/FILE-STRUCTURE.md](docs/guides/FILE-STRUCTURE.md) | Folder organization and file ownership · *read online (GitHub)* |
| [docs/guides/TEAM-ADOPTION.md](docs/guides/TEAM-ADOPTION.md) | Mapping AKRS onto tickets, PRs, CI, and parallel work · *read online (GitHub)* |
| [docs/framework/](docs/framework/) | Complete framework specifications (incl. `skills/`) |
| [examples/minimal](examples/minimal/) | A complete, runnable v2 workflow that validates clean |
| [docs/framework/skills/](docs/framework/skills/) | The procedure bodies each role runs |
| [docs/validation/](docs/validation/) | Test results and case studies |

---

## Examples

[`examples/minimal`](examples/minimal/) is exactly what `akrs init --scaffold` writes plus two
executors — validate it with
`akrs validate --root examples/minimal --workflow-root examples/minimal/akrs`.

The most complete worked narrative is the **Atlas ERP case study** (written against the
first framework generation, so read its file names as history, not as the v2 layout):
[`docs/validation/case-study-atlas-erp.md`](docs/validation/case-study-atlas-erp.md).

---

## Validation & Testing

The first framework generation (v1, the evidence behind the doctrine) was tested with multiple
AI models:

| Model | Test | Result |
|-------|------|--------|
| **Claude (Sonnet)** | Framework generation (Phase A + Phase B) | ✅ Validated |
| **Gemini Flash** | Execution + close-out (drift prevention) | ✅ Validated |
| **DeepSeek** | Generation with requirement changes | ✅ Validated |

See `docs/validation/` for detailed test results and case studies.

**Key finding:** a less-capable model, given a one-line prompt and a
well-structured workflow, executed a real backend task, stayed inside scope, and
reconciled the workflow afterward — without ever asking what to read.

> **On cost.** AKRS deliberately does not record its own token or cost
> telemetry: an executing agent cannot know those numbers reliably, and asking
> for them only invites fabrication. Cost belongs to your provider's usage
> dashboard, correlated with the closure ledger's Road-by-Road chronology (`akrs log`).
> Model prices also fall every few months — the argument here is about decision
> space, which doesn't.

---

## Versioning

- **Framework Version:** v2 (specifications + the `akrs` CLI; the exact version is in
  `package.json` and the top of `CHANGELOG.md`)
- **Generated Workflows:** Versioned independently; a v2 workflow is a new v2 workflow (there is
  no migration from older Markdown workflows)
- **Kernel Version:** Generated per-project from the latest framework (a `kernel/` folder)

See `VERSIONING.md` for details.

---

## Contributing

AKRS is an open-source project. Contributions are welcome.

See `CONTRIBUTING.md` for guidelines:
- Reporting issues
- Submitting pull requests
- Documentation standards
- Release philosophy

---

## License

MIT License — see `LICENSE` for details.

AKRS is free to use, modify, and distribute in personal and commercial projects.

---

## Support

**Questions?**
- Start with `GETTING_STARTED.md`
- Check `docs/framework/` for specifications
- Review `examples/` for real projects
- Read `docs/validation/` for test results

**Found a bug?**
- Report it on GitHub, or email [asad.eisa.dev@gmail.com](mailto:asad.eisa.dev@gmail.com)

**Want to contribute?**
- See `CONTRIBUTING.md`

---

## What's Next?

👉 **New to AKRS?** Start with [`GETTING_STARTED.md`](GETTING_STARTED.md)

👉 **Want to understand the architecture?** Read [`docs/guides/ROUTING-FLOW.md`](docs/guides/ROUTING-FLOW.md)

👉 **Ready to build?** See the [case study](docs/validation/case-study-atlas-erp.md) and [`examples/`](examples/)

👉 **Looking for specifications?** See [`docs/framework/`](docs/framework/)

---

Made with care for developers who want reliable, predictable AI agents.

**AKRS v2** — see `CHANGELOG.md` for the release

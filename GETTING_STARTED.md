# Getting Started with AKRS

> A step-by-step guide to running your first AKRS workflow.
> Read this once. It takes about ten minutes. It will save you many hours.

This guide is written for **you, the developer** — not for the AI.
It is intentionally kept **outside** `docs/` because it is not part of the
framework the AI reads. It is the human on-ramp.

---

## Before You Begin

You need three things:

1. **A target project** — new or existing, any language.
2. **A strong "Leader" model** — the powerful model you trust to *think*
   (e.g. Claude Opus, GPT-5, Gemini Pro, DeepSeek). It plans once.
3. **A cheap "Worker" model** — the inexpensive model that *executes*
   (e.g. Gemini Flash, Haiku, a small local model). It runs many times.

> **The whole point of AKRS:** let the expensive model think **once**, so the
> cheap model can execute **reliably, many times**. If you only ever use one
> giant model for everything, you do not need AKRS — you are paying the London
> taxi to also be your map.

---

## The Mental Model (30 seconds)

You are in London looking for a friend's house.

You do **not** grab a random stranger and ask "take me there."
You narrow down: **city → neighborhood → street → door.**

AKRS gives the AI the same funnel:

```
Prompt → Mode → Router → Memory → Road → Execute
          city    area    street   door
```

Each step removes wrong options *before* the AI starts reasoning.
By the time the Worker writes code, there is only one obvious path left.

---

## Step 1 — Gather Your Inputs (Source of Truth)

Collect everything that describes what the project *should* be:

- Product/requirements docs
- Architecture notes or diagrams
- The existing repository (if any)
- Anything you'd hand a new senior engineer on day one

Put the authoritative document(s) somewhere obvious, e.g. `docs/app-info.md`.

> **Rule:** A confirmed Source of Truth is a *fact*. An unconfirmed one is an
> *assumption*. AKRS never starts on an assumption. You will confirm this with
> the Leader in Step 3.

---

## Step 2 — Install the Framework

```bash
npm install akrs-framework
# or
pnpm add akrs-framework
# or
yarn add akrs-framework
```

This gives you the framework specification (`docs/framework/`) — the doctrine
the Leader reads to learn *how* to build your workflow.

You can also simply clone this repository if you prefer to read the docs
directly.

---

## Step 3 — Ask the Leader to Generate the Workflow

Open your **strong** model. Point it at the framework and your Source of Truth.
A prompt like this works well:

```
You are the AKRS Leader. Read the AKRS v1 framework in docs/framework/.

My project's Source of Truth is: docs/app-info.md

Do this:
1. Confirm with me which documents are authoritative (Source of Truth).
2. Run Phase A: generate the workflow skeleton only —
   Router, Memory, Plans, Phases, and STATE.md.
3. Then generate the project KERNEL.md from 08-Kernel-Specification.md.

Do NOT generate Tasks or Roads yet. Do NOT write application code yet.
```

What you should get back (the **Phase A skeleton**):

```
akrs/
├── KERNEL.md         ← the compiled ~1-page operating file
├── router.md         ← "where do I go next?"
├── STATE.md          ← the portable save-point
└── memory/           ← one file per reusable knowledge area
```

> **Why no Tasks/Roads yet?** Pre-built tasks rot the moment requirements
> change. AKRS generates a Task + Road **on demand**, one at a time (Phase B).

---

## Step 4 — Make Sure There Is an Entry File

Every AI tool needs **one** file to boot from. AKRS standardizes on
**`AGENTS.md`** at the project root, with thin pointer files for specific tools
(`CLAUDE.md` → `@AGENTS.md`, etc.).

Check the project root. If you **do not** see `AGENTS.md` (or your tool's entry
file such as `CLAUDE.md`), ask the Leader:

```
There is no AGENTS.md at the project root. Create the canonical AGENTS.md
entry file per 05-Platform-Adapter-Specification.md. It must boot into
akrs/KERNEL.md.
```

A correct `AGENTS.md` is tiny — it just points the AI at the Kernel:

```markdown
# AGENTS.md
This project uses AKRS.
Boot: read `akrs/KERNEL.md`, then obey it. Do not execute before boot.
```

> This is a known, easy-to-miss step. If your first Worker run seems "lost,"
> 90% of the time it's a missing or wrong entry file.

---

## Step 5 — Generate Your First Task

Now ask the Leader for the **first real piece of work** (Phase B, Mode 3):

```
Generate the first Task and its Road for: "<the feature you want first>"
One Task, one Road, Status: ACTIVE. Update STATE.md. Do not execute.
```

You'll get:

```
akrs/
├── tasks/<your-task>.md   ← what to build
└── roads/<your-task>.md   ← exactly what to read & change (Status: ACTIVE)
```

Skim the Road. It should name the files to read, the files to change, and
explicit scope boundaries. If it does, you're ready to execute.

---

## Step 6 — Let the Worker Execute

Switch to your **cheap** Worker model. Give it a *minimal* prompt — do **not**
re-explain the project. The workflow already contains everything:

```
Implement the active Road.
```

That's it. A correctly built workflow means the Worker:

- boots `AGENTS.md → KERNEL.md`,
- finds the active Road from `STATE.md`,
- reads only what the Road tells it to,
- writes code inside the Road's scope,
- and stops at the boundaries.

> If the Worker starts asking "what should I read?" or wanders the repo, that's
> a **routing failure**, not a model failure. Fix the Road/Kernel, not the prompt.

---

## Step 7 — Close-Out (Do Not Skip This)

When work lands, the workflow must be reconciled with reality, or it will
silently drift. Ask the Worker (or do it yourself):

1. **Update `STATE.md`** — move the finished item to *Done*, set *Next*.
2. **Reconcile the Road** — either mark it `DONE + superseded by <memory>`
   or refresh its *Expected files* to match what actually shipped.
3. **Update Memory** if a reusable fact moved or changed owner.

> Close-out is the single discipline that keeps a Road and a Memory from ever
> disagreeing about what the code is. It is mandatory.

---

## The Loop, From Here On

```
Ask Leader for next Task + Road   (Phase B, once)
        ↓
Worker: "Implement the active Road."   (cheap, repeatable)
        ↓
Close-out   (update STATE + Road + Memory)
        ↓
repeat
```

Plan with the expensive model occasionally. Execute with the cheap model
constantly.

---

## Common Mistakes

| Mistake | Symptom | Fix |
|--------|---------|-----|
| Skipped Source-of-Truth confirmation | Workflow encodes wrong assumptions | Restart Phase A; confirm sources first |
| Pre-generated all Tasks/Roads up front | Roads rot after the first requirement change | Generate Tasks/Roads on demand (Phase B) |
| No `AGENTS.md` entry file | Worker boots into nothing, wanders | Create `AGENTS.md` (Step 4) |
| Over-explaining to the Worker | Wasted tokens; Worker ignores the Road | Give a minimal prompt; trust the Road |
| Skipping close-out | Road says X, code says Y (drift) | Run close-out every time work lands |
| Forcing Full structure on a tiny project | Ceremony > value | Use AKRS Lite or skip (see Constitution §12) |

---

## Troubleshooting

**"The Worker keeps leaving scope."**
The Road's boundaries are too loose. Tighten *Out of scope* / *Boundaries*.

**"The Worker asks what file to read."**
The Kernel or Road isn't being booted. Check `AGENTS.md` → `KERNEL.md` chain.

**"Two files disagree about the code."**
A close-out was skipped. Reconcile via `STATE.md` + Road status now.

**"My project is tiny — this feels heavy."**
It probably is. AKRS scales down: Kernel + Router + Roads (Lite), or skip
entirely for throwaway work. See `docs/framework/01-Constitution.md` §12.

---

## Where to Go Next

- **Understand the routing path:** [`docs/guides/ROUTING-FLOW.md`](docs/guides/ROUTING-FLOW.md)
- **Understand the files:** [`docs/guides/FILE-STRUCTURE.md`](docs/guides/FILE-STRUCTURE.md)
- **Read the doctrine:** [`docs/framework/`](docs/framework/)
- **See it proven:** [`docs/validation/`](docs/validation/)

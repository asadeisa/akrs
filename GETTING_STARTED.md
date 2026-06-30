# Getting Started with AKRS

> A step-by-step guide to running your first AKRS workflow.
> Read this once. It takes about ten minutes. It will save you many hours.

This guide is written for **you, the developer** — not for the AI.
It is intentionally kept **outside** `docs/` because it is not part of the
framework the AI reads. It is the human on-ramp.

---

## Before You Begin

You need three things:

1. **An AI model you can prompt.** Any capable agent will do. For the *planning*
   steps — generating the workflow and compiling the first Kernel — use your
   strongest model and turn its reasoning up. That thinking happens once, and
   everything downstream rides on it, so it's worth the horsepower. (Day-to-day
   execution can later run on a cheaper or faster model if you want — but that's
   an optimization, not a requirement.)
2. **The framework docs.** Drop them into your project with `npx akrs init`
   (they land in `docs/akrs/`). This is what the model reads to learn *how* to
   build your workflow. See **Step 2**.
3. **Your Source of Truth.** The document(s) that actually describe what the
   project should be — requirements, architecture notes, the existing repo.
   This is the ground everything is built on. See **Step 1**.

That's it.

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

## Step 2 — Add the Framework to Your Project

From inside your project, run:

```bash
npx akrs init
```

This copies the framework into **`docs/akrs/`** — the doctrine the Leader reads
to learn *how* to build your workflow:

```
docs/akrs/
├── GETTING_STARTED.md   (this guide)
├── framework/           (01..08 — the specification)
└── guides/              (routing flow + file structure)
```

Nothing is buried in `node_modules`; the files live in your repo where you and
the Leader can read them. Run `npx akrs init --force` later to refresh them.

> Prefer a managed dependency? `npm install akrs` (or `pnpm add` /
> `yarn add`) works too — it installs the same docs under
> `node_modules/akrs/`. Or just clone the repo and read `docs/`
> directly.

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

## Step 6 — Execute the Road

Now hand the active Road to whatever will do the building. This is the part that
repeats, so it's where you get to choose how:

- **Stay on the same strong model** you planned with — perfectly fine.
- **Drop to a cheaper/faster model** (Gemini Flash, Haiku, a small local model)
  to cut cost — the workflow is built to make that safe.
- **Fan it out to subagents** — keep your main agent as supervisor and let it
  delegate the actual edits to Sonnet/Haiku workers.

Whichever you pick, give it a *minimal* prompt — do **not** re-explain the
project. The workflow already contains everything:

```
Implement the active Road.
```

That's it. A correctly built workflow means the executor:

- boots `AGENTS.md → KERNEL.md`,
- finds the active Road from `STATE.md`,
- reads only what the Road tells it to,
- writes code inside the Road's scope,
- and stops at the boundaries.

> If it starts asking "what should I read?" or wanders the repo, that's a
> **routing failure**, not a model failure. Fix the Road/Kernel, not the prompt.

---

## Step 7 — Close-Out (the system handles it — you just confirm)

When work lands, the workflow has to be reconciled with reality or it slowly
drifts: the Road says one thing, the code says another. The good news is that
**a well-built AKRS workflow does its own close-out.** After finishing the Road,
a correct executor automatically:

1. **Updates `STATE.md`** — moves the finished item to *Done*, sets *Next*.
2. **Reconciles the Road** — marks it `DONE + superseded by <memory>`, or
   refreshes its *Expected files* to match what actually shipped.
3. **Updates Memory** — only if a reusable fact moved or changed owner.

So you usually don't *perform* close-out — you just **check that it happened.**
Open `STATE.md` and the active Road and glance at three things:

- Does *Done* list what was actually built?
- Does the Road's status / expected-files match the code?
- Did Memory stay an index (not turn into a dump of code details)?

If something's off, don't patch it by hand — point the AI back at it:

```
Close-out looks incomplete. Reconcile STATE.md, the active Road's status, and
Memory against what was actually built, per 07-State-And-Sync-Specification.md.
```

> Close-out is the one discipline that keeps a Road and a Memory from ever
> disagreeing about what the code is. Let the workflow do it — your job is just
> to confirm it did.

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

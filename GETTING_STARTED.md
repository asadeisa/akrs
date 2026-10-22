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
   execution can later run on a cheaper or faster model — that is the point.)
2. **Node.js 22.17 or newer.** AKRS is a zero-dependency CLI (`akrs`); you run it with
   `npx akrs-framework <command>`, or `akrs <command>` once the package is installed. Every
   command below is written `akrs …`.
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
npx akrs-framework init
```

This copies the framework into **`docs/akrs/`** — the doctrine the Leader reads
to learn *how* to build your workflow:

```
docs/akrs/
├── GETTING_STARTED.md   (this guide)
└── framework/           (01..11 + skills/ — the specification and the procedures)
```

Nothing is buried in `node_modules`; the files live in your repo where you and
the Leader can read them. Run `init --force` later to replace them, or `akrs sync` to refresh
them while keeping your local edits. (The human guides aren't copied — they're web-readable on
GitHub; links are at the bottom.)

> Prefer a managed dependency? `npm install akrs-framework` (or `pnpm add` / `yarn add`) works
> too — a postinstall hook copies the framework out of `node_modules/` into `docs/akrs/` without
> overwriting your edits. (Opt out with `AKRS_SKIP_POSTINSTALL=1`.)

---

## Step 3 — Ask the Leader to Generate the Workflow

Open your **strong** model. Point it at the framework and your Source of Truth.
A prompt like this works well:

```
You are the AKRS Leader. Read the AKRS framework in docs/akrs/framework/.

My project's Source of Truth is: docs/app-info.md

Do this:
1. Confirm with me which documents are authoritative (Source of Truth).
2. Ask me which models will do the work (Worker and Tester) and how I classify
   each: weak, medium or frontier. Record the answers with `akrs executor set`.
3. Run Phase A: create the workflow skeleton with `akrs init --scaffold`,
   then the Router and the Memory records.
4. Generate the project kernel folder (akrs/kernel/ — CORE.md + role files)
   from 08-Kernel-Specification.md.

Do NOT generate more Tasks or Roads yet. Do NOT write application code yet.
Never edit the files the akrs CLI writes; use the akrs commands.
```

**Expect one question about your models.** The Leader must ask how *you* classify each model
(weak, medium, frontier) — the CLI never guesses from a model's name. The class sets how big a
piece of work that model is given and how much hand-holding its instructions contain. Answer in
your own words; it is recorded verbatim.

What you should get back (the **Phase A skeleton**):

```
akrs/
├── kernel/           ← the compiled operating files (CORE + one role file per session)
├── router.md         ← "where do I go next?"
├── memory/           ← reusable knowledge records, one file per topic
├── executors.json    ← your models and the classes you gave them
├── state.json        ← the canonical save-point
├── STATE.md          ← the same, rendered for humans
├── roads/R1.json, tasks/T1.md, verifications/R1/contract.json   ← the starter Road
└── …
```

Check it yourself at any time:

```bash
akrs validate                     # nothing failed? the workflow agrees with itself
akrs road-details R1 --role worker   # exactly what a Worker would be handed for Road R1
akrs test-details R1              # exactly what a Tester would be handed (the scaffold's policy `none` needs no Tester pass)
```

> **Why no Tasks/Roads yet?** Pre-built tasks rot the moment requirements
> change. AKRS generates a Task + Road **on demand**, one at a time (Phase B).
>
> **Don't edit `akrs/` files by hand** (only `kernel/`, `router.md`, `tasks/` text and
> `SOT-INDEX.md` are Markdown the model writes). Roads, State, executors and ledgers are
> written by `akrs …` commands; a hand-edited one is reported as *unverified*.

---

## Step 4 — Wire Your Agents

Every AI tool needs one entry file to boot from. AKRS standardizes on **`AGENTS.md`**, with thin
pointers for specific tools (`CLAUDE.md` → `@AGENTS.md`, etc.). One command writes them all, plus
skill pointers and an MCP entry for the agents that support it:

```bash
akrs agents setup --dry-run     # preview every file it would create or merge into
akrs agents setup               # all nine agents, or: --agent claude
akrs agents doctor              # what is current, missing or hand-modified, and the repair command
```

It only adds managed blocks and merged entries inside your repository and never overwrites your
own content. A correct `AGENTS.md` block is tiny — it just points the AI at the CLI:

```markdown
## AKRS

This project uses AKRS. Leaders start with `akrs boot`; Workers run `akrs work`, then `akrs done`.
```

> If your first Worker run seems "lost," 90% of the time it's a missing or wrong entry file:
> run `akrs agents doctor`.

---

## Step 5 — Generate Your First Task

Now ask the Leader for the **first real piece of work** (Phase B, Mode 3):

```
Write the first Task and its Road for: "<the feature you want first>"
One Task, one Road, sized for the Worker I classified. Check it with `akrs road fit`,
then activate it. Do not execute.
```

The Leader writes a *draft* with its file tool and lets the CLI create the real files:

```
akrs template road --class weak --to-draft r2
   … the Leader fills akrs/drafts/r2.json …
akrs road new --input akrs/drafts/r2.json
akrs road fit R2        # fits | split_required | reads_over_budget
akrs road check R2      # readiness, and the snapshot the next command needs
akrs road activate R2 --if-snapshot <snapshot from road check>
```

You'll get:

```
akrs/
├── tasks/<your-task>.md        ← what to build (narrative)
└── roads/<your-task>.json      ← exactly what to read & change (status: ACTIVE)
```

Skim `akrs road-details <road>`. It should name the files to read (as line windows), the files
to change, explicit boundaries, and the checks that prove the work. If it does, you're ready.

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
Run `akrs work`, do what the packet says, then run `akrs done`.
```

That's it. A correctly built workflow means the executor:

- claims the Road with `akrs work` and receives one packet: the files to read (as windows), the
  files it may write, what is forbidden, the checks, the steps and what "done" means,
- writes code inside that scope (a pre-write hook, where the agent supports one, stops it
  leaving),
- and finishes with a single call:
  `akrs done R2 --result "<what is ready>" --reach "<how to get there>" --expect "<what to see>"`.

If it needs something the Road doesn't allow, it sends a scope request (`akrs scope request`) and
you or the Leader decide; if the Road is too big for its class it runs `akrs yield` and the Leader
splits it.

> If it starts asking "what should I read?" or wanders the repo, that's a
> **routing failure**, not a model failure. Fix the Road, not the prompt.

---

## Step 7 — Close-Out (the CLI handles it — you just confirm)

When work lands, the workflow has to be reconciled with reality or it slowly drifts. `akrs done`
does it in **one transaction**: it runs the Road's declared checks and a git audit, records the
baton for the Tester, marks the Road `DONE`, writes its closure to the ledger and releases the
lease. If anything is off, *nothing* is finished and the packet lists every blocker with its fix.

(`done` and `verify` execute the commands the Road declares. That is why they are for workflows
you trust.)

Then the Leader finishes the paperwork:

```bash
akrs state render      # STATE.md is derived output; re-render it
akrs validate          # CI green = workflow valid
```

For work that can be seen running, the **Tester** loop closes the Plan (the Leader declared a
verification contract with `akrs test define`; a model plays the Tester):

```bash
akrs test-details R2        # the one packet the Tester needs
akrs test run R2            # the CLI launches the product and runs the declared scenario
akrs test result R2 --verdict pass --because "the page shows what the Road promised"
```

In the Plan tier (`akrs init --scaffold --plan P1`) the Leader then closes the Plan:
`akrs plan finish P1 --dry-run` names every remaining blocker, then run it with the `--if-snapshot`
it prints. A single Road without a Plan ends at the Tester's result.

If something's off, don't patch a canonical file by hand — run the command the finding names
(`akrs explain <code>` says which), or point the AI back at it:

```
Close-out looks incomplete. Run akrs validate and fix what it reports with the akrs commands.
```

> Close-out is the one discipline that keeps a Road and a Memory from ever
> disagreeing about what the code is. Let the CLI do it — your job is just
> to confirm it did.

---

## The Loop, From Here On

```
Ask Leader for the next Task + Road   (Phase B, once)
        ↓
Worker: akrs work → edit → akrs done       (cheap, repeatable)
        ↓
Leader: akrs state render, akrs validate    (and the Tester loop for a Plan)
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
| Did not classify the models | `akrs validate` warns `AKRS-S006`; Roads cannot be activated | Tell the Leader how strong each model is; it runs `akrs executor set` |
| Pre-generated all Tasks/Roads up front | Roads rot after the first requirement change | Generate Tasks/Roads on demand (Phase B) |
| Wrote a Road too big for a weak model | The Worker is refused again and again, or yields | `akrs road fit`; split the Road |
| No `AGENTS.md` entry file | Worker boots into nothing, wanders | `akrs agents setup`, then `akrs agents doctor` |
| Hand-edited an `akrs/` machine file | `akrs validate` reports it as unverified | Restore it from git and use the command |
| Over-explaining to the Worker | Wasted tokens; Worker ignores the Road | Give a minimal prompt; trust the packet |
| Running `done`/`verify` on untrusted code | Declared checks execute commands | Only on workflows and checkouts you trust |
| Forcing Full structure on a tiny project | Ceremony > value | Use AKRS Lite or skip (see Constitution §12) |

---

## Troubleshooting

**"The Worker keeps leaving scope."**
The Road's boundaries are too loose. Tighten `writes`, `forbidden` and `boundaries` with
`akrs road update`; `akrs done` also refuses an undeclared change.

**"The Worker asks what file to read."**
It isn't using the packet. Check the `AGENTS.md` → `akrs work` chain with `akrs agents doctor`.

**"`akrs done` refuses and I don't see why."**
The packet lists every blocker with its fix. A failing declared check is the usual cause.

**"Two files disagree about the code."**
A close-out was skipped. Re-run `akrs validate` and `akrs state render`; the Leader reconciles
Memory.

**"I need a flag I can't find."**
`akrs <command> --help` prints that command's usage and flags; `akrs --help` lists them all.

**"My project is tiny — this feels heavy."**
It probably is. AKRS scales down: Kernel + Router + Roads (Lite), or skip
entirely for throwaway work. See `docs/framework/01-Constitution.md` §12.

---

## Where to Go Next

- **Try the smallest workflow:** [`examples/minimal`](https://github.com/asadeisa/akrs/tree/main/examples/minimal) — `akrs validate --root examples/minimal --workflow-root examples/minimal/akrs`
- **Understand the routing path:** [`ROUTING-FLOW.md`](https://github.com/asadeisa/akrs/blob/main/docs/guides/ROUTING-FLOW.md) (GitHub)
- **Understand the files:** [`FILE-STRUCTURE.md`](https://github.com/asadeisa/akrs/blob/main/docs/guides/FILE-STRUCTURE.md) (GitHub)
- **Read the doctrine and the procedures:** [`docs/framework/`](https://github.com/asadeisa/akrs/tree/main/docs/framework) (copied into your project's `docs/akrs/framework/`)
- **See it proven:** [`docs/validation/`](https://github.com/asadeisa/akrs/tree/main/docs/validation) (GitHub)

# AKRS State & Sync Specification (v2)

### The portable save-point, the closure ledger, and the Road close-out lifecycle

This spec solves two proven failures with one mechanism:

- **Drift:** Roads silently rot. In the first real implementation, a Road still edited
  `WorkCard.vue` while Memory and `git status` showed that file had been **deleted** and
  replaced by `WorkList.vue`. A Road and a Memory disagreed about reality, and nothing forced
  reconciliation.
- **Cross-CLI handoff:** a plan created in one CLI had no portable save-point another CLI could
  resume from.

The fix is a **canonical State** (`state.json`, rendered to the human-readable `STATE.md`), an
append-only **closure ledger**, a **Road lifecycle** the CLI enforces, and a mandatory **Road
close-out** (the reconciliation). In v2 every one of these is a machine record **written by the
CLI**: the agent supplies content, the CLI owns the form, the hash and the transaction.

> **Writer rule.** Machine-only artifacts are JSON or JSONL and are written only by their
> command. A hand-edited canonical file fails its content hash and is reported as `unverified`
> (detection, not a security boundary). Narrative a model or human reads (Tasks, Memory,
> `STATE.md`) is Markdown.

---

## 1. State — the portable save-point

`akrs/state.json` holds the Leader-owned fields — `mode`, `role`, `plan`, `phase`, `task`, and
an optional `next` note — plus who updated it and when. It is written only by
**`akrs state set`** (`--mode --role --plan --phase --task --next`, `--clear <field>`), which
re-renders `STATE.md` in the same transaction.

`akrs/STATE.md` is **disposable derived output**: **`akrs state render`** rewrites it from
`state.json`, the Roads, the closure ledger, the pending scope requests and the verification
records, and never reads the previous `STATE.md`. It must reproduce byte-identically from the
canonical inputs; a stale or hand-edited copy is reported (`AKRS-S008`) and replaced by the
next render. It **points; it never teaches**, and stays about one page.

Sections of the render:

- **Active** — mode, role, plan, task, and every ACTIVE Road;
- **Phase** — the Leader's phase note;
- **Done** — the last 3 closures only (full history is the ledger);
- **Next** — the Leader's `--next` note when one is set, otherwise a line **derived from the
  workflow** (a blocking scope decision, an ACTIVE Road, a Road ready to activate, a Plan ready
  for its Tester). A derived line is never a frozen instruction that stopped being true;
- **Ready** — QUEUED Roads whose dependencies are all DONE;
- **Blockers**, **Scope requests**, **Verification** — recomputed each render, never hand-kept.

`state.json` records the *answer* to a developer decision, never an unasked question
(`04-Developer-Interaction-Protocol.md §2.6`). Boot resumes from it (`06-Runtime-Boot-Protocol.md`).
For anything the agent should ask the CLI instead of reading prose, use the queries:
`akrs status` (everything), `akrs next` (legal next actions), `akrs stale` (what is no longer
current and why), `akrs graph` (Plans, Roads, dependencies, collisions), `akrs where <path>`.

---

## 2. The closure ledger — `akrs/log/`

The ledger is the history `STATE` is not allowed to hold: **one JSON record per closure**,
append-only, in segment files `akrs/log/0001.jsonl`, `0002.jsonl`, ... that the CLI rotates
before a segment would pass 80 lines. A record carries: `kind` (`road` | `plan`), `subject`,
`outcome` (`DONE` | `BLOCKED`), an optional `deviations` clause, a timestamp, and its own ID and
hash. Written by the lifecycle commands (`done`, `road finish`, `plan finish`) and by
`akrs log append`; rendered for humans by `akrs log`.

Invariants:

- **One record per closure** — a duplicate closure is rejected under the repository lock.
- **`deviations` only when reality diverged from the Road** — what the Road assumed -> what
  shipped, one clause. It is the one piece of knowledge with no other home.
- **No telemetry.** The ledger records neither model, effort, tokens, tools nor wall-clock time.
  An executing agent cannot know those values reliably; requiring them only invited
  fabrication. Cost lives in the provider's usage data and the PR.
- **Append-only; archived segments are byte-identical and never rewritten; never read at boot.**
- **Rotation is mechanical, never manual.** No agent counts entries.

The procedure that writes a closure is owned by the `akrs-close-out` skill.

---

## 3. Road `status` (the drift fix)

Every Road carries a `status` with exactly one of `QUEUED`, `ACTIVE`, `DONE`. **Lifecycle
commands own it**; `road update` cannot change it.

- `QUEUED` — written but not yet the current execution contract (batch generation is the source
  of QUEUED Roads, `02-Generation-Specification.md §4`). `akrs road check <id>` reports its
  readiness: dependencies DONE, an executor class and a matching executor, class fit, declared
  checks. **Before activation the Leader re-validates it** against Memory and the Source of
  Truth; if reality moved, it refreshes the Road with `road update` first.
- `ACTIVE` (`akrs road activate <id> --if-snapshot ...`) — dispatchable. A Worker **claims** a
  lease with `akrs work`; claiming is not a lifecycle change. Parallel ACTIVE Roads should not
  collide on writes: `akrs graph` shows collision edges and `road-details` lists each
  collision, so the Leader sees them before activating.
- `DONE` (`akrs done` by the Worker, or `akrs road finish` by the Leader) — the declared checks
  and the git audit passed, the closure is in the ledger and the lease is released.
- `akrs road reopen <id>` returns an ACTIVE or DONE Road to QUEUED and releases its lease; the
  ledger is never edited.

A Road that is still `ACTIVE` after its work landed, or whose declared `writes` no longer match
reality, is a **drift defect**. The finish commands refuse on an undeclared change; `validate`
reports a DONE Road whose declared file is gone.

**Dependency gating.** A Road lists `deps` (Road IDs). A Road whose deps are not all DONE
cannot become ACTIVE (`road activate` is blocked and names the dependency). There is no
override: reorder the dependency or split the Road.

**Leases.** A lease is one executor's claim on one ACTIVE Road (`akrs/.ops/leases/`, git-ignored,
per worktree). It covers the Road's *contract projection* — the Road, its dependency statuses,
its declared reads outside its own writes, scope resolution and the executors — and not the
holder's own product edits, so a Worker's work never stales its own lease. A changed projection
returns the delta and the fresh packet; `akrs work` refreshes the lease; `akrs lease release
<road>` frees a stuck one; `work --takeover` replaces a holder explicitly. A Plan-level Tester
lease is created by `akrs test run`.

---

## 4. Close-out (mandatory when work lands)

Reaching execution completion (`03-Execution-Contract.md §5`) is **not** the end. When work
lands the Worker closes the Road with **one call, `akrs done`**, and the Leader reconciles the
rest. The **procedure is owned by the `akrs-close-out` skill**; this spec owns only the
invariants:

- **Finish the Road** — checks and audit pass, handoff recorded, status `DONE`, closure written,
  lease released, in one transaction (`done`; `road finish` for the Leader).
- **Re-render the save-point** — `akrs state render`; the Leader updates `state set` fields only
  when they changed.
- **Update the owning Memory only if a contract changed** (a reusable fact moved owner or
  location), through `akrs memory add`.
- **One commit**, then `akrs validate`.

**Overhead budget.** Close-out touches **at most the Road, the ledger, State, one Memory and
one FEATURES line**, and the CLI writes all but the last two. If close-out regularly costs more
than that, the architecture must be simplified before it is expanded
(`01-Constitution.md §14`). Mechanical checking belongs to tooling, never to the agent.

**Plan completion is more than Road close-out.** When the last Road of a Plan lands, the
Plan-level pass runs against the running product (`akrs test run`, `akrs test result`;
`10-Verification-Specification.md`) and the Leader runs the Mirror Check. Only then does
`akrs plan finish <plan>` close it: every Road DONE, the latest Tester result a current pass with
its evidence and measurements, and no Tester finding, unowned seam or Plan question open. The
Plan then gets **one line in `akrs/FEATURES.md`**
(`11-Change-Management-Specification.md §2`).

---

## 5. Worked example (illustrative)

> Used only as a worked example. Fixing any specific portfolio file is a separate task.

**Drift observed:** `roads/A-C-content-rewire.json` (`ACTIVE`, writes include `WorkCard.vue`) vs.
Memory + `git status`, which show `WorkCard.vue` deleted and `WorkList.vue` added.

**What the v2 loop does at landing time:**

1. `akrs done` refuses while the change set includes an undeclared file or a declared check
   fails; the Worker has the Road corrected (a scope request, or the Leader's `road update`)
   until the declared writes match what shipped.
2. The finish writes the closure to the ledger and flips the Road to `DONE`.
3. The Leader runs `akrs state render`, records the moved fact with `akrs memory add`, and
   `akrs validate` confirms Road, Memory, State and ledger agree.

Result: one owner, no contradiction.

---

## 6. Mechanical validation

`akrs validate` is a **read-only query**: it never fixes, rotates or deletes anything (the CLI
rotates the ledger itself; a repair is the writer command a finding names). Coverage is honest:
every check reports `passed`, `failed`, `skipped` (inputs should exist but could not be parsed)
or `not_applicable` (the workflow legitimately has nothing for it), and `skipped` is never
counted as a pass. The 19 checks cover:

- Road schema, identity, path containment and case, dependency references and cycles,
  dependency readiness, executor class fit, executors and their classification;
- DONE Roads whose declared files exist (`done-writes-exist`);
- State and `STATE.md` agreement (`state`, `state-render`);
- the closure ledger and closure/Road consistency (`log`, `closure-consistency`);
- scope requests, Memory labels and pointers, verification contracts and results;
- left-over drafts, leftover v1 Markdown Roads (`legacy-forms`), git posture.

Every finding has a permanent code; `akrs explain <code>` returns its rationale and the
remediation. `akrs doctor` classifies the control-plane git posture (`tracked`, `ignored`,
`mixed`, `not_git`) and `akrs audit --git --road <id>` reports a Road's changes (undeclared,
declared, missing, pre-existing, workflow, test, evidence) without editing anything.

Run `validate` at **every close-out** and, recommended, as a **pre-commit hook / CI job**
(`akrs validate --json` is one packet; exit code `1` means a finding). The audit statement for
teams: **CI green = workflow valid.** Mechanical checking is the CLI's job, not the agent's.

`akrs verify --road <id>` is a different, narrower thing: it **executes the Road's declared
checks** (argv arrays only, bounded time and output) and reports one mechanical result each.
Those are repository-declared commands, so run `verify`, `done` and `road finish` **only on
workflows you trust**; never in an untrusted checkout.

---

## 7. Relationship to other documents

- Generation initializes State with `init --scaffold` or `state set`, and creates Roads with
  `road new` (`02-Generation-Specification.md §3–4`).
- Boot resumes from the State and the queries (`06-Runtime-Boot-Protocol.md`).
- The Execution Contract makes close-out a Worker obligation (`03-Execution-Contract.md §6`).
- The Kernel carries a one-line pointer to the `akrs-close-out` skill
  (`08-Kernel-Specification.md`).
- Assumption aging is owned by `02-Generation-Specification.md §6`; open-question expiry and the
  whole Plan-level verification pass are owned by `10-Verification-Specification.md`.
- Mutation safety (a repository lock, an operation journal in `akrs/.ops/`, recoverable
  multi-file transactions, `--dry-run` on every mutation, idempotent retries by request ID,
  snapshot guards) is the CLI's contract. Several renames are never described as atomic: a
  crashed transaction is completed or restored before the next mutation. A snapshot or a hash
  is change detection, **not a signature or a security boundary**.

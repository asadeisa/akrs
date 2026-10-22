# Team Adoption

> How AKRS maps onto the tools and rituals a software team already has — tickets, PRs, CI,
> parallel work, and the cost conversation. Keep the AKRS names; sell the mapping.

AKRS is not a replacement for your tracker, your VCS, or your CI. It is the **source of
truth** those tools become views of. This guide translates AKRS into vocabulary a team
already speaks.

---

## 1. Vocabulary translation

| AKRS term | Your team already calls it |
|-----------|----------------------------|
| **Road** | a scoped work order / a PR spec (scope + acceptance + files + checks) |
| **Executor class** (weak / medium / frontier) | the seniority level you assign a model, which sets how big a work order it gets |
| **Kernel** (`akrs/kernel/`) | the compiled system prompt (CORE + one role file per session) |
| **STATE** | the handoff doc / stand-up save-point (rendered, never hand-edited) |
| **Closure ledger** (`akrs/log/`) | the engineering journal (append-only) |
| **close-out** (`akrs done`) | your definition of done |
| **Memory** | the architecture-decision index |
| **Tester** | QA sign-off (verifies the running product, not the paperwork) |
| **Verification contract / handoff** | the test charter for one idea, and the developer's note to QA |
| **FEATURES** | the release-notes index (what landed, and where it lives) |

Nothing here asks the team to learn a new process — only to see the process it has through
one consistent index.

---

## 2. Tickets, PRs, and CI (tools become views; AKRS stays the source of truth)

- **Tickets.** The Task's objective and its Road's acceptance *are* the ticket body; put the
  external tracker ID in the Task's notes (or the commit message). The tracker becomes a view.
- **PRs.** **One Road = one branch/PR.** A Road already contains scope + acceptance + expected
  files, so the PR description generates straight from it — the Road *is* the PR template.
- **Close-out comments the ticket.** When a Road lands, `akrs done` writes the closure record
  and the handoff; mirror its one-line result into the ticket/PR.
- **CI.** CI runs `npx akrs-framework validate` (read-only, one packet with `--json`) **plus**
  the committed `tests/`. `validate` never executes a Road's declared checks; `done` and
  `verify` do, so run those only on code you trust. The audit
  statement is one line every engineering manager understands:

  > **CI green = workflow valid.**

  `validate` is zero-dependency, so it drops into any pipeline with no install step.

---

## 3. Parallel work

Roads are **parallel-safe by construction** — an under-marketed strength worth stating
plainly:

- Two `ACTIVE` Roads with **disjoint declared writes** cannot collide; `akrs graph` shows
  collision edges and `akrs road-details` lists each one before you activate.
- **A lease per Road** (`akrs work`) means two Workers cannot take the same Road by accident, and
  `STATE.md` lists every ACTIVE Road, so several Workers (or subagents) run at once against one
  save-point.
- **The closure ledger is append-only and written under a repository lock**, so concurrent
  close-outs never corrupt it (leases and the journal live in git-ignored `akrs/.ops/`, per
  worktree). Multi-worktree orchestration is not part of v2.

A team scales AKRS across people the same way it scales across sessions: split the work into
Roads with non-overlapping file sets and run them side by side.

---

## 4. ROI — the cost conversation

AKRS deliberately does **not** fabricate cost telemetry. Earlier ledgers asked the executing
agent to record `model=`, `effort=`, `tokens=`, and `wall=` — values an agent cannot know
reliably and, in practice, made up. The closure ledger (`akrs/log/`, rendered by `akrs log`) is a
bare chronology: one record per closure with its kind, subject (Road or Plan ID), outcome
(`DONE` or `BLOCKED`) and an optional `deviations` clause.

The cost slide comes from sources that actually measure cost — **the provider's usage
dashboard, CI wall-clock, and PR metadata** — correlated with the ledger's Road-by-Road
chronology (which Roads landed, in what order, on which model you chose to run them). The
framework's thesis — *let a strong model think once so cheap models execute many times* — is
still a number a team can put in front of finance; it just comes from the meter, not from a
figure the agent invented.

---

## 5. Rollout, lightly

1. `npx akrs-framework init` in the repo; confirm the Source of Truth with the Leader.
2. Have the Leader ask the team how each model is classified (weak, medium, frontier), then
   generate the Phase A skeleton and the kernel folder; run `akrs agents setup` to wire every
   agent the team uses.
3. Wire `npx akrs-framework validate` into CI (and, optionally, a pre-commit hook).
4. Run one Road end-to-end (branch → `akrs work` → `akrs done` → PR → ledger line); show the
   team the PR that generated itself from the Road.

See [`FILE-STRUCTURE.md`](FILE-STRUCTURE.md) for the file layout and
[`ROUTING-FLOW.md`](ROUTING-FLOW.md) for the execution path.

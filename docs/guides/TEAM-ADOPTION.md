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
| **Road** | a scoped work order / a PR spec (scope + acceptance + files) |
| **Kernel** (`akrs/kernel/`) | the compiled system prompt (CORE + one role file per session) |
| **STATE** | the handoff doc / stand-up save-point |
| **LOG** | the engineering journal (append-only) |
| **close-out** | your definition of done |
| **Memory** | the architecture-decision index |
| **Tester** | QA sign-off (verifies the running product, not the paperwork) |
| **Handoff** (`akrs/verify/*`) | the test charter for one idea |
| **FEATURES** | the release-notes index (what landed, and where it lives) |

Nothing here asks the team to learn a new process — only to see the process it has through
one consistent index.

---

## 2. Tickets, PRs, and CI (tools become views; AKRS stays the source of truth)

- **Tickets.** A Task may carry an optional `Ticket:` field (external tracker id). The Task's
  objective/acceptance *is* the ticket body; the tracker becomes a view.
- **PRs.** **One Road = one branch/PR.** A Road already contains scope + acceptance + expected
  files, so the PR description generates straight from it — the Road *is* the PR template.
- **Close-out comments the ticket.** When a Road lands, close-out writes `LOG.md` and can
  mirror that one-line summary into the ticket/PR.
- **CI.** CI runs `npx akrs-framework validate` **plus** the committed `tests/`. The audit
  statement is one line every engineering manager understands:

  > **CI green = workflow valid.**

  `validate` is zero-dependency, so it drops into any pipeline with no install step.

---

## 3. Parallel work

Roads are **parallel-safe by construction** — an under-marketed strength worth stating
plainly:

- Two `ACTIVE` Roads with **disjoint Expected files** cannot collide; the `validate` CLI
  enforces the disjointness (check 4).
- **STATE `## Active` becomes a table** — one row per active Road — so several Workers (or
  subagents) can run at once against one save-point.
- **`LOG.md` is append-only**, so concurrent close-outs never merge-conflict.

A team scales AKRS across people the same way it scales across sessions: split the work into
Roads with non-overlapping file sets and run them side by side.

---

## 4. ROI — the cost conversation

Every close-out appends a metrics line to `LOG.md`:

```
Metrics: road=<ID> model=<name> effort=<level> result=<landed|blocked> usage=<x%>
```

That line is the **instrumentation**. Twenty entries are the cost slide: which model ran each
Road, at what effort, landed or blocked, at what token cost. The framework's whole thesis —
*let a strong model think once so cheap models execute many times* — becomes a number a team
can put in front of finance, straight out of the journal it was already keeping.

---

## 5. Rollout, lightly

1. `npx akrs-framework init` in the repo; confirm the Source of Truth with the Leader.
2. Generate the Phase A skeleton + the kernel folder; add `AGENTS.md`.
3. Wire `npx akrs-framework validate` into CI (and, optionally, a pre-commit hook).
4. Run one Road end-to-end (branch → PR → close-out → `LOG.md` metrics line); show the team
   the PR that generated itself from the Road.

See [`FILE-STRUCTURE.md`](FILE-STRUCTURE.md) for the file layout and
[`ROUTING-FLOW.md`](ROUTING-FLOW.md) for the execution path.

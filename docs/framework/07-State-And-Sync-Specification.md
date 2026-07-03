# AKRS State & Sync Specification (v1)

### The portable save-point, the append-only journal, and the Road close-out lifecycle

This is a **new v1 capability**. It solves two proven v0 failures with one file-based
mechanism:

- **Drift (P2):** Roads silently rot. In the first real implementation, a Road still edited
  `WorkCard.vue` while Memory and `git status` showed that file had been **deleted** and
  replaced by `WorkList.vue`. A Road and a Memory disagreed about reality, and nothing forced
  reconciliation.
- **Cross-CLI handoff (P5):** a plan created in one CLI had no portable save-point another
  CLI could resume from.

The fix is **`STATE.md`** (the save-point) plus a mandatory **Road close-out** (the
reconciliation). v1.2 splits the historical record out into an append-only **`LOG.md`** so
the save-point stays small.

---

## 1. `akrs/STATE.md` — the portable save-point

Tool-neutral markdown, lives in the repo, written by whichever tool/session is active. It
**points**; it never teaches.

**Hard budget: `STATE.md` ≤ ~1 page (~300 words).** It is *rewritten fresh* at every
close-out — never appended. The full narrative belongs in `LOG.md` (§2). `Done` holds only
the **last 3** landed items, one line each; older history lives only in `LOG.md`.

**Required fields:**

- Active **Mode**, active **Plan / Phase / Task**, active **Road**, and **`Role:`** — who is
  operating (`leader | worker | tester`). When Roads run in parallel, `## Active` may be a
  **table** (one row per active Road).
- **Done** — the last 3 landed items only, one line each.
- **Next** — the single most obvious next step.
- **Open questions** — unresolved Unknowns / decisions awaiting the Developer; each owned by a
  Plan and expiring at that Plan's close-out (`10-Verification-Specification.md §7`).
- **Last updated** — timestamp + which tool/session wrote it.

**Template:**

```markdown
# STATE
Updated: 2026-06-28T14:05Z by claude-code

## Active
- Mode: 3 (Planning)
- Role: worker
- Plan / Phase / Task: Portfolio / Content / rewire-work-list
- Road: roads/content-rewire-work-list.md (Status: ACTIVE)

## Done   (last 3 only — full history in LOG.md)
- WorkCard.vue removed; WorkList.vue created and routed.
- Router points at WorkList.vue.
- Memory projects.md updated to WorkList.vue.

## Next
- Generate the next Task on request.

## Open questions
- (none)
```

**Parallel form** — when several Roads are `ACTIVE` at once, `## Active` becomes a table with
one row per Road (parallel-ACTIVE Roads must have disjoint Expected files — §3):

```markdown
## Active
- Mode: 3 · Role: leader
| Road | Plan/Phase/Task | Status | Expected files |
|------|-----------------|--------|----------------|
| roads/a.md | P1/Ph1/a | ACTIVE | src/a.js |
| roads/b.md | P1/Ph1/b | ACTIVE | src/b.js |
```

Boot reads `STATE.md` to resume (`06-Runtime-Boot-Protocol.md §5`). Because it is plain,
tool-neutral markdown, no tool-specific names leak into Roads, and any CLI can pick the work
up exactly where it left off.

---

## 2. `akrs/LOG.md` — the append-only close-out journal

`LOG.md` is the history `STATE.md` is no longer allowed to hold. Full close-out narratives
(what landed, why, how) go here — **one entry per close-out, newest at the bottom**. It is
**never read at boot** and **never edited retroactively**; append-only files don't
merge-conflict, so concurrent close-outs are safe.

Each entry ends with one **metrics line**:

```
Metrics: road=<ID> model=<name> effort=<level> result=<landed|blocked> usage=<x%>
```

Twenty entries are the ROI evidence the whole system exists to produce (the LOG is the
instrumentation the `TEAM-ADOPTION.md` cost story reads).

```markdown
## 2026-06-28 — content-rewire-work-list
Removed WorkCard.vue, created WorkList.vue, rewired the router and Memory. The old card
component was superseded; projects.md is now the single owner of the component's truth.
Metrics: road=content-rewire-work-list model=gemini-flash effort=low result=landed usage=8%
```

---

## 3. Road `Status` (the drift fix)

Every Road carries a **`Status`** field with exactly one of:

- `QUEUED` — the Road is generated but not yet the current execution contract. A `QUEUED`
  Road **must be re-validated against Memory + STATE before activation** (the staleness rule:
  if reality moved, the Leader refreshes the Road first). Batch generation is the source of
  `QUEUED` Roads (`02-Generation-Specification.md §4`).
- `ACTIVE` — the Road is the current execution contract. At most a **small number** of Roads
  are `ACTIVE` at once, and parallel-`ACTIVE` Roads must have **disjoint Expected files**.
- `DONE + superseded by <memory>` — the work landed; the named Memory now owns the truth.

A Road that is still `ACTIVE` after its work has landed, or whose *Expected files* no longer
match reality, is a **drift defect**.

**Dependency gating.** A Road may carry an optional `Deps:` field (a list of Road IDs). A
Road whose `Deps` are not all `DONE` **cannot become `ACTIVE`** without an explicit developer
override recorded in `STATE.md`. (This is the rule that would have caught the mirror-test
C2-before-E3 inversion, where the Worker was forced to invent an input contract.)

---

## 4. Close-out (mandatory when work lands)

Reaching execution completion (`03-Execution-Contract.md §5`) is **not** the end. Before the
work is considered done:

```
Work lands
  ↓
Append narrative + metrics to LOG.md      (history — never read at boot)
  ↓
Rewrite STATE.md ≤ 1 page                 (move objective → Done[last 3], set Next, refresh timestamp+author)
  ↓
Reconcile the Road:
   retire  → Status: DONE + superseded by <memory>
   or
   refresh → update Expected files / scope to match what actually shipped
  ↓
Update Memory if a reusable fact changed owner or location
  ↓
Done
```

**Overhead budget (D12).** Close-out touches **at most LOG + STATE + the Road + one Memory +
one FEATURES line**. If close-out regularly costs more than that, the architecture must be
simplified before it is expanded (`01-Constitution.md §14`). Mechanical checking belongs to
tooling, never to the agent.

**Plan completion is more than Road close-out.** When the last Road of a Plan lands, the
Plan-level verification pass runs against the running product before the Plan may close —
Mirror Check, raw measurement, seam ownership, and open-question resolution
(`10-Verification-Specification.md §1, §4–7`). Road-level close-out keeps the paper in sync;
the Plan-level pass proves the product is actually right. The Plan then appends **one line to
`akrs/FEATURES.md`** (name · Plan · key Roads/Memories · SoT section —
`11-Change-Management-Specification.md §2`).

Close-out is the step that makes the drift case above impossible: the moment `WorkCard.vue` was
replaced by `WorkList.vue`, close-out would have refreshed the Road's *Expected files* (or
retired it) and updated Memory — so Road and Memory could never disagree.

---

## 5. Canonical case study (illustrative)

> **Used here only as a worked example.** Fixing any specific portfolio file is a separate
> task and is out of this framework's edit scope.

**Drift observed:** `roads/A-C-content-rewire.md` (`Status: ACTIVE`, Expected files include
`WorkCard.vue`) vs. `memory/projects.md` + `git status`, which show `WorkCard.vue` deleted
and `WorkList.vue` added.

**What close-out would have done at landing time:**

1. `LOG.md` → one entry: "WorkCard.vue removed, WorkList.vue created" + metrics line.
2. `STATE.md` → *Done:* "WorkCard.vue removed, WorkList.vue created"; *Next:* "point Memory
   at WorkList.vue."
3. Road → `DONE + superseded by memory/projects.md` **or** *Expected files* updated to
   `WorkList.vue`.
4. `memory/projects.md` → now the single owner of the component's truth.

Result: one owner, no contradiction.

---

## 6. Optional lint (later)

A tiny validator can later check, mechanically:

- Does every Road have a legal `Status` (`QUEUED` / `ACTIVE` / `DONE + superseded`) and
  reference files that **exist**?
- Is any `ACTIVE` Road gated by an unfinished `Deps` entry (without a recorded override)?
- Is `STATE.md` within its size budget and carrying its required fields?
- Is any fact **duplicated** across a Memory and a Road?

This is an optional hardening step, not required for the framework to be usable.

---

## 7. Relationship to other documents

- Generation initializes `STATE.md` at the end of Phase A and updates it in Phase B
  (`02-Generation-Specification.md §3–4`).
- Boot reads `STATE.md` to resume (`06-Runtime-Boot-Protocol.md`).
- The Execution Contract makes close-out a Worker obligation (`03-Execution-Contract.md §6`).
- The Kernel carries the one-line close-out rule and the `STATE.md` / `LOG.md` pointers
  (`08-Kernel-Specification.md`).
- Assumption aging is owned by `02-Generation-Specification.md §6`; open-question expiry at
  Plan close-out and the whole Plan-level verification pass are owned by
  `10-Verification-Specification.md`.

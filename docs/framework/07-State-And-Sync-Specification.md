# AKRS State & Sync Specification (v1, revised v1.3)

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
reconciliation). v1.2 splits the historical record out into an append-only **`LOG.md`**; v1.3
demotes that journal to a **one-line ledger** so close-out costs ~20 words instead of ~450.

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

## 2. `akrs/LOG.md` — the append-only ledger

`LOG.md` is the history `STATE.md` is not allowed to hold — demoted in v1.3 from a narrative
journal to a **ledger: ONE line per close-out, newest at the bottom**. It is **never read at
boot** and **never edited retroactively**; append-only files don't merge-conflict, so
concurrent close-outs are safe.

The **exact ledger-line format is owned by the `akrs-close-out` skill**
(`skills/akrs-close-out.md`); this spec owns only the invariants:

- **One line per close-out**, plus an optional `deviations:` line **only when reality diverged
  from the Road** — the one piece of knowledge with no other home.
- Each line carries the metrics the ROI table reads: **model, effort, tokens, tools, and
  wall-clock minutes** (`wall=`). These are the ROI evidence the whole system exists to produce
  (the ledger is the instrumentation the `TEAM-ADOPTION.md` cost story reads).
- **Append-only, newest at the bottom; never rewritten; never read at boot.**
- **Rotation is mechanical, never manual.** When the ledger crosses the CLI's threshold
  (200 entries or 16 KB), `validate --fix` rotates it into a read-only `LOG-<NNN>.md` archive
  and starts a fresh `LOG.md` — so no agent ever counts entries (§6, `bin/akrs.js`).

Why keep the ledger at all: the metrics series (the ROI number the framework exists to prove)
and the cross-road chronology live nowhere else — Roads are archived per-file, and git history
can't be read by an agent in one pass. A one-line ledger keeps both at a fraction of the words.

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

Reaching execution completion (`03-Execution-Contract.md §5`) is **not** the end. When work
lands the Worker (or the Leader on hand-off) runs the close-out, whose **procedure is owned by
the `akrs-close-out` skill** (`skills/akrs-close-out.md`) — instantiated per project at
`akrs/skills/akrs-close-out.md`. This spec owns only the invariants:

- **Flip the Road** — retire it (`Status: DONE + superseded by <memory>`) or refresh its
  Expected files / scope to match what actually shipped.
- **Append one ledger line** to `LOG.md` (+ optional `deviations:` line — §2).
- **Rewrite `STATE.md` ≤ 1 page** — objective → *Done* (last 3), set *Next*, refresh the
  timestamp + author.
- **Update the owning Memory only if a contract changed** (a reusable fact moved owner or
  location).
- **One commit**, then `validate`.

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

1. `LOG.md` → one ledger line for the close-out (Road ID · DONE · metrics).
2. `STATE.md` → *Done:* "WorkCard.vue removed, WorkList.vue created"; *Next:* "point Memory
   at WorkList.vue."
3. Road → `DONE + superseded by memory/projects.md` **or** *Expected files* updated to
   `WorkList.vue`.
4. `memory/projects.md` → now the single owner of the component's truth.

Result: one owner, no contradiction.

---

## 6. Mechanical validation

The lint now exists as a shipped command: **`npx akrs-framework validate`** (zero-dependency,
in `bin/akrs.js`). It checks, mechanically, what the agent should never have to:

- every Road has a legal `Status` and its *Expected files* exist on disk (DONE Roads exempt);
- no `ACTIVE` Road is gated by an unfinished `Deps` entry (without a STATE override);
- parallel-`ACTIVE` Roads have disjoint Expected files;
- `STATE.md` exists, carries its required fields, is within its word budget, and **parks no
  unasked owner decision** ("pending/awaiting owner" phrasing warns — `04 §2.6`);
- the `LOG.md` ledger stays a ledger: an over-long ledger entry warns, and when the ledger
  crosses the rotation threshold (200 entries / 16 KB) `--fix` archives it to `LOG-<NNN>.md`;
- the kernel folder is present and within budget; mirrored Road statuses agree with the
  canonical `Status:`; `SOT-INDEX`/`FEATURES` references resolve; ephemeral artifacts
  (handoff / change / BLOCKED / tester memory) are not stale.

Run it at **every close-out** and, recommended, as a **pre-commit hook / CI job**. `--fix`
syncs mirrored statuses and rotates an over-threshold ledger; `--clean` deletes stale
ephemerals. The audit statement for teams: **CI green = workflow valid.** Mechanical checking
is the CLI's job, not the agent's (D12).

---

## 7. Relationship to other documents

- Generation initializes `STATE.md` at the end of Phase A and updates it in Phase B
  (`02-Generation-Specification.md §3–4`).
- Boot reads `STATE.md` to resume (`06-Runtime-Boot-Protocol.md`).
- The Execution Contract makes close-out a Worker obligation (`03-Execution-Contract.md §6`).
- The Kernel carries a one-line pointer to the `akrs-close-out` skill and the `STATE.md` /
  `LOG.md` pointers (`08-Kernel-Specification.md`); the ledger-line format is owned by that
  skill (`skills/akrs-close-out.md`), not by this spec.
- Assumption aging is owned by `02-Generation-Specification.md §6`; open-question expiry at
  Plan close-out and the whole Plan-level verification pass are owned by
  `10-Verification-Specification.md`.

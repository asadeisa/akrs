# AKRS State & Sync Specification (v1)

### The portable save-point and the Road close-out lifecycle

This is a **new v1 capability**. It solves two proven v0 failures with one file-based
mechanism:

- **Drift (P2):** Roads silently rot. In the first real implementation, a Road still edited
  `WorkCard.vue` while Memory and `git status` showed that file had been **deleted** and
  replaced by `WorkList.vue`. A Road and a Memory disagreed about reality, and nothing forced
  reconciliation.
- **Cross-CLI handoff (P5):** a plan created in one CLI had no portable save-point another
  CLI could resume from.

The fix is **`STATE.md`** (the save-point) plus a mandatory **Road close-out** (the
reconciliation).

---

## 1. `akrs/STATE.md` — the portable save-point

Tool-neutral markdown, lives in the repo, written by whichever tool/session is active. It
**points**; it never teaches.

**Required fields:**

- Active **Mode**, active **Plan / Phase / Task**, active **Road**.
- **Done** — what landed.
- **Next** — the single most obvious next step.
- **Open questions** — unresolved Unknowns / decisions awaiting the Developer.
- **Last updated** — timestamp + which tool/session wrote it.

**Template:**

```markdown
# STATE
Updated: 2026-06-28T14:05Z by claude-code

## Active
- Mode: 3 (Planning)
- Plan / Phase / Task: Portfolio / Content / rewire-work-list
- Road: roads/content-rewire-work-list.md (Status: ACTIVE)

## Done
- WorkCard.vue removed; WorkList.vue created and routed.

## Next
- Update Memory `projects.md` to point at WorkList.vue, then close out the Road.

## Open questions
- (none)
```

Boot reads `STATE.md` to resume (`06-Runtime-Boot-Protocol.md §5`). Because it is plain,
tool-neutral markdown, no tool-specific names leak into Roads, and any CLI can pick the work
up exactly where it left off.

---

## 2. Road `Status` (the drift fix)

Every Road carries a **`Status`** field with exactly one of:

- `ACTIVE` — the Road is the current execution contract.
- `DONE + superseded by <memory>` — the work landed; the named Memory now owns the truth.

A Road that is still `ACTIVE` after its work has landed, or whose *Expected files* no longer
match reality, is a **drift defect**.

---

## 3. Close-out (mandatory when work lands)

Reaching execution completion (`03-Execution-Contract.md §5`) is **not** the end. Before the
work is considered done:

```
Work lands
  ↓
Update STATE.md            (move objective → Done, set Next, refresh timestamp+author)
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

Close-out is the step that makes the case in §0 impossible: the moment `WorkCard.vue` was
replaced by `WorkList.vue`, close-out would have refreshed the Road's *Expected files* (or
retired it) and updated Memory — so Road and Memory could never disagree.

---

## 4. Canonical case study (illustrative)

> **Used here only as a worked example.** Fixing any specific portfolio file is a separate
> task and is out of this framework's edit scope.

**Drift observed:** `roads/A-C-content-rewire.md` (`Status: ACTIVE`, Expected files include
`WorkCard.vue`) vs. `memory/projects.md` + `git status`, which show `WorkCard.vue` deleted
and `WorkList.vue` added.

**What close-out would have done at landing time:**

1. `STATE.md` → *Done:* "WorkCard.vue removed, WorkList.vue created"; *Next:* "point Memory
   at WorkList.vue."
2. Road → `DONE + superseded by memory/projects.md` **or** *Expected files* updated to
   `WorkList.vue`.
3. `memory/projects.md` → now the single owner of the component's truth.

Result: one owner, no contradiction.

---

## 5. Optional lint (later)

A tiny validator can later check, mechanically:

- Does every Road reference files that **exist**?
- Does every Road have a `Status`?
- Is any fact **duplicated** across a Memory and a Road?

This is an optional hardening step, not required for the framework to be usable.

---

## 6. Relationship to other documents

- Generation initializes `STATE.md` at the end of Phase A and updates it in Phase B
  (`02-Generation-Specification.md §3–4`).
- Boot reads `STATE.md` to resume (`06-Runtime-Boot-Protocol.md`).
- The Execution Contract makes close-out a Worker obligation (`03-Execution-Contract.md §6`).
- The Kernel carries the one-line close-out rule and the `STATE.md` pointer
  (`08-Kernel-Specification.md`).

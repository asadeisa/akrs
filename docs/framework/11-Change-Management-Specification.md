# AKRS Change-Management Specification (v1.2)

### How requirements change without leaving broken data behind

This is a **new v1.2 capability**. It owns one question:

> How do requirements change without leaving broken data behind?

It exists because mid-project feature adds and changes had **no procedure**: stale Roads
survived, the SoT drifted, and nobody could say what a change touched. This document is the
single owner of the change lifecycle; other docs point here and never restate it.

---

## 1. The problem

Adding, changing, or removing a feature mid-project today is unmanaged. A new requirement
arrives; the Leader edits the SoT; and downstream, `QUEUED` Roads built against the old truth
still look valid, Memories still point at superseded facts, and no artifact records what the
change *touched*. The result is exactly the drift v1 close-out fixed for one Road — but at
the scale of a whole feature. Change needs its own path.

---

## 2. `akrs/FEATURES.md` — the landed-features index

`FEATURES.md` is the index of what has actually landed. **One line per landed idea/feature:**

```
<name> · <owning Plan> · <key Roads/Memories> · <SoT section>
```

Example:

```
adaptive-quality · P3-Rendering · roads/adaptive.md, memory/rendering.md · data.md §6
win-screen · P4-Gameplay · roads/win-ui.md, memory/gameplay.md · data.md §4.2
```

- Appended at **Plan close-out** — **one line** (this is the "+ one FEATURES line" inside the
  D12 overhead budget; `01-Constitution.md §14`).
- It is **Memory-class**: it points, never teaches. It carries no implementation, no
  rationale — only *what landed and where it lives*.
- It is the **first thing the change path reads**: to change a feature, you must first find
  it.

---

## 3. The change file

`akrs/changes/<id>.md` is created **on demand** by the **Leader in Mode 4** (the "changer"
hat — D9), never pre-generated. It holds:

- **Intent** — what is changing and why.
- **SoT diff** — the exact Source-of-Truth sections added / changed / removed.
- **Impact list** — built from `FEATURES.md` + `SOT-INDEX.md` (when present): the affected
  Plans, Memories, and `QUEUED` Roads.
- **Conflicts flagged to the Developer** — *before anything is edited*, the Leader surfaces
  where the change may collide with an existing feature and presents options, so the Developer
  decides (the diagram's "flag the user if it may conflict with other features").

```markdown
# change: raise-frame-budget   (id: C-0007)
Intent: SoT performance budget 20→30 FPS at 480×270.
SoT diff: data.md §6 — budget line updated.
Impact (FEATURES + SOT-INDEX): P3-Rendering (adaptive-quality), memory/rendering.md,
  QUEUED roads/bvh-wire.md.
Conflicts: adaptive-quality assumes the 20 FPS floor — Developer: keep floor / retune / drop?
```

---

## 4. Completion — merge or vanish

A change file is **ephemeral** and never persists (D14):

- **Landed change** → update the SoT (it stays the single truth) → update `FEATURES.md` →
  **delete the change file** (named deleter: the **Leader**).
- **Rejected change** → delete the change file with **one `LOG.md` line** recording the
  rejection.

No orphan artifacts, ever. Road retirement / regeneration mechanics are **not** restated here
— §5 is their sole owner.

---

## 5. Requirements-delta procedure (the single owner of re-validation)

When the confirmed SoT changes mid-project (Mode 4), the Leader runs:

```
Diff the SoT               (via SOT-INDEX when present — 09)
  ↓
List affected              Plans / Memories / QUEUED Roads   (from FEATURES + the impact list)
  ↓
Re-validate or regenerate  each affected item:
   · retire a superseded Road   → Status: DONE + superseded by <memory>
   · refresh a stale QUEUED Road → per the staleness rule (07 §3 / 02 §4)
   · re-point or update Memory   where a fact moved
  ↓
Record the delta           in STATE.md + LOG.md
```

This is the one place re-validation mechanics live. Generation and boot point here; they
never carry their own copy. A superseded Road is retired, never left `ACTIVE` against a truth
that moved — that is the drift defect, prevented at feature scale.

---

## 6. Relationship to other documents

- The Mode-4 "changer" path is declared in `01-Constitution.md §9`; the **FEATURES** artifact
  row is in `01 §6`; the close-out budget "+ one FEATURES line" is in `01 §14` and
  `07-State-And-Sync-Specification.md §4`.
- Generation points here for the requirements-delta procedure
  (`02-Generation-Specification.md §1, §6`).
- The impact list reads `FEATURES.md` + `SOT-INDEX.md`
  (`09-Scale-And-Source-Index-Specification.md`).
- The Kernel carries the FEATURES-append close-out line and the Mode-4 change hint
  (`08-Kernel-Specification.md`).

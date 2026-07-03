# AKRS Verification Specification (v1.2)

### When is landed work actually right?

This is a **new v1.2 capability**. It owns one question:

> When is landed work actually *right*?

It exists because AKRS produces exceptional paper and, before v1.2, defined "Done"
**documentarily, not experientially**. In the mirror-test, a game shipped with all 72 tests
green, all 10 plans `DONE`, and every artifact internally consistent — while running at
**~0.4 FPS**, with an invisible win state and a HUD that reported "FPS: 10" as frames took
2.6 s. No artifact in AKRS could have caught it, because nothing in the loop was ever required
to look at the **product** instead of the paperwork. This document adds that requirement.

It is authority for verification mechanics; other docs point here and never restate its
content.

---

## 1. Principle — Done is experiential

Paper-vs-paper agreement (Road ↔ Memory ↔ STATE) proves **sync**, never **correctness**. It
is necessary and nowhere near sufficient. Therefore:

> **At least one step per Plan must look at the running product.**

The honest statement of why: the mirror-test shipped a 0.4 FPS product with all 72 tests
green and every artifact consistent. Consistency was perfect and the product was unplayable.
Verification is the gate that makes that outcome impossible.

---

## 2. Granularity — verify the idea, not every Task (D13)

Verification attaches to the **idea / Plan level**, never to every Task. Testing every word
typed is exactly the overhead the framework forbids (D12). Task front-matter gains an optional
`Verify:` field:

- `none` — developer-observable trivia (e.g. a button's shape). **Explicitly legal** — an
  unverified Task is not a defect when its effect is directly observable by the developer.
- `idea` — covered by the Plan-level verification pass. **This is the default** when `Verify:`
  is absent.
- `measured` — carries its own raw-measurement budget line (§5).

The Leader sets `Verify:` at generation time. Absence means `idea`.

---

## 3. The Test-Handoff file

`akrs/verify/<plan>-handoff.md` is the baton between execution and verification.

- **Created by the Worker during execution** — short, append-only notes: *what became
  observable, how to reach it, what should happen*. It is a baton, not a report; keep it
  small.
- Flagged **"ready"** when the Plan's idea is complete and runnable.
- **Consumed by the Tester**, who verifies against the running product. On **pass**, the
  Tester **deletes it** (the named deleter is the Tester — D14).
- On **bug**: the Tester writes findings (the file stays), the Leader routes the fix, then
  the idea is re-tested.

```markdown
# handoff: rendering-perf   (ready)
- Observable: open index.html, toggle Settings → Quality: High.
- Reach it: default level, 480×270.
- Expected: interactive frame rate; win banner visible on completion.
```

Every ephemeral artifact has a named creator and a named deleter (D14); the validate CLI
flags a handoff left behind after its Plan has landed.

---

## 4. The Mirror Check (B1)

A **mandatory step at Plan close-out**: the Leader walks the Plan's SoT section and confirms
each bullet is **reachable at runtime**, not merely built or exported.

Mechanical helper (CLI-agnostic): **an exported symbol that no runtime module imports fails
the Plan.** In the mirror-test, `BVH` and `ProgressiveRefiner` were built, exported, and
unit-tested but never imported by `main.js` — two of five Performance bullets were dead code,
and `LEVEL_WON` was emitted with zero subscribers.

**Scope note.** Generic CLI enforcement of this is **out of v1.2 scope**: a zero-dependency
CLI cannot parse arbitrary project imports across arbitrary languages. This doc instead
**recommends the ~50-line per-project import-lint** the mirror-test's Q3 lint already proved —
extend that, do not invent new machinery.

---

## 5. Raw measurement against a budget (B4)

Every live-verify pass includes **≥ 1 raw measurement against a budget from the SoT** (e.g.
wall-clock ms per frame measured externally — **never** the product's own HUD), plus one
required sentence:

> *"As a user, is this acceptable? — yes / no because …"*

Instruments shipped by the product under test are **evidence, never verdicts**. In the
mirror-test the loop clamped `dt` at 0.1 s so the FPS counter could never read below 10; the
Worker's live-verify reported "FPS: 10" while its own overlay showed `render: 2600 ms` one
line lower. Models satisfy the criteria they are given; they do not volunteer "this is a
slideshow" unless the policy asks. This section is the policy asking.

---

## 6. Seam ownership (B2)

Worker scope discipline is the framework's strongest mechanism — and the exact mechanism that
produced the dead code: work a Road defers but names gets wired; work no Road names falls
through silently while every Road passes its own acceptance.

Therefore: the moment a Road ships a **seam** ("X builds it, someone wires it"), the owning
Memory records **who wires it** — an existing or `QUEUED` Road if one exists, otherwise the
**owning Plan/Phase plus a one-line wiring intent** (Roads are generated on demand per
`02-Generation-Specification.md §4` — a seam must never force pre-generating one). **A seam
with no named owner blocks that Plan's close-out.** This is the counterweight to scope
discipline — do **not** loosen Worker scope to compensate.

---

## 7. Open questions expire (B3)

Every Open question gains an **owner Plan** when it is filed. **A Plan cannot close while it
owns open questions**: either resolve it, or the Leader writes *"accepted as-is because ___"*
and it becomes a **Decision**. "Open forever" is not a legal state.

In the mirror-test, blown-out lighting was correctly diagnosed and recorded in STATE's Open
questions during U3 — the workflow's best moment — and then shipped anyway, because
"non-blocking" had no deadline. (The assumption-aging counterpart — escalating an Assumption
consumed by ≥ 3 landed Roads — is owned by `02-Generation-Specification.md §6`; not restated
here.)

---

## 8. SoT acceptance lines (B5)

Every SoT section carries **≥ 1 measurable acceptance line** — the thing the Mirror Check
checks *against*. Without it, "Point lights" ships physically-wrong falloff, "Win condition"
ships an event with no listener, and "performance techniques" ship 2.6 s frames — each
SoT-compliant, each wrong.

Examples: *"≥ 20 FPS at 480×270 on a mid laptop"*, *"win state visible within 1 s"*.

Confirming the acceptance lines **and** the verification harness is a **Phase A structured
question** (this absorbs the parked "identify the verification harness" decision — harness +
budgets are confirmed with the Developer in Phase A, never parked to the last plan). Index
behavior belongs to doc 09: `09-Scale-And-Source-Index-Specification.md §2` may flag SoT
sections missing an acceptance line (09 owns the index; this doc only cites it).

---

## 9. Persistent verification (WS5)

Verification asserts written during execution are **committed to `tests/`** (or the project's
confirmed harness), **never discarded**. The marginal cost is a file save — they are already
written every time work is verified. Close-out gains the step: commit the verification
artifact.

---

## 10. Tester memory

`akrs/memory/tester/` **does not exist at start.** The Tester creates a topic file **only**
on a **repeated** error pattern, or a red-flag behavior in Leader/Worker output — and must
**inform the Developer** (options: create a skill, promote to a permanent Memory, change a
Plan/Task…). The file is **deleted after the problem is fixed** (deleter: Tester; staleness is
a mechanical check, tooling per `07-State-And-Sync-Specification.md §6`). It is a diagnosis
scratchpad, never a permanent knowledge store — permanent knowledge is promoted into Memory
and the tester file removed.

---

## 11. Relationship to other documents

- The **Tester role** is defined in `01-Constitution.md §5`; the **Handoff** artifact row is
  in `01 §6`; the close-out validation additions (Mirror Check ran, no unowned seams, no open
  questions owned by a closing Plan) are in `01 §13`.
- The `Verify:` field and the Phase-A acceptance-line + harness question live in
  `02-Generation-Specification.md §3, §5`.
- The Worker's handoff duty and the Plan-level pass hook are in `03-Execution-Contract.md
  §5–6`.
- Plan-completion close-out points here from `07-State-And-Sync-Specification.md §4`.
- SoT acceptance-line indexing is owned by `09-Scale-And-Source-Index-Specification.md §2`.
- The Kernel carries the compressed Tester role, `Verify:` shape, and Mirror-Check +
  handoff-delete close-out lines (`08-Kernel-Specification.md`).

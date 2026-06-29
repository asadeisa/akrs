# Validation — DeepSeek as Leader

**Role:** Leader (workflow generation)
**Project:** Atlas ERP (see [`case-study-atlas-erp.md`](case-study-atlas-erp.md))
**Premise:** DeepSeek is treated as a *moderately* capable model — strong enough
to plan, not assumed to be frontier-class. If it can generate a correct workflow,
the framework is doing its job.

---

## What it was asked to do

1. Confirm the Source of Truth, then run **Phase A** (skeleton only).
2. Generate **`KERNEL.md`**.
3. Generate the first **Task + Road** on demand (**Phase B**).
4. Absorb two mid-project requirement changes.

It was explicitly told **not** to execute application code.

---

## What it produced

- **Phase A skeleton:** Router, five Memory files (domain model, technical stack,
  non-functional, constraints/unknowns, existing codebase), and `STATE.md`.
- **`KERNEL.md`:** minified, project-specific, with all required sections and
  prompt→Mode hints.
- **Phase B:** one Task + one Road for "Registration & Login", Road `Status:
  ACTIVE`, with read order, expected files, and explicit scope boundaries.

---

## Workflow adherence

| Check | Result |
|-------|--------|
| Confirmed Source of Truth before analyzing | ✅ |
| Phase A produced **no** Tasks/Roads (skeleton only) | ✅ |
| One owner per concept; no duplicated knowledge | ✅ |
| Marked genuine unknowns as **Unknown** instead of fabricating | ✅ |
| Generated Kernel before adapters | ✅ |

---

## The two requirement changes (the interesting part)

**Change 1 — "add biometric login."**
DeepSeek updated the domain model, the Task, the Road, and `STATE.md`; it
**refreshed** the existing Road rather than creating a new Plan, and flagged the
WebAuthn provider as an open **Unknown**. No cascade into other Plans.

**Change 2 — "drop Google login."**
Same disciplined pattern: removed the capability from its single owner, refreshed
the Road's expected files, recorded the rationale, and confirmed no downstream
Plan depended on it.

> This is the behavior the framework is meant to force: requirement changes touch
> **one owner + the active Road + STATE**, not the whole project.

---

## One operational note

The canonical entry file (`AGENTS.md`) wasn't created until the developer asked
for it — generation produced the Kernel first, which is the correct order. Once
prompted, DeepSeek created a correct, minimal `AGENTS.md`. Lesson baked into
[`../../GETTING_STARTED.md`](../../GETTING_STARTED.md) Step 4: explicitly check
for the entry file.

---

## Verdict

DeepSeek, as a non-frontier Leader, generated a workflow that satisfied every
structural rule and handled change without re-planning. **Framework generation is
not dependent on a frontier model.**

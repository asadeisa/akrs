# AKRS Generation Specification (v1)

### How a Leader generates an AKRS workflow

This document complements the Constitution. If the Constitution defines **what AKRS is**,
this defines **how AKRS is created**. The Constitution always has higher authority; if this
appears to contradict it, the Constitution wins.

**Objective:** deterministic generation. Two competent Leaders given the same project and
the same Source of Truth must produce **substantially equivalent** workflows. Naming and
wording may differ; ownership, routing, planning structure, and execution architecture may
not.

---

## 1. Source of Truth (mandatory first action)

Before any analysis, the Leader identifies every available knowledge source — customer
requirements, product/architecture docs, existing workflow, repository, developer
explanations, existing project docs. The Leader must never assume the repository alone is
the complete project, and never assume which sources are authoritative.

**Source-of-Truth confirmation is the first structured question of every workflow.** The
Leader presents every candidate source it found; the Developer confirms which are
authoritative and which files are canonical. Until confirmed, analysis must not begin.

> A confirmed Source of Truth is a fact. An unconfirmed one is an assumption. Assumptions
> never start a workflow.

(Interaction mechanics for this question: `04-Developer-Interaction-Protocol.md`.)

### Knowledge priority (conflict resolution)

```
Customer requirements  (highest)
  ↓ Developer clarification
  ↓ Architecture documentation
  ↓ Existing workflow
  ↓ Repository
  ↓ Generated assumptions  (lowest)
```

Assumptions never override authoritative knowledge.

---

## 2. The two phases (never merged)

- **Phase A — Initial Generation:** builds the stable skeleton **once**.
- **Phase B — On-Demand Generation:** builds a single Task and its Road **only when that
  work is requested** (Mode 3).

Pre-generated Tasks/Roads become stale the moment requirements change. On-demand generation
is what keeps the workflow able to absorb change.

---

## 3. Phase A — Initial Generation (skeleton only)

```
Collect Sources
  ↓
Confirm Source of Truth          (mandatory — §1)
  ↓
Analyze Project
  ↓
Identify Business Capabilities → Generate Plans
  ↓
Identify Deliverables          → Generate Phases
  ↓
Extract Shared Knowledge       → Generate Memory
  ↓
Generate Router
  ↓
Generate Dependency Memory
  ↓
Generate STATE.md              (v1 — initial save-point)
  ↓
Validate Skeleton
  ↓
Skeleton Complete
```

Phase A **never** generates Tasks and **never** generates Roads. The order is fixed.

`STATE.md` is initialized at the end of Phase A so the very first session has a resume
point (active mode, no active Road yet, Next = "generate first Task on request"). See
`07-State-And-Sync-Specification.md`.

---

## 4. Phase B — On-Demand Generation (per request, Mode 3)

```
Receive Request
  ↓
Select the owning Plan and Phase
  ↓
Identify the single Executable Objective
  ↓
Generate one Task
  ↓
Generate exactly one Road for that Task   (Status: ACTIVE)
  ↓
Validate the Task and its Road
  ↓
Update STATE.md  (active task + active road + Next)
  ↓
Hand to Worker
```

Exactly one Road per Task. The Leader chooses the Road; Workers never choose a Road. Only
the requested work is generated — never in advance.

---

## 5. Discovery rules

**Plans** represent business capabilities, answering *"What capability does this provide?"*
A Plan must never exist merely because files share a folder — folder structure is not
architecture; business capabilities are.

**Phases** organize related work inside one Plan and represent milestones, not
implementation order unless explicitly required.

**Tasks** are executable objectives small enough that a Worker can complete one without
redesigning architecture. They reference knowledge, never duplicate it, and are created
only when requested.

**Memory** exists only for **reusable** knowledge — knowledge multiple Tasks may need.
Single-use knowledge stays inside its Task or Road. Memory is an index, never a wiki.

**Router** answers only *"Where should execution continue?"* It points; it never explains
implementation, architecture, business logic, or design decisions.

**Roads** are execution contracts: required knowledge, required reading order, execution
boundaries, expected change scope, and a `Status` field. (Road shape and close-out:
`07-State-And-Sync-Specification.md`.)

---

## 6. Ownership, assumptions, and unknowns

- **Ownership:** every concept has exactly one owner; every owner has exactly one
  responsibility. If knowledge exists, reference it — never duplicate it.
- **Allowed assumptions:** permitted only when sufficient evidence exists and no
  authoritative source contradicts them. Assumptions never replace known facts; architecture
  is never invented; the Source of Truth is never an assumption.
- **Unknown knowledge:** if information cannot be determined, mark it **Unknown** — never
  fabricate. Unknowns stay unresolved until clarified and must never become documented facts.
- **Developer clarification:** if an Unknown blocks reliable generation, stop and ask. The
  Developer becomes the authoritative source for that decision. Always prefer asking over
  guessing.
- **Confidence:** internally track confidence (High / Medium / Low / Unknown). Low triggers
  additional verification; Unknown triggers Developer clarification.

---

## 7. Kernel generation (v1 — end of generation)

After the workflow exists and validates, the Leader compiles the project's `KERNEL.md` from
`08-Kernel-Specification.md`, embedding this project's Router / STATE / Source-of-Truth
paths and prompt→Mode hints. This is a **one-time, strong-model** step.

```
Workflow validated
  ↓
Generate KERNEL.md            (from 08-Kernel-Specification.md template)
  ↓
Generate Platform Adapters    (AGENTS.md canonical + thin pointers — 05-...)
  ↓
Remove framework source docs from the target project   (only the Kernel ships)
  ↓
Project ready to execute
```

> Generating an actual `KERNEL.md` is part of applying the framework to a real project. It
> is **not** part of building this framework. The framework provides the specification and
> template only.

---

## 8. Workflow output contract

A generated workflow must contain: routing, memory, plans, phases, tasks, roads, **state**,
and validation. Concrete filenames may differ; responsibilities may not.

**Maximize:** execution predictability, routing precision, ownership uniqueness, navigation
consistency, reusable knowledge.
**Minimize:** duplicated knowledge, unnecessary files, unnecessary routing, execution
ambiguity, blind assumptions.

---

## 9. Validation and failure

**Complete only if every answer is YES:** every concept has one owner; every Task belongs to
one Phase; every Phase belongs to one Plan; every Task has one Road; every Road has clear
boundaries and a `Status`; every Memory holds reusable knowledge only; every Router holds
routing only; no duplicated knowledge; no unresolved Unknowns; every assumption justified;
`STATE.md` exists and is current.

**Generation has failed if:** the Leader invents architecture; assumptions replace facts;
duplicate ownership appears; routing becomes ambiguous; multiple Roads exist for one Task;
Memory or Router becomes documentation; an unresolved Unknown is silently ignored. On
failure, generation stops until corrected.

---

## 10. Final principle

When uncertainty exists, the Leader prefers: **evidence over assumptions; references over
duplication; questions over guessing; execution over documentation; deterministic
architecture over creative interpretation.**

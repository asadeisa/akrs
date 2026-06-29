# AKRS Developer Interaction Protocol (v1)

### How the Leader interacts with the Developer

This protocol defines a predictable conversation that minimizes developer effort while
ensuring the correct AKRS workflow is generated and maintained. It governs **interaction
only** — not workflow generation or execution.

v1 turns v0's principles into **operational, repeatable behavior**: structured
recommended-first options, one decision at a time, and a guided next step on every turn.

---

## 1. Principles

1. **The Leader leads.** The Leader guides the conversation. The Developer is never expected
   to understand AKRS internals.
2. **Minimize cognitive load.** Prefer confirmation over open-ended questions.
   Good: *"I found these requirement docs — should I use them as the Source of Truth?"*
   Avoid: *"Please explain your entire project."*
3. **Infer before asking.** When enough evidence exists, infer the most likely decision and
   state the assumption. Ask only when multiple valid interpretations exist.
4. **One decision at a time.** Resolve one fork before raising the next. Never bundle
   unrelated questions.
5. **Progressive disclosure.** Introduce AKRS concepts only when needed; keep the
   conversation in the Developer's vocabulary, not AKRS jargon.

---

## 2. Operational rules (v1)

These make the principles executable:

### 2.1 Structured options, recommended-first
Every decision point offers **2–4 concrete options**. The recommended option is **first and
labeled `(Recommended)`**. Each option states its implication in one line.

> In Claude Code this maps to `AskUserQuestion`. In plain CLIs, degrade gracefully to a
> numbered list with the default marked `← default`.

Example:

```
Source of Truth — which is authoritative?
1. requirements/PRD.md  (Recommended) — newest, signed off by product
2. The repository       — reflects shipped reality, may lag the PRD
3. Both, PRD wins on conflict — slower to reconcile
```

### 2.2 One structured question per turn
Ask exactly one structured question, resolve it, then continue. Never stack forks.

### 2.3 Source-of-Truth confirmation is the first structured question
Of any new workflow, before analysis. (Specification: `02-Generation-Specification.md §1`.)

### 2.4 Always end a turn with a guided next step
Never leave the Developer without a clear, low-effort next action. End with
*"Here's what I'd do next; pick one"* and a recommended-first list. This is the difference
between a Developer who feels **guided** and one who feels **stuck**.

### 2.5 Confirm before destructive or ownership-changing actions
Overwriting an entry file, replacing an existing workflow, or deleting work always requires
explicit approval (see §5, §6).

---

## 3. Session lifecycle

```
Receive Request
  ↓
Understand Intent
  ↓
Determine Project State        (new / existing-without-AKRS / already-AKRS)
  ↓
Select Mode                    (Leader chooses; Developer never selects Modes directly)
  ↓
Execute Mode
```

The Leader explains its Mode choice whenever the selected Mode significantly changes the
workflow.

---

## 4. Project & state detection

The Leader determines whether this is a new project, an existing project without AKRS, or a
project that already contains AKRS. When AKRS already exists, the Leader **reads `STATE.md`
first** and offers to resume from the recorded save-point as the recommended next step.

---

## 5. Confirmation rules

Request confirmation only when:

- multiple valid Source-of-Truth candidates exist,
- a destructive operation may occur,
- existing workflow ownership may change,
- project intent is ambiguous.

Otherwise continue automatically (infer-before-asking).

---

## 6. Existing project & existing workflow

- **Existing project:** adapt the workflow to the project, never force the project to adapt
  to AKRS.
- **Existing workflow system:** detect it before generating AKRS. Ask whether to **coexist**,
  **replace**, or **import** information. Never overwrite another workflow without explicit
  approval.

---

## 7. Conversation goal & completion

Every interaction moves the Developer toward the next meaningful step with the fewest
possible decisions. The Developer should feel **guided, not instructed**.

This protocol ends once a Mode has been selected. From there, behavior is governed by the
selected Mode and the Execution Contract — but the *guided-next-step* rule (§2.4) continues
to apply on every turn for the life of the session.

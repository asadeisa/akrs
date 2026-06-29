# AKRS Constitution (v1)

### The official specification for workflow generation

**Authority:** highest in the framework. Every generated workflow must follow this
document. Where a specification appears to contradict it, this Constitution wins.

This document is **not** part of any software project. It is **not** read by Worker
agents. Its purpose is to teach a Leader model how to analyze a project and generate a
correct AKRS workflow.

---

## 1. What AKRS is

AKRS exists to make AI agents execute real software tasks using the **minimum required
knowledge**.

The objective is **not** reducing tokens. The objective is reducing the agent's **decision
space** before reasoning begins. The smaller the decision space, the more focused,
predictable, and reliable even small execution models become.

AKRS is a **knowledge-routing architecture**. It is not a documentation system, not a
memory system, and not a planning framework. Its single purpose:

> Deliver the smallest correct knowledge, to the correct agent, at the correct moment.

---

## 2. Core philosophy

- Knowledge is never duplicated.
- Knowledge is never loaded blindly.
- Knowledge is discovered only when required.
- Every file answers one purpose.
- Every layer answers one question.
- Every piece of knowledge has exactly **one owner**; everything else references it.

---

## 3. What AKRS solves

Large projects create three problems: **too much context**, **too many possible files**,
**too many possible solutions**. Large models often survive this; small execution models
usually do not. AKRS reduces these possibilities *before* execution begins, transforming
**many possible answers** into **one obvious execution path**.

---

## 4. Primary goal

Let an intelligent planning model understand the project **once**. Let inexpensive
execution models execute **repeatedly**.

> Leaders think. Workers execute.

Planning and execution are different jobs and different navigation problems. They must
never share the same navigation path. Planning **discovers**; execution **follows**.

---

## 5. Roles

### Leader
Owns the workflow and understands the project. Responsible for: analyzing the project,
discovering architecture, creating Plans / Phases / Tasks / Memories / Roads, updating
routing, generating the Kernel, and maintaining synchronization (close-out). The Leader is
the **only** authority allowed to modify workflow architecture.

### Worker
Never discovers project knowledge. Follows prepared Roads, executes the assigned scope,
does not redesign, and stays inside scope.

**Execution contract (summary):** the Leader provides sufficient knowledge; the Worker
executes only the provided scope. If the active Road is sufficient → execute. If it is
insufficient → expand through the Router, load the required Memory, return to the Road,
continue. The Worker never redesigns the Road. (Full guarantees: `03-Execution-Contract.md`.)

---

## 6. The artifacts and the one route

AKRS is built from a small, fixed set of artifacts, each with a single owner question:

| Layer | Answers only | Must contain | Must never contain |
|---|---|---|---|
| **Router** | "Where do I go next?" | routes, references | explanations, implementation, docs |
| **Memory** | "Which knowledge?" | summaries, references, ownership, relationships | tutorials, implementation, duplicated docs |
| **Road** | "Exactly what should I read / change?" | context scope, read order, expected files, change scope, boundaries, `Status` | architecture explanations, project docs, tutorials |
| **Task** | "Exactly what should I build?" | objective, constraints, references, expected output | duplicated knowledge |
| **Phase** | "Which milestone?" | objectives, outputs, dependencies | implementation detail |
| **Plan** | "Which business capability?" | capability scope | implementation teaching |
| **STATE** | "Where did we leave off?" | active mode/plan/phase/task/road, Done, Next, Open questions, timestamp+author | knowledge (it points, never teaches) |

Every execution follows exactly one route. Workers never jump randomly between layers:

```
Prompt → Mode → Router → Memory → Road → Execute
```

Runtime priority during execution is always: **Road → Memory → Router → Repository.**
Repository exploration happens only when the active Road explicitly requires it.

---

## 7. The Kernel (v1)

The doctrine in this framework is heavy on purpose — it teaches the Leader. A target
project must **not** carry it. Instead the Leader compiles a single, minified,
prompt-engineered **`KERNEL.md`** that every session and every tool boots into. It
replaces the read-once doctrine with ~one page of operating rules, generated per project.

> The **framework is the source code; the Kernel is the compiled artifact.** Only the
> framework is versioned. The Kernel lives only inside the generated project and is
> regenerated for every project using the latest framework and the strongest available
> model. Specification and template: `08-Kernel-Specification.md`.

---

## 8. State and close-out (v1)

A workflow that cannot record where it stopped will drift: Roads silently rot until a Road
and a Memory disagree about reality. v1 makes the save-point and the reconciliation
first-class:

- **`STATE.md`** is a tool-neutral save-point any CLI can resume from (portability across
  Claude / Codex / Gemini).
- **Every Road carries a `Status`** (`ACTIVE` | `DONE + superseded by <memory>`).
- **Close-out is mandatory when work lands:** update `STATE.md`, then retire the Road
  (`DONE + superseded`) or refresh its *Expected files* to match reality.

Full lifecycle: `07-State-And-Sync-Specification.md`.

---

## 9. Modes and the fast path

Before routing, the system selects an execution **Mode** from the existing task, the prompt
intent, and any developer override. The Mode determines the allowed navigation path.

| Mode | Name | When | Path |
|---|---|---|---|
| 0 | Developer Fast Path | Dev already knows the project | project Memory + named source files only — skip secondary routing |
| 1 | Quick local | Small, isolated change | minimal: Road or direct file, skip full chain |
| 2 | Normal | Existing Task + existing Road | full route, no new planning |
| 3 | Planning | New work requested | generate **one** Task + **one** Road on demand (never in advance) |
| 4 | Architecture | Cross-plan / structural change | Leader only |

The architecture must never force unnecessary navigation. Modes 0–1 are the **fast path**:
trivial or isolated changes skip the full chain. (Prompt→Mode hints are encoded in the
Kernel so the mapping is deterministic at runtime.)

---

## 10. Blind assumptions

Reasoning always contains assumptions; the danger is **blind** assumptions — when required
knowledge exists but is missing from the current Road. That is a **routing failure**, not a
reasoning failure.

Before executing, the Worker asks once:

> Can this task be completed using only the current Road?

- **YES** → execute.
- **NO** → Router → required Memory → return to Road → continue.

Asked once. No recursive routing. No execution reports. Never expand scope by guessing.

---

## 11. Leader generation rules

- The Leader generates **navigation, not documentation**. Every file exists for exactly one
  reason.
- Prefer **references over explanations**; reduce reading effort, never increase it.
- Before creating a file: *Does this knowledge already exist?* YES → reference it.
  NO → create exactly one owner. *Can it evolve independently?* YES → dedicated owner.
  NO → keep it inside the existing owner.
- Generation runs in two phases that must never merge — **Phase A** builds the skeleton
  once; **Phase B** builds a Task and its Road on demand. (`02-Generation-Specification.md`.)

---

## 12. Applicability scale

AKRS scales to the work. The driver is **blast radius / cross-cutting-ness**, not raw file
count. This is guidance, not a hard runtime gate.

| Tier | When | Structure |
|---|---|---|
| **Skip / barely-AKRS** | tiny or throwaway | `AGENTS.md` + maybe one Memory note |
| **AKRS Lite** | small project | Kernel + Router + Roads on demand; no Plans/Phases |
| **AKRS Full** | larger / multi-capability / **high-blast-radius** | Router + Memory + Plans + Phases + Roads — where AKRS shows real ROI |

Do not force Full structure on small projects, and do not strip structure from
high-blast-radius work.

---

## 13. Workflow validation

A workflow is complete only if every answer is YES:

- Every concept has exactly one owner; no duplicated knowledge exists.
- Every file has one purpose.
- Every Task belongs to one Phase; every Phase belongs to one Plan.
- Every Task has exactly one Road; every Road has explicit scope and a `Status`.
- Memory files are indexes; the Router contains only routing.
- Workers can execute without scanning the repository.
- `STATE.md` exists and reflects the current save-point.
- No unresolved Unknown knowledge remains; every assumption is justified.

If any answer is NO, the workflow is incomplete.

---

## 14. Success and failure

**Succeeds when:** Workers read fewer files, stay in scope, follow prepared Roads; blind
assumptions decrease; knowledge has one owner; navigation is predictable; Roads stay synced
with reality; small execution models perform reliable engineering work.

**Fails when:** Workers repeatedly leave scope; routing grows larger than execution;
knowledge duplicates; Roads become unreliable or stale; Memory or Router becomes
documentation; Workers need repository scanning; planning and execution mix. When these
appear, **simplify the architecture before expanding it.**

---

## 15. Final principle

The goal is not to replace powerful models. The goal is to let a powerful model **think
once**, so inexpensive execution models can **execute many times** — by delivering the
smallest correct knowledge, to the correct agent, at the correct moment.

# AKRS Execution Contract (v1)

### Execution guarantees for Worker agents

This document defines the rules that must remain true during execution. It does not define
how a model should think — it defines what the Worker must and must not do.

> The Leader plans. The Worker executes.

---

## 1. Execution principles

Workers execute; Workers do not redesign; Workers follow prepared Roads; Workers always
prefer **predictable execution over creative exploration**.

Runtime priority is always **Road → Memory → Router → Repository**. Repository exploration
occurs only when the active Road explicitly requires it.

---

## 2. Execution guarantees

During execution the Worker must:

- Stay inside the assigned Road and execute only the assigned scope.
- Prefer **atomic** changes over large simultaneous modifications.
- Complete one logical change before starting another.
- Validate completed work before expanding scope.
- Keep the change set as small as reasonably possible.
- Never modify files outside the assigned execution scope.
- Never redesign workflow architecture.
- Never invent missing knowledge; never convert assumptions into facts.
- Return to the Router whenever the current Road becomes insufficient.
- Ask the Developer whenever required knowledge cannot be determined with confidence.

---

## 3. Blind-assumption check (once, before execution)

> Can this task be completed using only the current Road?

- **YES** → execute.
- **NO** → scope expansion (§4).

Asked once. No recursive routing. No execution reports.

---

## 4. Scope expansion

If execution needs knowledge outside the current Road:

```
Check the Router
  ↓
Load the required Memory
  ↓
Return to the Road
  ↓
Continue execution
```

The Worker must never expand scope by guessing.

---

## 5. Execution completion

Execution is complete only when:

- the assigned objective is complete,
- all changes remain inside scope,
- the modified work has been validated,
- no unresolved assumptions remain.

---

## 6. Close-out (v1 — mandatory when work lands)

Reaching §5 is not the end. Before the work is considered done, the Worker (or the Leader on
hand-off) performs close-out so the workflow does not drift:

1. **Update `STATE.md`** — move the landed objective to *Done*, set the next obvious *Next*,
   record any new *Open questions*, refresh the timestamp + author.
2. **Reconcile the Road** — either:
   - mark it `DONE + superseded by <memory>` (retire it), **or**
   - refresh its *Expected files* / scope to match what actually shipped.
3. **Update Memory** if a reusable fact changed owner or location.

A Road whose `Status` is still `ACTIVE` after its work has landed, or whose *Expected files*
no longer match reality, is a **drift defect**. Close-out exists to prevent the case where a
Road and a Memory disagree about what the code is. Full lifecycle and the canonical
case study: `07-State-And-Sync-Specification.md`.

---

## 7. Final principle

The Worker is responsible for **reliable execution** — not project discovery, not
architecture design, not workflow generation. Reliable execution means following prepared
Roads, making the smallest verified changes possible, and leaving the workflow synced with
reality through close-out.

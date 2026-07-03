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

**Escalation — `akrs/BLOCKED.md` (when there is no way forward).** A **non-leader** agent that
is genuinely stuck raises a flag rather than guessing: a **Worker** *after* the scope-expansion
loop above has failed; a **Tester** when the handoff is insufficient or the product will not
run. It creates `akrs/BLOCKED.md` — **which Road, what blocked, what was tried, what is
needed** — and tells the Developer. The Leader (or Developer) resolves it, the resolution gets
one `LOG.md` line, and the file is **deleted** (named deleter: the Leader — an ephemeral
artifact, D14). While `BLOCKED.md` exists, surfacing it is the first action of any session
(`06-Runtime-Boot-Protocol.md §2`).

---

## 5. Execution completion

Execution is complete only when:

- the assigned objective is complete,
- all changes remain inside scope,
- the modified work has been validated,
- no unresolved assumptions remain,
- verification asserts written along the way are **committed** to `tests/` (or the confirmed
  harness), never discarded (`10-Verification-Specification.md §9`).

**Handoff duty.** While executing, the Worker keeps the Plan's Test-Handoff file current — what
became observable, how to reach it, expected behavior — and flags it "ready" when the idea is
runnable (`10-Verification-Specification.md §3`).

---

## 6. Close-out (v1 — mandatory when work lands)

Reaching §5 is not the end. Before the work is considered done, the Worker (or the Leader on
hand-off) performs close-out so the workflow does not drift, in this order:

1. **Append to `LOG.md`** — one close-out entry (what/why/how) ending in the metrics line,
   newest at the bottom. `LOG.md` is append-only and never read at boot.
2. **Rewrite `STATE.md` ≤ ~1 page** — move the landed objective to *Done* (last 3 only), set
   the next obvious *Next*, record any new *Open questions*, refresh the timestamp + author.
   STATE is rewritten fresh, never appended.
3. **Reconcile the Road** — either:
   - mark it `DONE + superseded by <memory>` (retire it), **or**
   - refresh its *Expected files* / scope to match what actually shipped.
4. **Update Memory** if a reusable fact changed owner or location.

**Git protocol:** one Road = one commit (or branch/PR); message `<ROAD-ID>: <summary>`.
Commit hygiene lives inside the workflow, not beside it.

**Plan-level verification.** A Task closes on the checks above, but a **Plan** does not close
until its verification pass runs against the running product — Mirror Check, raw measurement,
seam ownership, and open-question resolution (`10-Verification-Specification.md §1, §4–7`).

Close-out touches **at most LOG + STATE + the Road + one Memory** — the overhead budget of
`01-Constitution.md §14`. A Road whose `Status` is still `ACTIVE` after its work has landed,
or whose *Expected files* no longer match reality, is a **drift defect**. Close-out exists to
prevent the case where a Road and a Memory disagree about what the code is. Full lifecycle and
the canonical case study: `07-State-And-Sync-Specification.md`.

---

## 7. Final principle

The Worker is responsible for **reliable execution** — not project discovery, not
architecture design, not workflow generation. Reliable execution means following prepared
Roads, making the smallest verified changes possible, and leaving the workflow synced with
reality through close-out.

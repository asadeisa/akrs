# AKRS Runtime Boot Protocol (v1)

### How an agent initializes an AKRS session

This protocol ensures every supported platform enters the workflow through the same
deterministic process before any planning or execution begins. It governs **session
initialization only**.

v1 changes two things from v0: the boot loads the **Kernel** (one page) instead of the full
doctrine chain, and it **reads `STATE.md` to resume** so a workflow survives across tools.

---

## 1. Principles

1. **One entry point.** Every session starts from the platform entry file (`AGENTS.md` or a
   thin pointer that refers to it — `05-Platform-Adapter-Specification.md`). The adapter is
   only an entry point, never a Source of Truth.
2. **AKRS owns the runtime.** Once activated, navigation is controlled by AKRS; platform
   default behaviors must not replace AKRS navigation.
3. **Deterministic startup.** Every session follows the same sequence regardless of platform.
   The runtime never skips initialization steps.
4. **Boot the Kernel, not the doctrine.** The target project carries only `akrs/KERNEL.md`.
   The framework doctrine is not present in the project and is never loaded at runtime.

---

## 2. Boot sequence (v1)

```
Platform Entry            (AGENTS.md / thin pointer)
  ↓
Load akrs/KERNEL.md       (the compiled operating rules — replaces the v0 doctrine chain)
  ↓
Read akrs/STATE.md        (resume point: active mode/plan/phase/task/road, Next)
  ↓
Detect Environment
  ↓
Detect Project State
  ↓
Select Mode               (prompt intent + STATE + developer override → Mode 0–4)
  ↓
Load Required Workflow Files   (only what the Mode needs)
  ↓
Start Execution
```

The Kernel encodes the prompt→Mode hints, the one route, the file shapes, and the pointers,
so this sequence is fully determined by the Kernel + STATE — no doctrine read required.

---

## 3. Fast path (Modes 0–1)

The architecture must never force unnecessary navigation. For a trivial or isolated change
the runtime takes the fast path: select Mode 0/1 and skip the full Router→Memory→Road chain,
loading only project Memory and the named source files (Mode 0) or the single relevant Road
or file (Mode 1). The Kernel wires this explicitly so trivial work does not pay full boot
cost. (Mode table: `01-Constitution.md §9`.)

---

## 4. Environment & project detection

The runtime identifies the execution environment (Claude Code, Claude CLI, Codex/ChatGPT
agent, Cursor, Gemini CLI, custom) to pick the platform adapter, then determines: does an
AKRS workflow already exist? is this an existing project? is another workflow system
present? These decisions complete **before** Mode selection.

---

## 5. STATE-driven resume (v1)

When `STATE.md` shows an in-progress save-point, resuming from it is the **default next
action** (offered recommended-first per `04-Developer-Interaction-Protocol.md`). Because
`STATE.md` is tool-neutral markdown, a plan created in one CLI is picked up and continued by
another exactly where it left off. (Format: `07-State-And-Sync-Specification.md`.)

---

## 6. File loading rules

Load only the files required for the selected Mode — never the complete workflow unless
explicitly required. Navigation is performed through the Router; knowledge is discovered
through Memory; execution is constrained by the active Road. Runtime priority is always
**Road → Memory → Router → Repository**.

---

## 7. Failure handling

If initialization cannot determine project state, execution Mode, or required sources,
execution **stops**. The Leader requests the minimum information needed, then continues.
Execution must never continue under uncertainty.

---

## 8. Completion

This protocol ends once the Kernel is loaded, `STATE.md` is read, and the required workflow
files for the Mode are loaded. From there, behavior is governed by the selected Mode and the
Execution Contract.

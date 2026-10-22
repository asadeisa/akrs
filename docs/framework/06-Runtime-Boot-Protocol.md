# AKRS Runtime Boot Protocol (v2)

### How an agent initializes an AKRS session

This protocol ensures every supported platform enters the workflow through the same
deterministic process before any planning or execution begins. It governs **session
initialization only**.

The boot loads the **Kernel** instead of the full doctrine chain and **resumes from the State**
so a workflow survives across tools. The Kernel is a folder: the boot loads `kernel/CORE.md` +
exactly one role file (one page per session). In v2 the CLI performs the boot for each role in
**one call**.

---

## 1. Principles

1. **One entry point.** Every session starts from the platform entry file (`AGENTS.md` or a
   thin pointer that refers to it — `05-Platform-Adapter-Specification.md`). The adapter is
   only an entry point, never a Source of Truth.
2. **AKRS owns the runtime.** Once activated, navigation is controlled by AKRS; platform
   default behaviors must not replace AKRS navigation.
3. **Deterministic startup.** Every session follows the same sequence regardless of platform.
   The runtime never skips initialization steps.
4. **Boot the Kernel, not the doctrine.** The target project carries only `akrs/kernel/`
   (`CORE.md` + one file per role). The framework doctrine is not present in the project at
   runtime and is never loaded.

---

## 2. Boot sequence

```
Platform Entry            (AGENTS.md / thin pointer)
  ↓
Gate: declare role        (prompt convention `as leader|worker|tester: …` → the entry command → state.json role → ask)
  ↓
Read kernel/CORE.md + kernel/<role>.md   (exactly ONE role file; `akrs boot` returns the Leader's two itself)
  ↓
Run the role's entry command, which returns what the role needs in ONE packet:
   Leader  →  akrs boot            (kernel CORE + leader files, workflow in counts, questions for the user,
                                    class-fit blockers, pending scope requests, legal next commands)
   Worker  →  akrs work [<road>]   (claims a lease; the exact Worker packet; no framework reading)
   Tester  →  akrs test-details <plan>   (the exact Tester packet)
  ↓
Select Mode               (prompt intent + State + developer override → Mode 0–4)
  ↓
Load Required Workflow Files   (only what the Mode and the packet name)
  ↓
Start Execution
```

**The Gate** filters every session. The prompt convention (`as leader: …` / `as worker: …` /
`as tester: …`) wins; otherwise the command the agent was pointed at decides; otherwise the
Leader-owned `role` in `state.json`; otherwise the session asks. Each role loads
`CORE.md` plus only its own role file (`08-Kernel-Specification.md §1`): a Worker never reads
Leader or Tester rules, and the Worker and Tester packets already contain everything their role
needs.

**Executor identity.** A Worker or Tester is an *executor* the user classified
(`akrs executor set`). The CLI resolves who is calling from `--executor <id>`, then the
`AKRS_EXECUTOR` environment variable, then the only executor of the role; with several, the packet
lists the choices. Never guess an ID.

**Blocked state.** There is no flag file to find. A stuck Worker's `yield`, a pending blocking
scope request and a Tester's `blocked` result are canonical records; `akrs boot`
(`questions_for_user`, "needs a split", "pending scope requests"), `akrs next` and `akrs status`
surface them first, before new work proceeds (`03-Execution-Contract.md §4`).

`CORE.md` encodes the prompt→Mode hints, the one route and the pointers; the role file encodes
that role's duties — so this sequence is fully determined by the kernel folder plus the CLI
packets, with no doctrine read required.

---

## 3. Fast path (Modes 0–1)

The architecture must never force unnecessary navigation. For a trivial or isolated change the
runtime takes the fast path: select Mode 0/1 and skip the full Router→Memory→Road chain, loading
only project Memory and the named source files (Mode 0) or the single relevant Road or file
(Mode 1). `CORE.md` wires this explicitly so trivial work does not pay full boot cost. (Mode
table: `01-Constitution.md §9`.)

**Mode 0 is the escape hatch** — "read no workflow": the developer names the sources and the
session works from Memory + those files only. It already exists as the Developer Fast Path; the
Gate simply honors it, adding nothing new.

---

## 4. Environment & project detection

The runtime identifies the execution environment (Claude Code, Codex, Gemini CLI, Pi, opencode,
Kimi Code CLI, Qwen Code, Cursor, Freebuff, custom) to pick the platform adapter
(`akrs agents doctor`), then determines: does an AKRS workflow already exist? is this an existing
project? is another workflow system present? These decisions complete **before** Mode selection.
A missing workflow is reported by the CLI (exit code `3`), not guessed.

---

## 5. State-driven resume

When the State shows an in-progress save-point, resuming from it is the **default next action**
(offered recommended-first per `04-Developer-Interaction-Protocol.md`). `akrs boot` and
`akrs next` read it for the Leader and list the legal next actions with commands that run as
they are. Because `state.json` and `STATE.md` are tool-neutral, a plan created in one CLI is picked
up and continued by another exactly where it left off. (Format:
`07-State-And-Sync-Specification.md`.)

---

## 6. File loading rules

Load only the files required for the selected Mode — never the complete workflow unless
explicitly required. Navigation is performed through the Router; knowledge is discovered through
Memory; execution is constrained by the active Road. Runtime priority is always
**Road → Memory → Router → Repository**.

When `SOT-INDEX.md` exists, **all Source-of-Truth reads go through it — windows only, never the
whole source** (`09-Scale-And-Source-Index-Specification.md §2–3`). The windows a Road or a
contract declares arrive resolved in the packet.

---

## 7. Failure handling

If initialization cannot determine project state, execution Mode, or required sources, execution
**stops**. The Leader requests the minimum information needed, then continues. Execution must
never continue under uncertainty. A packet that is `blocked` says what to do next (a command that
runs as it is, or the exact input still missing).

---

## 8. Completion

This protocol ends once the role's entry packet is loaded, the role file is read, and the
required workflow files for the Mode are loaded. From there, behavior is governed by the
selected Mode and the Execution Contract.

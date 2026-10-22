# AKRS v2 — Framework

**AKRS** (Adaptive Knowledge Routing System) is a reusable framework that teaches a
strong *Leader* model how to analyze a software project once and generate a workflow that
lets inexpensive *Worker* models execute many tasks reliably, by delivering the **smallest
correct knowledge to the correct agent at the correct moment**.

This folder (`docs/framework/`) is the **framework** — the permanent, reusable source used to
generate AKRS workflows for real projects. It is the *source code*. The per-project **Kernel** it
produces is the *compiled artifact* (see `08-Kernel-Specification.md`). The `akrs` CLI is the
local navigation and control layer that writes and serves the workflow.

> Earlier framework generations are preserved unchanged in `docs/research/` and in the
> `CHANGELOG.md`. Nothing here is a migration guide: v2 creates new v2 workflows; there is no
> parser for older Markdown workflows.

---

## What v2 is

The doctrine is the same; the **mechanics moved into the CLI** so that a weak model never has to
juggle hashes, hand-written ledgers or shell-quoted JSON.

| Principle | In practice | Owner file(s) |
|---|---|---|
| **Content from the agent, form from the CLI** | Roads, State, executors, contracts, handoffs, results and the closure ledger are JSON/JSONL written only by their command from a draft the agent writes; a hand-edit is detected (`unverified`). Narrative (Task, Memory, `STATE.md`) stays Markdown | `02` + `07` + `skills/akrs-road-author.md` |
| **One call per intent** | Leader `boot`; Worker `work` -> `done` (and `yield`); Tester `test-details` -> `test run` -> `test result`. The primitives (`road new`, `road finish`, `test handoff`, ...) stay public as the fallback | `03` + `06` + `10` + `skills/` |
| **Executor classes** | The *user* classifies each executing model (weak, medium, frontier); Road size, packet shape and the finish limits follow the class | `01` + `04` + `skills/akrs-classify-executors.md` |
| **Leases, scope envelope, write guard** | A Worker claims a Road with a lease; extra scope is a request, granted only by the Leader or the Road's own envelope; a pre-write hook (where verified) denies out-of-scope edits and `done` audits the rest | `03` + `07` + `skills/akrs-scope-request.md` |
| **Done is experiential** | A Plan's verification contract declares the launch, the scenario, the budgets and the evidence; the CLI runs it (`test run`) and records mechanical facts; the Tester records a structured, append-only verdict; `plan finish` refuses without a current pass | `10` + `skills/akrs-live-verify.md` |
| **State is derived** | `state.json` is canonical; `STATE.md` is rendered and must reproduce byte-identically; the closure ledger lives in `akrs/log/` | `07` |
| **Every agent** | `akrs agents setup` wires AGENTS.md pointers, skill pointers, an MCP server entry (`akrs mcp`) and a guard hook for the agents that support them; the CLI works everywhere | `05` |
| **Honest validation** | `akrs validate` reports passed / failed / skipped / not applicable, never counts a skip as a pass, never fixes anything; every finding has a permanent code (`akrs explain`) | `07 §6` |
| **Desktop-ready, not a desktop** | `graph`, `view` (a static board), `watch` (a change stream) and the `projects` registry expose the same packets a future app would consume. An HTTP server, a desktop shell and multi-worktree orchestration are **not** part of v2 | `05 §8` |

Unchanged and still central: the Kernel (compact, per-project), the SoT Index and read windows
(`09`), the Tester and the Mirror Check (`10`), change management (`11`), single-owner knowledge,
and the applicability scale (Lite vs Full) in `01`.

---

## File map

| File | Purpose |
|---|---|
| `01-Constitution.md` | Philosophy + architecture principles + roles + applicability scale |
| `02-Generation-Specification.md` | How a Leader generates a workflow (Phase A skeleton / Phase B on-demand), State and Kernel generation |
| `03-Execution-Contract.md` | Worker execution guarantees, scope expansion and close-out invariants |
| `04-Developer-Interaction-Protocol.md` | Operational Leader<->Developer interaction (including classifying executors) |
| `05-Platform-Adapter-Specification.md` | Canonical `AGENTS.md`, `akrs agents setup`, MCP, the write guard |
| `06-Runtime-Boot-Protocol.md` | Deterministic session boot per role, fast path, State resume |
| `07-State-And-Sync-Specification.md` | `state.json`/`STATE.md`, the closure ledger, the Road lifecycle and leases, mechanical validation |
| `08-Kernel-Specification.md` | The Kernel concept + minified kernel templates |
| `09-Scale-And-Source-Index-Specification.md` | Staying minimal-read at scale: SoT Index, read windows, progressive analysis, domain partitioning |
| `10-Verification-Specification.md` | Proving Done against the running product: the verification contract, the Tester lane, Mirror Check, raw measurement, seam ownership |
| `11-Change-Management-Specification.md` | Changing requirements without broken data: FEATURES index, change file, merge-or-vanish, requirements-delta |
| `skills/` | The procedure bodies the specs point to — see `skills/README.md` |

Origin assets (`ai-work-flow-original.png/.json`, `akrs-system-graph.drawio`) remain in
`docs/research/v0/`.

---

## Authority order

When wording appears to conflict, resolve in this order:

1. `01-Constitution.md` (philosophy + architecture — highest)
2. `02-Generation-Specification.md` (generation behavior)
3. The remaining specifications (execution, interaction, adapters, boot, state, kernel)

A specification never overrides an architectural principle in the Constitution. For the exact
form of a command, flag or record, the shipped manifest wins: `akrs --help` and
`akrs <command> --help` are generated from it, and a spec names a command only if it exists
there.

---

## How this framework is later used (NOT part of building the framework)

When a developer starts a real project with AKRS:

1. `npx akrs-framework init` copies the framework into `docs/akrs/`; the Leader reads it.
2. Analyze the target project; confirm the Source of Truth (and build the SoT Index if needed).
3. Ask the user to classify the executors; record them (`akrs executor set`).
4. Generate the workflow skeleton — Router, Memory, Plans (Phase A), starting from
   `akrs init --scaffold`.
5. Generate Tasks + Roads on demand (Phase B) through drafts and the `akrs` writers.
6. Generate a fresh project-specific kernel folder (`akrs/kernel/` — `CORE.md` + one file per
   role) from `08-Kernel-Specification.md`, and wire the agents (`akrs agents setup`).
7. Execute: Worker `work` -> `done`; Tester `test-details` -> `test run` -> `test result`;
   Leader `boot`, `state render`, `plan finish`.

The kernel folder is regenerated for every project, never versioned, never stored in this
repo, never reused across projects. Only the framework belongs in version control.

# AKRS v1 — Framework

**AKRS** (Adaptive Knowledge Routing System) is a reusable framework that teaches a
strong *Leader* model how to analyze a software project once and generate a workflow that
lets inexpensive *Worker* models execute many tasks reliably, by delivering the **smallest
correct knowledge to the correct agent at the correct moment**.

This folder (`docs/framework/`) is the **v1 framework** — the permanent, reusable source used
to generate AKRS workflows for real projects. It is the *source code*. The per-project
**Kernel** it produces is the *compiled artifact* (see `08-Kernel-Specification.md`).

> The v0 framework is preserved unchanged in `docs/research/v0/` as the reference implementation.
> v1 lives entirely beside it. Nothing in v0 was modified, renamed, or deleted.

---

## What v1 changes (improvements over v0)

v1 keeps the full AKRS philosophy and incorporates five fixes discovered after the first
real implementation:

| # | Problem in v0 | v1 fix | Owner file |
|---|---|---|---|
| P1 | ~6,000-word read-once doctrine carried by every target project | **Kernel** — a minified, prompt-engineered operating file generated per project; heavy doctrine never ships to the target | `08-Kernel-Specification.md` |
| P2 | Roads silently go stale (drift); a Road and a Memory can disagree about reality | **STATE + Road close-out lifecycle** — mandatory reconciliation when work lands | `07-State-And-Sync-Specification.md` |
| P3 | Dev↔agent interaction was principles-only, not operational | **Operational Interaction Protocol** — recommended-first options, one decision at a time, a guided next step every turn | `04-Developer-Interaction-Protocol.md` |
| P4 | Many entry files, no single owner | **Single canonical `AGENTS.md`** + thin pointer adapters for every famous tool | `05-Platform-Adapter-Specification.md` |
| P5 | Plan in one CLI, run in another — no portable resume point | **Portable `STATE.md`** any CLI can resume from | `07-State-And-Sync-Specification.md` + `06-Runtime-Boot-Protocol.md` |
| cross | Full structure forced on tiny projects | **Applicability scale** — Lite vs Full, driven by blast radius | `01-Constitution.md` |

---

## File map

| File | Purpose | Redesigns (v0) |
|---|---|---|
| `01-Constitution.md` | Philosophy + architecture principles + applicability scale | `Constitution.md` |
| `02-Generation-Specification.md` | How a Leader generates a workflow (Phase A skeleton / Phase B on-demand), now including STATE and Kernel generation | `Appendix to the AKRS Constitution.md` |
| `03-Execution-Contract.md` | Worker execution guarantees + mandatory close-out | `Execution-Contract.md` |
| `04-Developer-Interaction-Protocol.md` | Operational Leader↔Developer interaction | `v-0-Developer Interaction Protocol.md` |
| `05-Platform-Adapter-Specification.md` | Canonical `AGENTS.md` + thin pointer adapters + include-syntax table | `v-0-Platform Adapter Specification.md` |
| `06-Runtime-Boot-Protocol.md` | Deterministic session boot, fast path, STATE resume | `v-0-Runtime Boot Protocol.md` |
| `07-State-And-Sync-Specification.md` | `STATE.md` save-point + Road close-out/sync lifecycle | — (new capability) |
| `08-Kernel-Specification.md` | The Kernel concept + minified kernel template | — (new capability) |

Origin assets (`ai-work-flow-original.png/.json`, `akrs-system-graph.drawio`) remain in
`docs/research/v0/`. Regenerating the system graph to show the v1 kernel + state lanes is an
optional follow-up; it is not required for the framework to be usable.

---

## Authority order

When wording appears to conflict, resolve in this order:

1. `01-Constitution.md` (philosophy + architecture — highest)
2. `02-Generation-Specification.md` (generation behavior)
3. The remaining specifications (execution, interaction, adapters, boot, state, kernel)

A specification never overrides an architectural principle in the Constitution.

---

## How this framework is later used (NOT part of building v1)

When a developer starts a real project with AKRS v1:

1. Read the v1 framework.
2. Analyze the target project; confirm the Source of Truth.
3. Generate the workflow skeleton — Router, Memory, Plans, Phases (Phase A).
4. Generate `STATE.md`.
5. Generate Tasks + Roads on demand (Phase B).
6. Generate a fresh project-specific `KERNEL.md` from `08-Kernel-Specification.md`.
7. Remove the framework source documents from the generated project (only the Kernel ships).
8. Execute using the Kernel; reconcile via close-out as work lands.

The Kernel is regenerated for every project, never versioned, never stored in this repo,
never reused across projects. Only the framework belongs in version control.

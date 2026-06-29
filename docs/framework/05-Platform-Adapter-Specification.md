# AKRS Platform Adapter Specification (v1)

### How AKRS integrates with different AI platforms

Platform Adapters give each tool a standardized entry point into AKRS without becoming part
of the workflow. v1 makes **`AGENTS.md` the single canonical entry file**; every other tool
gets a **thin pointer** that just refers back to it. This is what makes the same behavior
load identically across Claude / Codex / Gemini / Cursor / Copilot.

---

## 1. Principles

1. **Adapters are not knowledge.** An adapter must never contain requirements, architecture,
   Memory, Plans, Tasks, or Roads. Its only job is directing the agent into AKRS.
2. **One workflow.** Every adapter activates the same AKRS workflow. Changing platforms must
   never change workflow behavior.
3. **Platform independence.** AKRS owns the workflow; platforms only provide entry
   mechanisms. The workflow stays independent of any specific platform.
4. **Adapters are disposable; the workflow is authoritative.** An adapter is **never** a
   Source of Truth.

---

## 2. The canonical entry file: `AGENTS.md`

`AGENTS.md` is Codex's native entry file and the single canonical adapter. It contains,
minimally and nothing more:

```markdown
# AGENTS.md
This project uses AKRS.

Boot: read `akrs/KERNEL.md`, then obey it. Do not execute before boot.
Fast path: trivial or isolated change → Mode 0/1 (skip the full chain).
```

No project knowledge lives here — adapters are disposable and never a Source of Truth. The
Kernel (`akrs/KERNEL.md`) holds the project's operating rules and pointers.

---

## 3. Thin pointer adapters

Every other famous tool gets a generated file that just points at `AGENTS.md`. Because
`@import` is **not** universal, the pointer mechanism differs per tool:

| Tool | File | Pointer mechanism |
|---|---|---|
| Codex CLI | `AGENTS.md` | native — *is* the canonical file |
| Claude Code / CLI | `CLAUDE.md` | `@AGENTS.md` import (native include) |
| Gemini CLI | `GEMINI.md` | plain instruction: "Read AGENTS.md and follow it." |
| Cursor | `.cursor/rules` | plain instruction: "Read AGENTS.md and follow it." |
| GitHub Copilot | `.github/copilot-instructions.md` | plain instruction: "Read AGENTS.md and follow it." |

Only Claude supports `@AGENTS.md`; everything else receives a plain "read AGENTS.md"
instruction. Additional adapters may be added without changing AKRS architecture.

---

## 4. Adapter responsibilities

Every adapter is responsible only for: activating AKRS, pointing the agent at the boot
sequence (`akrs/KERNEL.md`), identifying the runtime environment, and preventing the agent
from bypassing AKRS initialization. Nothing more.

---

## 5. Generation order

Adapters are generated **after** the workflow has been built and validated — and after the
Kernel exists, since adapters point at it:

```
Generate Workflow
  ↓
Validate Workflow
  ↓
Generate KERNEL.md            (08-Kernel-Specification.md)
  ↓
Generate AGENTS.md (canonical) + thin pointer adapters
  ↓
Workflow Ready
```

---

## 6. Discovery & existing adapters

On entering an existing project, the Leader detects available platform files
(`AGENTS.md`, `CLAUDE.md`, `.cursor/`, `.github/copilot-instructions.md`, others). The
detected environment determines which adapters to generate, update, or preserve.

If an adapter already exists:

- **Inspect it before any modification.**
- **Preserve existing instructions** whenever possible.
- **Never overwrite** without explicit Developer approval (destructive replacement requires
  confirmation — see `04-Developer-Interaction-Protocol.md §2.5`).

---

## 7. Completion

An adapter's responsibility ends the moment it activates AKRS. From there, behavior is
governed by the Runtime Boot Protocol and the active workflow. Because every tool boots the
same `AGENTS.md → KERNEL.md`, behavior is identical regardless of CLI.

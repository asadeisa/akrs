# AKRS Platform Adapter Specification (v1, revised v1.3)

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

Boot: read `akrs/kernel/CORE.md`, then declare your role and load `akrs/kernel/<role>.md`
(the Gate). Obey both. Do not execute before boot.
Fast path: trivial or isolated change → Mode 0/1 (skip the full chain).
```

No project knowledge lives here — adapters are disposable and never a Source of Truth. The
kernel folder (`akrs/kernel/` — `CORE.md` + one file per role) holds the project's operating
rules and pointers.

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

### Skill adapters (v1.3)

The framework's skills (`akrs-close-out`, `akrs-live-verify`) follow the **same one-body /
thin-pointer pattern** as `AGENTS.md`. Phase A instantiates each canonical body at
`akrs/skills/<name>.md` (the single owner of the procedure) and emits a **thin per-platform
pointer** so a tool that auto-discovers skills can surface it:

| Tool | Skill pointer file | Pointer body |
|---|---|---|
| Claude Code | `.claude/skills/<name>/SKILL.md` | frontmatter (`name` + `description`) + one line: *"Read and execute `akrs/skills/<name>.md`."* |
| Every other platform | — | routed by the kernel's pointer line to the same `akrs/skills/<name>.md` |

The canonical body is **never** placed inside a vendor dotfolder: `.claude/` is invisible to
some agents' file tools (hidden-dir filters) and reads as another vendor's private config to
others. One body, thin pointers — the procedure never exists twice. Agents reach a skill only
through its three routed discovery paths: the kernel pointer line, a platform adapter (above),
or a Task's `Skills:` field.

### Platform-neutral skill bodies (v1.3)

Skill bodies are **plain imperative markdown any model can execute** — no vendor tool ids, no
platform-only syntax. Shell steps are concrete runnable commands; browser automation is
described by **capability** ("drive the running page in a real browser; a Playwright-style
driver or the browser automation your platform provides"), never by a hardcoded tool name.
Frontmatter is `name` + `description` only (the open Agent Skills format). This keeps skills
**generator-agnostic**: any model (GPT, Gemini, any) can author them at init, and whoever boots
later can run them.

---

## 4. Adapter responsibilities

Every adapter is responsible only for: activating AKRS, pointing the agent at the boot
sequence (`akrs/kernel/CORE.md` → role file), identifying the runtime environment, and
preventing the agent from bypassing AKRS initialization. Nothing more.

---

## 5. Generation order

Adapters are generated **after** the workflow has been built and validated — and after the
Kernel exists, since adapters point at it:

```
Generate Workflow
  ↓
Validate Workflow
  ↓
Generate akrs/kernel/         (CORE + role files — 08-Kernel-Specification.md)
  ↓
Instantiate akrs/skills/      (canonical procedure bodies — 02 §7)
  ↓
Generate AGENTS.md (canonical) + thin pointer adapters (incl. .claude/skills/<name>/SKILL.md)
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
same `AGENTS.md → kernel/CORE.md + role file`, behavior is identical regardless of CLI.

# AKRS Platform Adapter Specification (v2)

### How AKRS integrates with different AI platforms

Platform Adapters give each tool a standardized entry point into AKRS without becoming part of
the workflow. **`AGENTS.md` is the single canonical entry file**; every other tool gets a **thin
pointer** that refers back to it. This is what makes the same behavior load identically across
Claude Code, Codex, Gemini CLI, Pi, opencode, Kimi Code CLI, Qwen Code, Cursor and Freebuff.

In v2 the adapters are **written by one command, `akrs agents setup`**, never by hand, and every
agent reaches AKRS through the same three surfaces: **CLI + skills**, and MCP where the agent
supports it. No feature requires MCP or hooks.

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
5. **Project scope only.** Setup writes inside the repository and nowhere else. For user-scope
   configuration (for example `~/.codex/config.toml`) it prints the exact path and snippet and
   writes nothing.

---

## 2. The canonical entry file: `AGENTS.md`

`AGENTS.md` is Codex's native entry file and the canonical adapter. `akrs agents setup` adds one
**managed block** to it (created when absent; user content outside the block is never touched):

```markdown
## AKRS

This project uses AKRS. Leaders start with `akrs boot`; Workers run `akrs work`, then `akrs done`.
Procedures are the skills in `.agents/skills/` (or `.claude/skills/`); run `akrs --help` for every command.
```

No project knowledge lives here. The project's operating rules live in the kernel folder
(`akrs/kernel/` — `CORE.md` + one file per role, `08-Kernel-Specification.md`), which `akrs boot`
returns to the Leader and the Worker packet makes unnecessary to read.

---

## 3. Per-agent wiring (`akrs agents setup | doctor | list`)

`akrs agents list` prints the registry (each agent's verified instruction, skill, MCP and hook
facts, and what is excluded as unverified); `akrs agents setup [--agent <id>]` wires one agent or
all nine; `akrs agents doctor` reports, per agent, which managed files are current, missing,
outdated or hand-modified, what the agent supports, and the exact setup command that repairs it.
A setup that would overwrite user content reports a conflict and leaves the file untouched.
`--dry-run` shows every file first.

| Agent | Instructions | Skill pointers | MCP config (project) | Pre-write guard |
|---|---|---|---|---|
| Claude Code | `CLAUDE.md` block holding `@AGENTS.md` | `.claude/skills/` | `.mcp.json` | yes (`PreToolUse`) |
| Codex CLI | `AGENTS.md` | `.agents/skills/` | `.codex/config.toml` | CLI + skills |
| Gemini CLI | `GEMINI.md` block holding `@./AGENTS.md` | `.agents/skills/` | `.gemini/settings.json` | CLI + skills |
| Pi | `AGENTS.md` | `.agents/skills/` | `.pi/mcp.json` only with `--pi-mcp` | CLI + skills |
| opencode | `AGENTS.md` | `.agents/skills/` | `opencode.json` | CLI + skills |
| Kimi Code CLI | `AGENTS.md` | `.agents/skills/` | `.kimi-code/mcp.json` | CLI + skills |
| Qwen Code | `AGENTS.md` | `.qwen/skills/` | `.qwen/settings.json` | CLI + skills |
| Cursor | `AGENTS.md` | `.agents/skills/` | `.cursor/mcp.json` | CLI + skills |
| Freebuff | `AGENTS.md` | `.agents/skills/` | `.agents/mcp.json` | CLI + skills |

The table is a convenience snapshot: **`akrs agents list` is the source of truth** and carries the
date each fact was verified. A hook is installed only where its payload and deny protocol were
verified (today Claude Code); everywhere else the **audit at `done`** is the backstop.

### The MCP server (`akrs mcp`)

`akrs mcp` serves the CLI over MCP stdio, zero dependencies, projected from the same command
manifest: at most seven flat tools (`akrs_status`, `akrs_road`, `akrs_work`, `akrs_scope`,
`akrs_test`, `akrs_write`, `akrs_page`), each taking an `action` and flat arguments, each returning
the same packet as `--json`. Structured input travels as a draft path, never as nested objects.
One server per project; the role is per call, so a single agent can act as Leader and Worker.
Setup registers it by merging an `akrs` entry that launches `node <abs>/akrs.js mcp`.

### The write guard (`akrs guard`)

Where an agent has a verified pre-write hook, setup registers `bin/akrs-guard.js`, which decides
one write from the Worker's lease: it **allows** when no lease matches (Leader, Tester and human
sessions are never blocked), **denies** a write outside the lease's declared writes or under
`forbidden`, and always denies a direct edit to CLI-owned workflow state (drafts excepted). If the
guard itself fails, the write is allowed and `done`'s audit catches it. Prevent, then detect.

---

## 4. Skill adapters

The framework's skills (`skills/`: `akrs-classify-executors`, `akrs-road-author`,
`akrs-work-loop`, `akrs-scope-request`, `akrs-close-out`, `akrs-live-verify`) follow the **same
one-body / thin-pointer pattern** as `AGENTS.md`. The canonical body is `akrs/skills/<name>.md`
when the project keeps such a folder, otherwise the copy `akrs init` installed at
`docs/akrs/framework/skills/<name>.md`. Setup emits, per agent, a real file (never a symlink)
`<dir>/<name>/SKILL.md` holding only `name` and `description` frontmatter plus a managed block that
says to read and execute the body.

The canonical body is **never** placed inside a vendor dotfolder: `.claude/` is invisible to some
agents' file tools (hidden-dir filters) and reads as another vendor's private config to others.
One body, thin pointers — the procedure never exists twice. Agents reach a skill only through its
routed discovery paths: the kernel pointer line, the agent's skill pointer, or the packet that
names it.

### Platform-neutral skill bodies

Skill bodies are **plain imperative markdown any model can execute** — no vendor tool ids, no
platform-only syntax. Shell steps are concrete runnable commands; browser automation is described
by **capability** (`akrs page`, `akrs test run`), never by a hardcoded tool name. Frontmatter is
`name` + `description` only (the open Agent Skills format). This keeps skills
**generator-agnostic**: any model can author them, and whoever boots later can run them.

---

## 5. Adapter responsibilities

Every adapter is responsible only for: activating AKRS, pointing the agent at its entry commands
(`akrs boot` / `akrs work` / `akrs test-details`) and at the skills, identifying the runtime
environment, and preventing the agent from bypassing AKRS initialization. Nothing more.

---

## 6. Generation order

Adapters are generated **after** the workflow has been built and validated — and after the Kernel
exists, since `boot` returns it:

```
Generate Workflow
  ↓
Validate Workflow                (akrs validate)
  ↓
Generate akrs/kernel/            (CORE + role files — 08-Kernel-Specification.md)
  ↓
Wire the agents                  (akrs agents setup, then akrs agents doctor)
  ↓
Workflow Ready
```

---

## 7. Discovery & existing adapters

On entering an existing project, `akrs agents doctor` detects what is already wired and what is
hand-modified. If an adapter file already exists:

- **Inspect it before any modification** (`--dry-run`).
- **Preserve existing instructions**: setup merges managed blocks and entries and never
  replaces a file.
- **Never overwrite** without explicit Developer approval (destructive replacement requires
  confirmation — see `04-Developer-Interaction-Protocol.md §2.5`).

---

## 8. Completion

An adapter's responsibility ends the moment it activates AKRS. From there, behavior is governed by
the Runtime Boot Protocol and the active workflow. Because every tool enters through the same
`AGENTS.md` and the same commands, behavior is identical regardless of CLI.

Out of scope in v2: an HTTP server, a desktop shell, remote orchestration and multi-worktree
coordination. `akrs view` (a static board), `akrs watch` (a change stream), `akrs graph` and the
`projects` registry exist so a future application can consume the same packets; none of them is
that application.

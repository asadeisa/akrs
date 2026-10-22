# Roadmap

AKRS is a **doctrine plus a small CLI**. The architecture is stable; what evolves is the tooling
around it. Version numbers are assigned when something ships (see [`CHANGELOG.md`](CHANGELOG.md)
and `package.json`), not before.

---

## Shipped in v2

- **Framework specification** — `docs/framework/` (01–11 + `skills/`), rewritten around the v2
  contracts: content from the agent, form from the CLI.
- **The Kernel** — heavy doctrine teaches the Leader; a ~1-page compiled kernel folder is what
  the target project carries. New behavior ships as skills, not Kernel prose.
- **Canonical workflow records** — Roads, State, executors, verification contracts, handoffs,
  results and the closure ledger are JSON/JSONL written only by their command (schemas, content
  hashes, `--dry-run`, snapshot guards, an operation journal and recoverable transactions).
  `STATE.md` is derived.
- **Agent loops with one call per intent** — Leader `boot`; Worker `work` → `done` (and `yield`);
  Tester `test-details` → `test run` → `test result`; leases, a Leader-authored scope envelope
  and a pre-write guard.
- **Executor classes** — the user classifies each model (weak, medium, frontier); Road size and
  packet shape follow the class.
- **Scale mechanics** — SoT Index, read windows, progressive analysis, domain partitioning: no
  agent ever reads a whole large source.
- **Verification** — a Plan-level contract, a scenario runner (`test run`: browser and HTTP,
  evidence, run records), raw measurement against a budget, the Mirror Check, seam ownership and
  expiring open questions; `plan finish` refuses without a current pass.
- **Every agent** — `akrs agents setup|doctor|list` for Claude Code, Codex, Gemini CLI, Pi,
  opencode, Kimi Code CLI, Qwen Code, Cursor and Freebuff; an MCP stdio server (`akrs mcp`).
- **Honest validation** — `validate` (19 checks, read-only), `explain`, `doctor`, `audit`,
  `stale`, `status`, `next`.
- **Desktop-ready surfaces** — `graph`, `view` (a static board), `watch` (a change stream) and the
  `projects` registry, all over the same packets. Browser reads: `akrs page`.
- **Distribution** — npm / pnpm / yarn, `npx akrs-framework init`, and a postinstall that syncs
  doctrine out of `node_modules` into `docs/akrs/`.

Per-version detail: [`CHANGELOG.md`](CHANGELOG.md).

**Focus right now: adoption and real-world feedback.** If you have run AKRS on anything,
[issue #3](https://github.com/asadeisa/akrs/issues/3) is where that goes — including the runs
that went badly.

---

## Next

### Still open in v2

- **Deeper verification.** The Mirror Check is mandatory but has no mechanical enforcement — a
  zero-dependency CLI cannot parse imports across arbitrary languages. The specification
  recommends a ~50-line per-project import-lint, and that reference implementation has not
  shipped yet: [issue #2](https://github.com/asadeisa/akrs/issues/2).

### Templates and examples

Purely additive content; no architectural change.

- Curated `templates/` for common stacks — Node service, React app, monorepo.
- More worked `examples/` beyond `examples/minimal` — existing-project integration.
- A copy-paste **Leader prompt pack** for the major agent CLIs.

---

## Deferred (explicitly not v2)

- **Phase 3: multi-worktree orchestration** — coordinators, cross-worktree claims, parallel
  fan-out across worktrees. Leases are per repository today (`akrs/.ops/`, git-ignored, so each
  worktree has its own) and must not be assumed to coordinate worktrees.
- **An HTTP server and a desktop application.** v2 ships the packets and a static board
  (`view`); an app that manages several projects would consume them, and is not built.
- Remote orchestration, semantic duplicate detection and code-similarity features.

A change that breaks the route or the artifact contract is a MAJOR version
(see [`VERSIONING.md`](VERSIONING.md)).

---

## Guiding constraint

Every future feature must preserve the core promise:

> Deliver the smallest correct knowledge, to the correct agent, at the correct
> moment.

If a feature grows the Worker's decision space, it does not belong in AKRS.

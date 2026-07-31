# Roadmap

AKRS is **documentation-first** by design. The architecture is stable; what
evolves is the tooling around it. Nothing planned below requires restructuring
the repository or breaking a generated workflow.

**Current release: v1.3.1.** Unreleased work is deliberately left unnumbered —
version numbers get assigned when something actually ships, not before.

---

## Shipped

- **Framework specification** complete — `docs/framework/` (01–11 + `skills/`).
- **The Kernel** — heavy doctrine teaches the Leader; a ~1-page compiled kernel
  folder is what the target project actually carries.
- **STATE + close-out lifecycle** — a portable save-point any CLI can resume
  from, and mandatory reconciliation when work lands, so a Road and a Memory can
  never disagree about the code.
- **Scale mechanics** — SoT Index, read windows, progressive analysis, domain
  partitioning: no agent ever reads a whole large source.
- **Verification** — the Tester role, idea-level `Verify:`, the Mirror Check, the
  Test-Handoff baton, raw measurement against a budget, seam ownership, expiring
  open questions.
- **Change management** — the FEATURES index, on-demand change files,
  merge-or-vanish, the requirements-delta procedure.
- **Skills** — `akrs-close-out` and `akrs-live-verify` as single-owner,
  platform-neutral procedure bodies.
- **`validate` CLI** — 17 mechanical checks, `--fix`, `--clean`, zero
  dependencies. CI green = workflow valid.
- **Distribution** — npm / pnpm / yarn, `npx akrs-framework init`, and a
  postinstall that syncs doctrine out of `node_modules` into `docs/akrs/`.

Per-version detail: [`CHANGELOG.md`](CHANGELOG.md).

**Focus right now: adoption and real-world feedback.** If you have run AKRS on
anything, [issue #3](https://github.com/asadeisa/akrs/issues/3) is where that
goes — including the runs that went badly.

---

## Next

### Templates and examples

Purely additive content; no architectural change.

- Curated `templates/` for common stacks — Node service, React app, monorepo.
- More worked `examples/` — existing-project integration, v0 → v1 migration.
- A copy-paste **Leader prompt pack** for the major agent CLIs.

### `scaffold` — growing the CLI from copying docs to building a workflow

`init` vendors the framework into `docs/akrs/`. The next step turns the CLI into
a generator:

```
npx akrs-framework scaffold
```

- Scaffolds `akrs/` interactively — Router, Memory, STATE.
- Confirms the Source of Truth before generating anything.
- Emits a starter `AGENTS.md` plus the thin per-tool pointers.

The package layout already anticipates this: the CLI ships alongside the
framework docs, it does not replace them.

### Deeper verification

The Mirror Check is mandatory but has no mechanical enforcement — a
zero-dependency CLI cannot parse imports across arbitrary languages. The
specification recommends a ~50-line per-project import-lint instead, and that
reference implementation has not shipped yet:
[issue #2](https://github.com/asadeisa/akrs/issues/2).

---

## v2.0 — only if something breaks compatibility

- Assisted **Kernel generation** driven by a chosen model.
- Multi-model orchestration wired end-to-end — Leader plans, Worker executes.
- Platform integrations for major agent runtimes.

A v2 happens only if a change breaks the route or the artifact contract.
Otherwise these land as v1.x minors.

---

## Guiding constraint

Every future feature must preserve the core promise:

> Deliver the smallest correct knowledge, to the correct agent, at the correct
> moment.

If a feature grows the Worker's decision space, it does not belong in AKRS.

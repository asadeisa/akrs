# Roadmap

AKRS v1 is **documentation-first** by design. The architecture is stable; what
evolves is the tooling around it. Everything below is planned so that no step
requires restructuring the repository.

---

## v1.x — Now

- ✅ Framework specification complete (`docs/framework/`)
- ✅ Validation with multiple models (`docs/validation/`)
- ✅ Human guides and release engineering docs
- ✅ npm / pnpm / yarn distribution
- ✅ `npx akrs-framework init` — copies the framework into a project's `docs/akrs/`
- ✅ **v1.3** — the subtraction release: LOG → one-line ledger, the skills seam filled
  (`akrs-close-out` / `akrs-live-verify`), the verification diet, and `validate` grown to
  **17 checks** (LOG rotation + ledger lint + parked-owner warn). Details in `CHANGELOG.md`.

Focus: stability, clarity, adoption. Gather real-world feedback.

---

## v1.1 — Templates & Examples

- Curated `templates/` for common stacks (Node service, React app, monorepo).
- More worked `examples/` (existing-project integration, v0→v1 migration).
- A copy-paste **Leader prompt pack** for popular models.

No architectural change — purely additive content.

---

## v1.2 — CLI scaffolding (the big one)

`npx akrs-framework init` exists today (it vendors the framework into `docs/akrs/`). v1.2
grows the CLI from *copying docs* into *scaffolding a workflow*:

```
npx akrs-framework scaffold
```

- Scaffolds `akrs/` (Router, Memory, STATE) interactively.
- Confirms Source of Truth before generating anything.
- Emits a starter `AGENTS.md` + tool pointers.

The current package layout already anticipates this: the CLI ships alongside the
framework docs, it does not replace them.

---

## Validation Utilities — shipped in v1.2

The mechanical lint is no longer a roadmap item — it shipped in **v1.2** as
**`npx akrs-framework validate`** and grew in **v1.3** to **17 checks** (`--fix` now also
rotates an over-size `LOG.md` ledger; `--clean` unchanged; see
`07-State-And-Sync-Specification.md` §6). Generated projects also ship a `package.json` wiring
`npm run validate`. Future work here is deeper, project-specific verification (e.g. the
~50-line import-lint the Mirror Check recommends).

---

## v2.0 — Generation & Orchestration

- Assisted **Kernel generation** from a chosen model.
- Multi-model orchestration (Leader plans, Worker executes) wired end-to-end.
- Platform integrations / adapters for major agent runtimes.

A v2 only happens if it requires a breaking change to the route or artifacts;
otherwise these land as v1.x minors.

---

## Guiding Constraint

Every future feature must preserve the core promise:

> Deliver the smallest correct knowledge, to the correct agent, at the correct
> moment.

If a feature grows the Worker's decision space, it does not belong in AKRS.

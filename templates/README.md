# Templates

Reusable starting points for AKRS workflows.

This folder is intentionally minimal in v1.0 — AKRS is documentation-first today,
and the canonical templates ship inside the framework specification:

- The **Kernel template** lives in
  [`../docs/framework/08-Kernel-Specification.md`](../docs/framework/08-Kernel-Specification.md).
- The **`STATE.md` template** lives in
  [`../docs/framework/07-State-And-Sync-Specification.md`](../docs/framework/07-State-And-Sync-Specification.md).
- The **`AGENTS.md` adapter template** lives in
  [`../docs/framework/05-Platform-Adapter-Specification.md`](../docs/framework/05-Platform-Adapter-Specification.md).

---

## Roadmap

The `npx akrs-framework init` CLI already ships today — it copies the framework
docs into your project's `docs/akrs/`. What's still planned is the *content* that
lives here: stack-specific scaffolds (Node service, React app, monorepo) and a
copy-paste Leader prompt pack, which will feed the interactive
`npx akrs-framework scaffold` command. See [`../ROADMAP.md`](../ROADMAP.md).

This folder exists now so that future tooling has a stable home — no repository
restructuring required when those scaffolds land.

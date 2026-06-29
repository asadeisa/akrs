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

Stack-specific scaffolds (Node service, React app, monorepo) and a copy-paste
Leader prompt pack are planned for **v1.1**, and will become the basis for the
future `npx akrs init` CLI. See [`../ROADMAP.md`](../ROADMAP.md).

This folder exists now so that future tooling has a stable home — no repository
restructuring required when the CLI lands.

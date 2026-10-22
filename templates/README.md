# Templates

Reusable starting points for AKRS workflows.

The templates that matter ship **inside the CLI**, so they always match the schemas:

- **Record skeletons** — `akrs template <road|task|verification|memory|scope|handoff|result>`
  prints a valid skeleton plus a field guide; `--to-draft <name>` saves it as a draft you fill in
  and pass to the writer command (`--input akrs/drafts/<name>.json`). `--class weak|medium|frontier`
  shapes a Road skeleton for an executor class.
- **A whole minimal workflow** — `akrs init --scaffold [--plan <id>]` writes a Road, a Task, the
  State and a verification contract in one transaction. [`../examples/minimal`](../examples/minimal)
  is exactly that output plus two executors.
- **The Kernel templates** live in
  [`../docs/framework/08-Kernel-Specification.md`](../docs/framework/08-Kernel-Specification.md).
- **The `AGENTS.md` pointer** is written by `akrs agents setup`
  ([`../docs/framework/05-Platform-Adapter-Specification.md`](../docs/framework/05-Platform-Adapter-Specification.md)).

---

## Roadmap

What is still planned for this folder is *content*: stack-specific starting points (Node service,
React app, monorepo) and a copy-paste Leader prompt pack. See [`../ROADMAP.md`](../ROADMAP.md).

This folder exists now so that future tooling has a stable home — no repository restructuring
required when those land.

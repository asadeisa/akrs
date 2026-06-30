# Changelog

All notable changes to the AKRS framework are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/). See
[VERSIONING.md](VERSIONING.md) for how the framework, workflow, and kernel
version lines relate.

---

## [1.0.0] — 2026-06-30

First public release. The framework is feature-complete, validated with multiple
models, and ships with the `npx akrs init` CLI for one-command setup.

### Added
- **`npx akrs init`** — a CLI command that copies the framework into the
  developer's project under `docs/akrs/` (the doctrine `framework/`, the
  `guides/`, and `GETTING_STARTED.md`), instead of leaving it buried in
  `node_modules`. Re-run with `--force` to refresh. Ships as the `akrs` bin
  (`bin/akrs.js`); no dependencies added.
- **Kernel** — a minified, per-project operating file compiled by the Leader, so
  heavy doctrine never ships to the target project (`08-Kernel-Specification.md`).
- **STATE.md + close-out lifecycle** — a portable save-point plus mandatory
  Road reconciliation that prevents drift (`07-State-And-Sync-Specification.md`).
- **Operational Developer Interaction Protocol** — recommended-first options,
  one decision at a time, a guided next step every turn
  (`04-Developer-Interaction-Protocol.md`).
- **Single canonical `AGENTS.md`** entry file with thin per-tool pointer adapters
  (`05-Platform-Adapter-Specification.md`).
- **Applicability scale** — Lite vs. Full, driven by blast radius
  (`01-Constitution.md` §12).
- Human guides: `GETTING_STARTED.md`, `docs/guides/ROUTING-FLOW.md`,
  `docs/guides/FILE-STRUCTURE.md`.
- Validation suite under `docs/validation/` (Claude, Gemini, DeepSeek + Atlas ERP
  case study).
- Release engineering docs: `CONTRIBUTING.md`, `VERSIONING.md`, `ROADMAP.md`,
  `RELEASE.md`.
- npm/pnpm/yarn package metadata (`package.json`).

### Changed
- Repository reorganized into `docs/framework`, `docs/guides`, `docs/validation`,
  `docs/research`, `examples`, and `templates` to support future tooling without
  restructuring.
- README rewritten around the framework's philosophy, not the documentation.
- README and `GETTING_STARTED.md` lead with `npx akrs init`; the plain
  `npm install` / clone paths are kept as alternatives.

### Preserved
- The complete **v0** specification is frozen under `docs/research/v0/`, with its
  benchmark harness under `docs/research/v0-benchmark/`. Nothing in v0 was
  modified — it remains the historical reference implementation.

---

## [0.x] — pre-release (v0)

The original AKRS specification: the read-once doctrine, the artifact layers
(Router / Memory / Road / Task / Plan / Phase), and the first real-project test
harness. Preserved unchanged under `docs/research/v0/`.

[1.0.0]: https://github.com/asadeisa/akrs/releases/tag/v1.0.0

# Changelog

All notable changes to the AKRS framework are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/). See
[VERSIONING.md](VERSIONING.md) for how the framework, workflow, and kernel
version lines relate.

---

## [1.1.1] — 2026-06-30

### Fixed
- Corrected the install/CLI command in all docs to **`npx akrs-framework init`**.
  The package is published as `akrs-framework`, so the command advertised in
  1.1.0 (`npx akrs init`) did not resolve — npm has no package named `akrs`, and
  that name is unavailable. Docs-only change; no code or framework changes.

---

## [1.1.0] — 2026-06-30

Adds the `npx akrs-framework init` CLI and a substantial documentation pass. No
changes to the framework specifications or the routing architecture.

### Added
- **`npx akrs-framework init`** — a CLI command that copies the framework into
  the developer's project under `docs/akrs/` (the doctrine `framework/`, the
  `guides/`, and `GETTING_STARTED.md`), instead of leaving it buried in
  `node_modules`. Re-run with `--force` to refresh. Ships as the `akrs` bin
  (`bin/akrs.js`); no dependencies added.

### Changed
- README and `GETTING_STARTED.md` now lead with `npx akrs-framework init` (npm install /
  clone kept as alternatives), and present the value proposition as narrowing
  the decision space for *any* model — not only inexpensive ones.
- README: renamed "The London Story" → "The Philosophy Behind AKRS", added a
  Modes table to "How It Works", and removed the Roadmap section.
- `GETTING_STARTED.md`: "three things" rewritten as real requirements; Step 6 no
  longer forces a cheap Worker (subagents and other options); Step 7 reframes
  close-out as system-handled, with a verify-and-fix path.
- `docs/guides/FILE-STRUCTURE.md`: note that the copied framework docs can be
  deleted once the Kernel exists (keep `akrs/` + the Source of Truth).
- `templates/README.md` and `ROADMAP.md`: `npx akrs-framework init` is current;
  the still-planned interactive scaffolder is `npx akrs-framework scaffold`.

### Fixed
- Dropped the unverified "30–70× / ~$25–50 frontier-cost" estimates from the
  validation docs and the Atlas ERP case study; they now state the measured
  $0.688 instead.

---

## [1.0.0] — 2026-06-29

First public release. The framework is feature-complete, validated with multiple
models, and structured for future CLI expansion.

### Added
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
- README rewritten around the framework (philosophy + 30-second model), not the
  documentation.

### Preserved
- The complete **v0** specification is frozen under `docs/research/v0/`, with its
  benchmark harness under `docs/research/v0-benchmark/`. Nothing in v0 was
  modified — it remains the historical reference implementation.

---

## [0.x] — pre-release (v0)

The original AKRS specification: the read-once doctrine, the artifact layers
(Router / Memory / Road / Task / Plan / Phase), and the first real-project test
harness. Preserved unchanged under `docs/research/v0/`.

[1.1.1]: https://github.com/asadeisa/akrs/releases/tag/v1.1.1
[1.1.0]: https://github.com/asadeisa/akrs/releases/tag/v1.1.0
[1.0.0]: https://github.com/asadeisa/akrs/releases/tag/v1.0.0

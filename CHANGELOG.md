# Changelog

All notable changes to the AKRS framework are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/). See
[VERSIONING.md](VERSIONING.md) for how the framework, workflow, and kernel
version lines relate.

---

## [1.2.0] — 2026-07-03

A large, **backward-compatible** growth of the framework (D4/D8: nothing removed or weakened;
existing generated workflows keep working). Adds three new spec docs (09/10/11), the kernel
folder + Gate, and the `validate` CLI.

### Added
- **`LOG.md` — the append-only close-out journal.** `STATE.md` is now a ≤ ~1-page save-point
  (rewritten fresh, last-3 Done, `Role:` field, parallel table); full narratives + a
  `Metrics:` line move to `LOG.md`, which is never read at boot
  (`07-State-And-Sync-Specification.md`).
- **`QUEUED` Road status + sanctioned per-plan batch generation**, with a staleness
  re-validation before any `QUEUED` Road activates (`07`, `02-Generation-Specification.md`).
- **Leader-decided Task/Road granularity** + a hard Task/Road no-duplication rule (`02`).
- **`Deps:` dependency gating** (an `ACTIVE` Road's deps must be `DONE` or STATE-overridden),
  **role-at-boot** (`leader | worker | tester`), and **one Road = one commit** (`03`, `06`).
- **Epistemic labels** (`Decided` / `Assumption H-M-L` / `Unknown`) and **assumption aging**
  (`02 §6`).
- **Overhead budget (D12)** — close-out touches at most LOG + STATE + Road + one Memory + one
  FEATURES line; the workflow never becomes the agent's main job (`01 §14`).
- **`09-Scale-And-Source-Index-Specification.md`** — the SoT Index, read windows, progressive
  per-domain analysis, domain partitioning + `GLOBAL.md`: no agent ever reads the whole
  Source of Truth.
- **`10-Verification-Specification.md`** — the **Tester** role, the **Mirror Check**,
  idea-level `Verify:` (`none|idea|measured`), the **Test-Handoff** baton, raw measurement
  against a SoT budget, seam ownership, expiring open questions, SoT acceptance lines,
  persistent verification (`tests/`), and tester memory.
- **`11-Change-Management-Specification.md`** — the **`FEATURES.md`** landed-features index,
  the on-demand **change file**, **merge-or-vanish** completion, and the requirements-delta
  procedure.
- **The kernel folder + the Gate** — the compiled artifact is now `akrs/kernel/` (`CORE.md`
  + `worker/leader/tester/changer.md`); the Gate boots `CORE.md` + exactly one role file
  (`08-Kernel-Specification.md`, `06`).
- **`BLOCKED.md`** — an on-demand flag a stuck non-leader agent raises (`03`, `06`).
- **`Skills:` field** on Tasks — optional skill / MCP-tool names (`02 §5`).
- **`npx akrs-framework validate`** — a zero-dependency CLI with **14 checks**, plus `--fix`
  (sync mirrored Road statuses) and `--clean` (delete stale ephemerals). CI green = workflow
  valid (`bin/akrs.js`, `07 §6`).
- **`docs/guides/TEAM-ADOPTION.md`** — vocabulary translation, ticket/PR/CI mapping,
  parallel-work story, and the LOG-metrics ROI slide.

### Changed
- The Kernel is a **folder** booted via the **Gate**, not a single `KERNEL.md`; all
  non-frozen docs, guides, `GETTING_STARTED.md`, and `VERSIONING.md` updated accordingly.
- Boot sequence (`06 §2`) adds the Gate + role declaration + a `BLOCKED.md` first-action check.
- Close-out order is **LOG → STATE → Road → Memory**, then `validate`; Plan close-out adds the
  Mirror Check, raw measurement, seam/open-question gates, and one `FEATURES.md` line.
- `07 §6` rewritten from "Optional lint (later)" to **Mechanical validation** (the CLI ships);
  `ROADMAP.md` updated to reflect it.
- Human guides (`FILE-STRUCTURE.md`, `ROUTING-FLOW.md`) refreshed for the kernel folder, the
  Gate, the Tester lane, the change lane, and the ephemeral artifacts.

### Preserved
- **v0** (`docs/research/v0/`) and the **validation** results (`docs/validation/`) are
  untouched. Doc identity headers keep their "(v1)" lineage (D8); only the package version and
  the new v1.2 specs carry the v1.2 label.

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

[1.2.0]: https://github.com/asadeisa/akrs/releases/tag/v1.2.0
[1.1.1]: https://github.com/asadeisa/akrs/releases/tag/v1.1.1
[1.1.0]: https://github.com/asadeisa/akrs/releases/tag/v1.1.0
[1.0.0]: https://github.com/asadeisa/akrs/releases/tag/v1.0.0

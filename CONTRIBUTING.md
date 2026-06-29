# Contributing to AKRS

Thanks for your interest in improving AKRS. This project is documentation-first
today and tooling-first tomorrow, so contributions span both writing and code.

---

## Ground Rule: Respect the Architecture

AKRS is opinionated on purpose. Before proposing a change, read
[`docs/framework/01-Constitution.md`](docs/framework/01-Constitution.md). The
Constitution has the highest authority; a specification never overrides an
architectural principle.

A change that **grows the Worker's decision space** is almost always wrong, even
if it adds a feature. The whole framework exists to shrink that space.

---

## Types of Contributions

| Type | Examples | Where |
|------|----------|-------|
| **Clarifications** | Fix ambiguity, typos, broken links | `docs/` |
| **Validation** | New model tested, new case study | `docs/validation/` |
| **Examples** | A working sample workflow | `examples/` |
| **Templates** | Reusable starting points | `templates/` |
| **Tooling** | CLI, linter, generators (see `ROADMAP.md`) | future `src/` |

---

## Documentation Rules

The same rules AKRS imposes on workflows apply to its own docs:

- **One owner per concept.** Don't restate a rule that already lives elsewhere —
  link to it.
- **No duplication.** If two files would explain the same thing, one of them is
  wrong.
- **Reference over explanation.** Reduce reading effort; never increase it.
- **Frozen history.** Never edit `docs/research/` — it is the historical record.

---

## Pull Requests

1. **Open an issue first** for anything beyond a typo, so we can agree on
   direction before you invest time.
2. Keep PRs **small and atomic** — one logical change per PR.
3. Update the relevant docs **and** [`CHANGELOG.md`](CHANGELOG.md) (Unreleased
   section) in the same PR.
4. If you touched anything user-facing, check there are **no broken links** and
   that diagrams still render.
5. Describe the *why*, not just the *what*, in the PR body.

---

## Reporting Issues

A good issue includes:

- What you expected vs. what happened.
- The framework version (`package.json` / `CHANGELOG.md`).
- If it's about generation/execution: which model acted as Leader/Worker, and
  the relevant Road/Kernel snippet.

Routing failures ("the Worker wandered") are usually workflow bugs, not model
bugs — include the Road and Kernel so we can see the routing.

---

## Release Philosophy

- Small, frequent, well-documented releases over big-bang drops.
- Every release updates the CHANGELOG and follows [`RELEASE.md`](RELEASE.md).
- Versioning follows [`VERSIONING.md`](VERSIONING.md).

---

## License

By contributing, you agree your contributions are licensed under the project's
[MIT License](LICENSE).

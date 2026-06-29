# Examples

Worked examples of AKRS on real projects. Examples are one of the fastest ways to
learn the framework — read one end-to-end, then mirror its structure.

> The most complete worked example today is the **Atlas ERP case study** under
> [`../docs/validation/case-study-atlas-erp.md`](../docs/validation/case-study-atlas-erp.md),
> which walks a full Phase A → Phase B → execute → close-out cycle.

---

## Planned layout

As examples are added, they live here under self-describing folders:

```
examples/
├── basic-project/      Minimal AKRS Lite setup — Kernel + Router + one Road
├── existing-project/   Adopting AKRS inside a legacy codebase
├── migration-v0/       Moving a v0 workflow to v1 (Kernel + STATE + close-out)
└── full-workflow/      Full tier — Plans/Phases/Memory, multiple Roads
```

Each example folder contains its own `README.md` explaining what it shows and how
to run it.

---

## Contributing an example

Examples are welcome contributions. A good example:

- targets one clearly stated scenario,
- includes the generated `akrs/` structure (Kernel, Router, Memory, a Road),
- shows at least one **close-out**, and
- excludes build artifacts (`node_modules/`, run outputs) via `.gitignore`.

See [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

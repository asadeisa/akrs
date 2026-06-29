# Validation — Claude as Leader & Reviewer

**Roles:** framework co-design, and independent evaluation of the DeepSeek +
Gemini runs.

---

## Reviewer role

Claude evaluated the generated workflow and the execution run against the
framework's own validation checklist, in analysis-only mode (no code execution
during review). It checked:

- **Ownership** — every concept has exactly one owner; no duplication across
  Memory, Router, Roads, Tasks.
- **Routing** — Router contains routes only; Memory is an index, not a wiki.
- **Scope** — the Worker's output stayed within the Road's boundaries.
- **Close-out** — `STATE.md`, Road status, and code agreed after execution.

Findings are written up in [`deepseek.md`](deepseek.md), [`gemini.md`](gemini.md),
and the full [`case-study-atlas-erp.md`](case-study-atlas-erp.md).

---

## Leader role

Claude was also used to reason about and refine the v1 framework itself — the
Kernel concept, the STATE/close-out lifecycle, and the canonical `AGENTS.md`
adapter model. Those design analyses are preserved (frozen) under
[`../research/design-history/`](../research/design-history/).

---

## Why a frontier model in the loop matters (and where it doesn't)

The framework's thesis is **"Leaders think, Workers execute."** A strong model is
valuable for the *one-time* jobs — designing the workflow, compiling the Kernel,
reviewing for drift. It is deliberately **not** required for the repeated job of
execution, which the Gemini Flash run demonstrates.

So the validated division of labor is:

| Job | Frequency | Model class | Evidence |
|-----|-----------|-------------|----------|
| Design / generate / compile Kernel | Once per project | Strong (Claude / DeepSeek) | [`deepseek.md`](deepseek.md) |
| Execute Roads + close-out | Many times | Cheap (Gemini Flash) | [`gemini.md`](gemini.md) |

---

## Verdict

The framework holds up under independent review: the artifacts satisfy the
Constitution's rules, and the cheap-Worker execution matched the intent of the
strong-Leader plan.

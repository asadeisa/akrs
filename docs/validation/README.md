# Validation

AKRS is not a theory. This folder documents what happened when real models ran
real workflows under the framework.

The goal here is **confidence, not marketing**: what was tested, how, and what we
actually observed — including the rough edges.

---

## Summary

| Model | Role tested | What it did | Result |
|-------|-------------|-------------|--------|
| **DeepSeek** | Leader | Generated the workflow (Phase A + Phase B) and absorbed two requirement changes | ✅ Passed — [`deepseek.md`](deepseek.md) |
| **Gemini Flash** | Worker | Self-navigated and executed a Road, then performed close-out | ✅ Passed — [`gemini.md`](gemini.md) |
| **Claude** | Leader / Reviewer | Framework design + independent evaluation of the runs | ✅ Passed — [`claude.md`](claude.md) |

Full worked example: [`case-study-atlas-erp.md`](case-study-atlas-erp.md).

---

## What "passed" means

A run passed if it satisfied the framework's own validation rules:

- One owner per concept; **no duplicated knowledge**.
- The Worker **stayed in scope** and did not redesign.
- **Self-navigation** — the Worker found what to read via the Kernel/Road, not by
  scanning the repo or asking.
- **Close-out** kept `STATE.md`, the Road, and Memory in agreement (no drift).

---

## Headline finding

> A **less-capable** execution model (Gemini Flash), given a one-line prompt and a
> well-structured workflow, produced production-grade code, stayed in scope, and
> closed out correctly — at roughly **30–70× lower cost** than running a frontier
> model for the same work.

That is the entire thesis of AKRS, observed in practice: let the expensive model
think once; let the cheap model execute many times.

---

## Honest limitations

- Cross-tool handoff (Leader in one CLI, Worker in another) is **designed and
  format-compatible** via `STATE.md`, and we ran Leader/Worker as *different
  models*, but a long multi-tool relay over many sessions hasn't been
  stress-tested yet.
- GPT-family models haven't been run through a full cycle yet (planned — see
  [`../../ROADMAP.md`](../../ROADMAP.md)).
- Validation so far covers one domain (an ERP) at "Full" applicability. Lite/Skip
  tiers are reasoned about in the Constitution but less exercised.

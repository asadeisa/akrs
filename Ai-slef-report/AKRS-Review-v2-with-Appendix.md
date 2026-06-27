# AKRS Review v2 — Constitution + Appendix

> Re-run of my first review (`AKRS-Constitution-Review.md`) now that I've also read
> `docs/Appendix to the AKRS Constitution.md`. Same lens: I act as the Leader and
> report what changed, what's still missing, and how I'd struggle.

---

## What the Appendix Fixed

The Appendix is exactly the "generator spec" the Constitution was missing. It directly resolves several of my earlier struggles and **confirms 4 of my 7 assumptions**, so I no longer have to guess them:

- **Source ≠ repository** → now mandated (Source of Truth + Knowledge Priority ladder). My assumption #7 confirmed.
- **Hierarchy** → confirmed by Validation: every Task ∈ one Phase, every Phase ∈ one Plan. Assumption #2 confirmed.
- **Road selection** → "Every Task has exactly one Road; the Leader chooses it; Workers never do." Partially fixes my struggle #3 (generation side).
- **Blind assumptions** → now governed by Confidence (High/Med/Low/Unknown) + Unknown Knowledge Rule + Developer Clarification Rule. This is the strongest addition — it converts "guessing" into "stop and ask." Fixes most of my struggle #4 at generation time.
- **Determinism** → made explicit (what may differ: names/wording; what must not: ownership/routing/structure). This is the whole point and it's now stated.

---

## Updated Clarity Scores

| Dimension | v1 | v2 | Why it moved |
|---|---|---|---|
| Philosophy / intent | 9 | **9** | Unchanged — was already clear. |
| Role separation | 8 | **9** | Leader-chooses-Road + clarification authority. |
| File *purposes* | 8 | **9** | Discovery rules per layer + Output Contract. |
| File *formats* (templates) | 3 | **3** | **Still no schema/template/example.** Unchanged. |
| Navigation runtime | 4 | **5** | Generation-time routing clear; prompt→Task binding still implicit. |
| Validation | 5 | **8** | Now a concrete YES/NO checklist + Failure Conditions. |
| Conflict / source handling | — | **9** | New: Knowledge Priority ladder. Excellent. |
| **Overall, for a model like me** | **6** | **8 / 10** | Manifesto → genuine generator spec. |

**Bottom line:** the pair now reads as *philosophy (Constitution) + procedure (Appendix)*. As a Leader I could now generate workflows that are **architecturally equivalent** across runs — which is the stated goal. What I still cannot guarantee is that they look **textually similar**, because format is undefined.

---

## What Still Blocks Me (residual struggles)

**1. No file templates — the #1 remaining gap.**
The Appendix specifies *responsibilities* but never *shape*. Two Leaders produce equivalent architecture in differently-shaped files. The doc's own Determinism rule allows this ("formatting may differ"), but it hurts tooling and validation.
**Fix:** Add a templates appendix — one filled example per artifact (Router/Memory/Road/Task/Phase/Plan). Examples beat prose for a model.

**2. Ownership is asserted, not machine-checkable.**
"Every concept has one owner" and "no duplicated knowledge" are validation items, but I verify them by reading, not by test. At scale I will miss duplicates.
**Fix:** Require an explicit `owner:` id field per fact so "duplicate ownership" (a named Failure Condition) becomes a mechanical check, not a judgment call.

**3. Runtime resolution still implicit.**
The Appendix is about *generating* the workflow; it's near-silent on *executing* it — how a live prompt + Mode selects the one Task/Road. Constitution draws the flow; neither defines the mechanism.
**Fix:** One section: "prompt + mode → Router → exactly one Road," with the binding rule.

**4. Still no size/cost budget.**
"Tasks small," "minimize files," "smallest correct knowledge" — all unquantified, so "minimal" drifts between runs and contradicts the determinism target.
**Fix:** Give Roads/Tasks a soft cap (files or tokens).

---

## Remaining Assumptions (down from 7 to 3)

1. **Artifacts are Markdown files on disk** — still not stated, only implied by the Constitution's roadmap.
2. **One global Router vs per-Plan Routers** — still unspecified.
3. **AKRS "Memory" ≠ my own session memory** — same word, different concept; still a naming hazard.

---

## Verdict

v1 was **6/10** (great north star, weak spec). With the Appendix, **8/10**: it is now a real, mostly-deterministic generation procedure with proper conflict resolution and a stop-and-ask discipline. To reach **~9.5**, add the three concrete artifacts: **(a) file templates, (b) explicit `owner` ids for machine-checkable validation, (c) a defined runtime prompt→Road resolution step.** All three are mechanical, not philosophical — the hard thinking is already done.

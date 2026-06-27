# AKRS Constitution — Model Self-Review

> Written from the perspective of a model asked to *act as the Leader* and generate an AKRS workflow from `docs/Constitution.md`.
> Objective: report where the spec is clear, where I would struggle, and how to fix it.

---

## My Assumptions

These are the things the Constitution does **not** state but I had to assume to even start:

1. **Artifacts are Markdown files on disk** (the "Today: Markdown workflow" line implies this). No DB, no runtime engine yet.
2. **Hierarchy is**: Plan → Phase → Task → Road, with Memory and Router as cross-cutting index layers. The doc lists these but never draws the containment tree.
3. **One Router is global**, and Memory is a tree of index files pointing to source. Not stated — could also be per-Plan Routers.
4. **"Road" ≈ a per-task manifest** of files to read / not read. I treat it as the concrete output the Worker consumes.
5. **The Leader is a strong model (me); the Worker is a small model.** Mode selection is done by the Leader or a cheap classifier, not by the Worker.
6. **"Memory" here = workflow index files**, which is a *different* thing from my own `~/.claude` memory. The doc reuses the word.
7. **A real codebase exists to analyze.** This repo currently has docs but I assume the target is a normal software project.

---

## Clarity Scores (1 = vague, 10 = executable without guessing)

| Dimension | Score | Reason |
|---|---|---|
| Philosophy / intent | **9** | Crystal clear: shrink decision space, one owner per fact, references over copies. |
| Role separation (Leader/Worker) | **8** | Cleanly split. Minor gap: who runs Mode Selection. |
| File *purposes* (what each layer is) | **8** | Each file's "must contain / must never" lists are strong. |
| File *formats* (concrete structure) | **3** | No schema, no template, no example. I'd invent the syntax. |
| Navigation runtime (how routing executes) | **4** | Flow is drawn, but the mechanism (who reads Router, how a Road is selected) is implicit. |
| Validation (how to *prove* compliance) | **5** | Good checklist, but criteria are subjective ("one owner") with no automated test. |
| **Overall, for a model like me** | **6 / 10** | I can grasp the *intent* perfectly, but I cannot generate two *identical* workflows from it. The philosophy is 9; the executable spec is ~4. |

**Bottom line:** Excellent constitution (the "why"), incomplete specification (the "exactly how"). It is currently a *manifesto*, not yet a *generator spec* — which the doc itself admits ("Draft 2").

---

## Where I Would Struggle (and the Fix)

**1. No file templates → inconsistent output.**
Two Leader runs would produce differently-shaped Memory/Road files.
**Fix:** Add an Appendix with one minimal, filled example of each file type (Router, Memory, Road, Task, Phase, Plan). Examples beat rules for a model.

**2. "One owner per concept" is undecidable at scale.**
I can't reliably prove no knowledge is duplicated across dozens of files by reading alone.
**Fix:** Require each fact to carry an explicit `owner:` id, and let Validation be a mechanical check for duplicate owners — not a judgment call.

**3. Road selection is unspecified.**
The Worker "follows the Road," but how the *right* Road is bound to a prompt is never defined.
**Fix:** State that Mode Selection + Router output a single Road path before the Worker starts. One deterministic resolution step.

**4. The Blind-Assumption escape hatch can loop or under-read.**
"Ask once, then Router → Memory → return" — but if the expanded knowledge is *still* insufficient, the rule forbids re-routing.
**Fix:** Allow exactly one bounded expansion with a hard stop that escalates back to the Leader, rather than silently guessing.

**5. Router vs Memory boundary blurs in practice.**
Both "point toward knowledge." Under pressure I'd leak summaries into the Router.
**Fix:** One line — *Router answers "where", Memory answers "what". Router holds zero prose.* (Already implied; make it a hard rule.)

**6. No size/cost budget.**
"Smallest correct knowledge" has no number, so "small" drifts.
**Fix:** Give Roads a soft cap (e.g. max N files / tokens) so "minimal" is measurable.

---

## Verdict

The Constitution is **strong as a north star and weak as a build spec**. For me to act as a reliable Leader, it needs *three additions*: (a) concrete file templates, (b) machine-checkable validation (explicit `owner` ids), and (c) a defined Road-resolution step. Add those and the overall score moves from **6 → ~9**.

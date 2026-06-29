# AKRS — Implementation Reality Report

**Scope of this report:** Based strictly on three documents — `docs/Constitution.md`, `docs/Appendix to the AKRS Constitution.md`, and `docs/Execution-Contract.md`. Nothing else was read or assumed about the codebase.

**What this is:** An honest account of the assumptions I would be forced to make, the gaps the spec leaves open, and the real obstacles I would hit if I had to actually build this. Not a critique, not perfectionism — just the concrete friction.

---

## 1. What the three documents actually define

- **Constitution** — the *philosophy* and the *architecture*: roles (Leader/Worker), layers (Router → Memory → Road → Task), execution modes (0–4), generation order, validation checklist, and a list of failure conditions.
- **Appendix** — the *generation process*: how a Leader turns a project into a workflow (source priority, generation algorithm, confidence/unknown handling, determinism target).
- **Execution Contract** — the *Worker's guarantees*: stay in scope, atomic changes, validate before expanding, escalate via Router instead of guessing.

Together they describe **a knowledge-routing architecture expressed as Markdown files**, intended to let a strong "Leader" model plan once so cheap "Worker" models can execute many times.

The decisive sentence is in the Constitution's Long-Term Vision: *"Today: Markdown workflow."* So the v1 implementation is **not software** — it is a disciplined file/folder convention plus prompt instructions. That single fact shapes every obstacle below.

---

## 2. Assumptions I had to make to even picture an implementation

These are *not* stated in the documents. I would have to commit to them, and any of them being wrong changes the build.

1. **The "system" is a prompt + file convention, not a program.** There is no executable, no parser, no validator in v1. The Router, Gate, Memory, and Road are Markdown files; the "enforcement" is the agent obeying instructions in its system prompt. (The docs only promise CLI/validation/MCP "Later.")
2. **Agents are LLM agents** (a Leader model, Worker models), driven by something like a coding-agent harness. The docs say "models" but never name a runtime, an API, or how an agent is invoked.
3. **A single repository per workflow.** The structure (Plans → Phases → Tasks → Roads) implies the workflow lives alongside one project. Multi-repo / monorepo behavior is undefined.
4. **Roads reference real file paths** that exist at planning time and stay valid until execution. The whole "Worker reads only the Road" guarantee collapses if files move between planning and execution.
5. **One human Developer** is reachable for clarification (the Appendix's "ask the Developer" escape hatch). If generation runs unattended, that escape hatch is closed.
6. **Markdown is the storage format**, with some machine-readable islands (a dependency/impact structure is implied by "Dependency Memory / impact analysis," but its format is unspecified).
7. **"Execution" means editing code and validating it** (the Execution Contract talks about atomic changes and validating completed work), i.e. this is aimed at software-change tasks, not arbitrary agent work.

If any of these assumptions is wrong, large parts of an implementation would need to be redesigned.

---

## 3. The real gaps — things the spec needs but does not provide

These are the points where, as an implementer, I would be **stuck or guessing**.

### Gap A — No concrete file format or schema
The documents define *responsibilities* ("Router contains routes + references," "Memory contains summaries + references + ownership + relationships") but never a **format**. There is no schema, no required headings, no field names, no example file. Two competent Leaders following the Appendix's "deterministic" mandate could still emit wildly different Markdown. **Determinism is demanded but nothing is specified well enough to produce it.** This is the single biggest gap.

### Gap B — "Mode Selection" has no decision procedure
Modes 0–4 are described by *intent* ("quick local change," "planning," "architecture"), but there is **no algorithm** that maps a prompt to a mode. The Constitution says the mode is "determined from existing task / prompt intent / developer override" — that is a list of inputs, not a rule. Who selects the mode? The Worker? A Leader? A classifier prompt? Undefined. This is load-bearing, because the mode "determines the allowed navigation path."

### Gap C — The Router is described as too dumb to actually route
The Router "never explains anything; it only answers *Where should I go next?*" But a pure pointer with no logic cannot decide *which* pointer applies to a novel prompt — that decision needs matching/classification, which is exactly the "explanation/logic" the Router is forbidden to contain. In practice the routing intelligence has to live *somewhere* (the agent's reasoning, or a Gate). The spec names a Router but pushes the hard part off-page.

### Gap D — The "Blind Assumption Check" is asked once, with no detection mechanism
The Worker asks once: *"Can this task be completed using only the current Road?"* The spec forbids recursive routing and execution reports. But **how does the Worker know the Road is insufficient before it starts executing?** Insufficiency is usually discovered *mid-execution*, not at a single up-front checkpoint. A one-shot pre-flight check is cheap but will miss exactly the cases it exists to catch. There is a real tension between "ask only once / no recursion" (Constitution) and "return to the Router whenever the Road becomes insufficient" (Execution Contract). These two rules are not reconciled.

### Gap E — Nothing keeps the Map in sync with the territory
Memory and Roads are hand-built indexes of the codebase. The moment code changes, every Road/Memory that references it can rot. The Constitution lists "Roads become unreliable" as a *failure condition* but provides **no synchronization mechanism** — only a vague Leader responsibility ("maintaining synchronization") and a "Later: automatic validation." For v1 (Markdown), staleness is unmanaged and is the most likely way the system silently degrades.

### Gap F — No definition of "validate" or who runs it
The Execution Contract requires the Worker to "validate completed work before expanding scope" and the Constitution requires "Validate Workflow." Neither says **what validation is** (tests? typecheck? a checklist? a human?) or **who executes it**. The validation checklists themselves ("every concept has one owner," "no duplicated knowledge") are **human judgment calls** with no automatable definition — yet they gate "workflow complete."

### Gap G — Ownership uniqueness is asserted, not enforceable
"Every concept has exactly one owner" and "no duplicated knowledge" are the architectural heart. But "concept" is never defined, and detecting duplicate knowledge across free-form Markdown is genuinely hard (it is a semantic-dedup problem). Without a tool, this rule is aspirational — a reviewer's gut feeling.

### Gap H — Leader vs. Worker are roles, not a wired system
The documents assume two agent tiers but never specify the **handoff**: how a Worker is launched with the right Road, how it signals completion/escalation back, how the Leader receives an escalation, or what the Leader does with it. The "return to the Router" loop has no defined transport.

### Gap I — Tasks/Phases/Plans boundaries are subjective
"A Task should be executable without redesigning architecture"; "Tasks should remain small." There is no size metric, no boundary rule. Where one Task ends and the next begins is left to Leader taste — which directly undermines the Appendix's determinism guarantee.

---

## 4. The struggles I would actually face building it

Ordered by how much pain they would cause, not by how interesting they are.

1. **Inventing the missing format (Gap A) before writing any logic.** I cannot build a generator, a validator, or even a consistent example without first *deciding* the file schema the documents deliberately left open. That is a design project in itself, and whatever I pick will be "my interpretation," not "the spec."

2. **Building the routing brain the Router is forbidden to be (Gap C).** I would end up putting the real classification logic in the agent's system prompt or a separate Gate file, then explaining to anyone reading the spec why the "dumb Router" needs a smart friend.

3. **Keeping Roads/Memory from rotting (Gap E).** Without sync tooling, the first real code change starts silently invalidating the workflow. I would have to either (a) accept rot and re-generate often, or (b) build the "Later: automatic validation" now — which means building the very tooling the v1 explicitly defers.

4. **Making "deterministic generation" real (Gaps A, I).** The Appendix demands that two Leaders produce equivalent architectures. With no schema and no boundary metrics, I cannot test for equivalence, so I cannot prove (or even measure) the property the spec treats as a success criterion.

5. **Wiring the Leader↔Worker loop and the escalation path (Gaps D, H).** The "ask once, no recursion" rule (Constitution) versus "return to Router whenever insufficient" (Execution Contract) forces a choice the docs don't make for me. Whatever I implement, I am resolving a contradiction on my own authority.

6. **Enforcing scope on a Worker that physically can read anything (Constitution "never scan the whole project").** In a Markdown-only v1, "don't read outside the Road" is an honor-system instruction. There is no sandbox preventing it. Real enforcement needs the "Later: MCP enforcement," i.e. tooling that doesn't exist yet.

7. **Defining "done" (Gap F).** Every layer ends in a validation step I cannot automate from the text. In practice I would substitute a concrete gate (e.g. "typecheck/tests pass"), but that is me adding a fact the spec doesn't state.

---

## 5. Internal tensions worth naming (not critiques — just things that must be resolved)

- **"Ask only once, no recursion"** (Constitution, Blind Assumption Check) **vs. "return to the Router whenever the Road becomes insufficient"** (Execution Contract). One says check once and commit; the other says re-route on demand. An implementer must pick one and live with it.
- **"Determinism is required"** (Appendix) **vs. no schema/metrics provided** (everywhere). The goal is stated; the means to achieve or verify it are not.
- **"Router contains routing only, no logic"** **vs.** routing inherently requiring classification logic. The intelligence is exiled from the layer named for it.
- **"Markdown today"** **vs.** every enforcement guarantee ("never scan," "stay in scope," "no duplication," "validate") needing tooling listed under "Later." The v1 promises behaviors only the future versions can enforce.

---

## 6. What is genuinely solid (so the report is balanced)

- The **core idea is sound and implementable in spirit**: shrink the decision space before reasoning, separate planning from execution, give each piece one owner. These are good principles and you can get value from them *manually* on day one, even without tooling.
- The **layered navigation** (Router → Memory → Road → Task) is a clean mental model and maps naturally onto a folder convention.
- The **escape hatches are healthy**: "mark Unknown, don't fabricate," "ask the Developer," "escalate a tier when unsure." These keep a half-built system from doing damage.
- The **failure conditions are well chosen** — they are exactly the ways such a system rots in practice (routing bigger than execution, Memory becoming a wiki, Roads going stale).

---

## 7. Bottom line

The three documents are a **complete philosophy and a complete process description, but an incomplete specification.** They tell me *what* must be true and *in what order* to build it — they do not tell me the *format, the decision rules, the sync mechanism, or the enforcement*, all of which are exactly the parts that make or break a real implementation.

If I had to build it for real, the honest sequence is:
1. I would first have to **invent the file schema and the mode-selection rule myself** (Gaps A, B) — and from that point on it is "my AKRS," not "the AKRS," because the spec is silent where it matters most.
2. The Markdown-only v1 would **work as a discipline for a human + one strong agent**, but would **not enforce** any of its own guarantees — every "never" in the docs is honor-system until the "Later" tooling exists.
3. The thing most likely to quietly kill it in practice is **staleness** (Gap E): the workflow describes a codebase that keeps moving, with no mechanism to notice when the map stops matching the territory.

None of this means it can't be built. It means the buildable v1 is **smaller and softer** than the documents imply — a convention and a set of prompts — and the hard, valuable guarantees all live in tooling that the spec itself files under "Later."

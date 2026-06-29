# AKRS — Answers to Four Design Questions

**Scope:** Answers derived strictly from `docs/Constitution.md`, `docs/Appendix to the AKRS Constitution.md`, and `docs/Execution-Contract.md`. Where the documents are silent, I say so plainly instead of guessing.

**Short version up front:**
1. **Partly.** The system *strongly biases* the Leader toward asking — but it only *forces* the question when knowledge is Unknown. It does **not** currently mandate an explicit "confirm the source-of-truth files" step. You'd have to add that.
2. **No — and you're right to want on-demand.** Nothing forces all Tasks up front. Mode 3 exists exactly to create Tasks later. But the Appendix's wording *reads* like batch generation, so a Leader will default to mass-producing Tasks unless you tell it not to.
3. **Yes by design, but not automatically.** The architecture is built to absorb change *if* ownership stays single and Tasks stay on-demand. Pre-building all Tasks actively *fights* dynamism. The system makes impact *analysis* easy; it does **not** make the *update* automatic.
4. **Yes, but non-deterministically.** A capable model can produce the workflow files from these docs, but because no file *schema* is given, two runs won't match. To make it reliable you must add one concrete template + a mode rule + the source-of-truth confirmation.

---

## Q1 — Does the system guarantee the Leader asks the Developer about the source-of-truth files (instead of assuming)?

**Answer: It guarantees asking *conditionally*, not *unconditionally*. As written, it does not force an up-front "which files are canonical?" confirmation.**

What the documents *do* require (Appendix):

- **Source of Truth** section: *"The Leader must never assume that the repository alone represents the complete project."* → It must look beyond the repo.
- **Knowledge Priority** ladder: Customer requirements › Developer clarification › Architecture docs › Existing workflow › Repository › Generated assumptions. → Assumptions are the *lowest* authority and *"never override authoritative knowledge."*
- **Unknown Knowledge Rule:** if something can't be determined, *"never fabricate… mark it as Unknown."*
- **Developer Clarification Rule:** *"If Unknown knowledge prevents reliable workflow generation, the Leader must stop and ask the Developer… The Leader must always prefer asking over guessing."*

What the documents *do not* do:

- They never define an explicit, mandatory step: *"At init, ask the Developer to declare which files are the source of truth."* The trigger to ask is **conditional** — it fires only when an Unknown *blocks* reliable generation.
- **Allowed Assumptions** permits assuming *"when sufficient evidence exists and no authoritative source contradicts."* So a Leader that believes it has "sufficient evidence" is *allowed* to proceed on an assumed source of truth **without asking.**

**Consequence for you:** The philosophy leans hard toward asking, but the guarantee you want — *"the Leader must confirm the source-of-truth files with the developer and never assume them"* — is **not explicitly written**. A confident Leader can skip the question. If you want it guaranteed, add it as a **mandatory first gate** in the generation algorithm (e.g. *"Collect Sources → Confirm source-of-truth set with Developer → Analyze"*). Right now it is implied, not enforced.

---

## Q2 — Tasks: must the Developer create them all in the initial work, or can they be on-demand?

**Answer: On-demand is fully compatible with the architecture. The documents do *not* require all Tasks up front — but their phrasing will *default* a Leader to batch creation unless you instruct otherwise.**

Evidence it supports on-demand:

- **Mode 3 — Planning:** *"Creates new tasks. Creates new Roads. Uses planning navigation."* This is the explicit mechanism for creating Tasks **after** the initial pass — i.e. on demand.
- **Constitution philosophy:** *"Knowledge should only be discovered when required,"* and *"Execution always reads the smallest possible amount of information."* On-demand Tasks are the natural expression of this.

Why a Leader will *default* to batch anyway:

- The Appendix's **Generation Algorithm** lists *Generate Tasks → Generate Roads → Validate Workflow → Workflow Complete* as one continuous pass. Read literally, it sounds like "produce the Tasks, then validate, then you're done."
- The **Validation Rules** check *"Every Task belongs to one Phase," "Every Task has one Road"* — which a Leader can misread as *"every conceivable Task must already exist."* (It actually only constrains the Tasks that *do* exist.)

**Consequence for you:** Your instinct is correct and well-aligned with the system's own philosophy. To get on-demand reliably you should make the split explicit:

> **Initial generation produces the stable skeleton** — Plans, Phases, Memory, Router (and the Dependency map).
> **Tasks + Roads are generated per request via Mode 3**, one at a time, when the work is actually needed.

This is not a violation of the spec — it is the spec's philosophy applied honestly. You just have to state it, because the algorithm's wording nudges the other way.

---

## Q3 — Is the system dynamic? Can it absorb mid-project feature changes the customer asks for, and make that *easier* not harder?

**Answer: It is *designed* to absorb change, but it does not absorb it *automatically*. Done right (single ownership + on-demand Tasks) it makes change easy. Done wrong (everything pre-built) it makes change painful. Your decision to avoid pre-building all Tasks is what *keeps* it dynamic.**

What makes it change-friendly:

- **Single ownership / reference-don't-duplicate:** *"Every concept has exactly one owner. Everything else references it."* A change touches one owner; references update by pointing, not by copying. This is the single biggest dynamism advantage.
- **Dependency Memory = impact analysis:** *"what else uses this / shared symbol."* When the customer changes a feature, this answers *"what else breaks?"* — the core question of mid-project change.
- **Mode 3 / Mode 4** exist precisely for change: Mode 3 adds Tasks/Roads; Mode 4 handles *"cross-plan changes."*
- **On-demand Tasks** mean a requirements change invalidates *nothing*, because the affected Tasks weren't built yet.

What makes change *not* automatic (the honest cost):

- **No Map↔Territory sync.** When code/features change, the Memory and Roads that reference the old structure go **stale**. The Constitution lists *"Roads become unreliable"* as a **failure condition**, and assigns *"maintaining synchronization"* to the Leader — but provides **no mechanism**. So every real change requires the Leader to re-run impact analysis and update Memory/Router/Roads **by hand** (until the "Later" tooling exists).
- **Workers can't adapt.** *"The Worker never redesigns the Road."* So a mid-project change can't be handled by the executing Worker — it must **escalate to the Leader**, who re-plans. This is the *correct* separation, but it means change always routes back through planning.

**Consequence for you — this directly validates your Q2 decision:**

> Pre-building all Tasks is *actively harmful* for a changing project. Every pre-built Task and Road becomes a stale artifact the moment the customer changes a requirement — you'd be *maintaining dead files*. On-demand Tasks are the thing that **keeps the system dynamic**.

Net: the system makes the *analysis* of a change easy (one owner + dependency memory). It does **not** make the *update* free — that's manual Leader work today. So "easier, not more complex" is true **only if** you (a) keep Tasks on-demand and (b) accept that each change is a small Mode-3/Mode-4 re-plan, not a Worker improvisation.

---

## Q4 — If we give these files to a model (me / Opus / a "boss" model) and point it at a project's source-of-truth docs, can it actually generate the necessary workflow files?

**Answer: Yes — it can produce a functionally complete workflow. But the output will be *non-deterministic in shape* until you give it one concrete template, because the docs define duties without a file format.**

What works (the model *can* do this):

- The **Generation Algorithm** and **role/layer definitions** give enough process to produce all required artifacts: routing, memory, plans, phases, tasks, roads, validation. The **Workflow Output Contract** even lists exactly what must exist.
- A capable model can analyze a real project + its source docs and emit those files as Markdown, following the priority ladder and the validation checklist.

What will *not* be reliable (the real limit):

- **No file schema (the central gap).** The docs say *what each file is responsible for* but never *what it looks like* — no required headings, field names, or example. The Appendix **demands** determinism (*"the same project should produce substantially equivalent workflows"*) but gives **no means** to achieve it. So:
  - Two runs, or two different models, will produce **structurally different** files that are all "valid AKRS."
  - You get *an* AKRS-flavored workflow, not *the* canonical one.
- **It needs the actual project, not just these 3 docs.** These three files are the *spec for generating*; they contain no project knowledge. The model must be pointed at the real repo + source-of-truth docs to produce anything meaningful.
- **The mode rule is missing (Gap B).** Without a prompt→mode mapping, the model improvises when to plan vs. execute.

**Consequence for you — to make generation reliable, add three things before handing it off:**

1. **One concrete template/example per file type** (a sample Router, Memory, Road, Task, Plan, Phase). This single addition does more than anything else to fix determinism.
2. **A source-of-truth confirmation step** (fixes Q1) — the model asks you which files are canonical before analyzing.
3. **An explicit on-demand instruction** (fixes Q2) — "generate the skeleton now; generate Tasks/Roads per request via Mode 3."

With those three, a model like Opus **can** reliably generate the necessary workflow files for a given project. Without them, it will generate a *plausible but inconsistent* workflow that varies every run.

---

## One-paragraph synthesis

The architecture's philosophy is on your side for everything you're worried about: **ask over assume**, **discover only when required**, **one owner, reference don't duplicate**, **plan once / execute many**. Those principles make *on-demand Tasks* and *mid-project change* the *natural* mode of operation — your instinct in Q2 and Q3 matches the system's own logic. The catch is that the three documents stop at *principles and process*; the parts that would make these guarantees real — a mandatory source-of-truth gate (Q1), an explicit "skeleton now, Tasks on demand" rule (Q2), a sync mechanism for change (Q3), and a file schema/template (Q4) — are **not written down yet**. None of them contradict the spec; all of them are additions you must make for the system to behave the way you intend.

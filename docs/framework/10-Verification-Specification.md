# AKRS Verification Specification (v2)

### When is landed work actually right?

This spec owns one question:

> When is landed work actually *right*?

It exists because AKRS produces exceptional paper and, before verification existed, defined
"Done" **documentarily, not experientially**. In the mirror-test, a game shipped with all 72
tests green, all 10 plans `DONE`, and every artifact internally consistent — while running at
**~0.4 FPS**, with an invisible win state and a HUD that reported "FPS: 10" as frames took
2.6 s. No artifact in AKRS could have caught it, because nothing in the loop was ever required
to look at the **product** instead of the paperwork. This document adds that requirement.

It is authority for verification mechanics; other docs point here and never restate its
content. The commands named here are the shipped ones (`akrs --help`).

---

## 1. Principle — Done is experiential

Paper-vs-paper agreement (Road <-> Memory <-> State) proves **sync**, never **correctness**. It
is necessary and nowhere near sufficient. Therefore:

> **At least one step per Plan must look at the running product.**

There are two separate verification layers, and neither pretends to be the other:

1. **Mechanical** — `akrs verify --road <id>` and `akrs done` run the Road's *declared checks*
   (argv arrays, bounded time and output) and report one result per check. This is not a Tester
   verdict, and because it executes repository-declared commands it is **unsafe on an untrusted
   workflow**: run it only where you trust the Roads.
2. **The Tester lane** — a Plan-level pass against the running product, recorded as structured,
   append-only results (§3). The CLI collects the facts (`akrs test run`); the Tester judges what
   they mean (`akrs test result`).

---

## 2. Granularity — verify the idea, not every Task

Verification attaches to the **idea / Plan level**, never to every Task. Testing every word typed
is exactly the overhead the framework forbids. The Leader sets the level in the Plan's
**verification contract** (`akrs/verifications/<plan>/contract.json`, written only by
`akrs test define`; in the no-Plan tier the contract is keyed by the single Road's ID):

- `policy: none` — developer-observable trivia (a button's shape). **Explicitly legal**: an
  unverified Plan is not a defect when its effect is directly observable by the developer. No
  Tester pass is required (and the other policies all require one).
- `policy: checks` — a Tester pass is required but there is nothing to launch: the Tester
  judges the Roads' acceptance and handoffs and may cite the Roads' declared checks.
- `policy: live` — a Tester pass against the running product is required: a `launch`, a
  `scenario`, at least one **evidence type**, acceptance lines. **This is the default for UI or
  runtime-observable work.**
- `policy: measured` — as `live`, plus at least one **measurement** with a budget (§5).

A `live` or `measured` contract with no evidence type is refused by `test define` and reported by
`validate`, exactly as `test-details` would block it.

**Cadence (the verification diet).** Verification attaches to the right level and no finer:
**asserts per Road** (committed to `tests/`, §9, plus the Road's declared `checks`); the **Mirror
Check per Plan** (the Leader, §4); and a **live Tester pass only for Plans whose contract policy
is `live` or `measured`, plus one final end-to-end pass — never once per Road** (§3; run via the
`akrs-live-verify` skill).

---

## 3. The Tester lane

**The Worker's baton.** When a Road is finished, `akrs done` (or `akrs test handoff`) appends one
record to `akrs/verifications/<plan>/handoff.jsonl`: *result* (what is ready), *reach* (ordered
steps) and *expect* (what to see), with the Road, snapshot and readiness filled by the CLI. A
baton, not a report; it never changes acceptance. The ledger is **append-only and is never
deleted**: a Tester pass does not remove it.

**The Tester's packet.** `akrs test-details <plan>` is a read-only query and returns the one
Plan-level packet the Tester needs: the contract, every Road with its latest handoff, the declared
reads (windows), the pinned product diff, evidence slots, previous failures, runs, the current
result state and every blocker. The packet is pinned to a snapshot and a contract hash. A
missing prerequisite **blocks** (status `blocked`, never a silently partial packet).

**The run.** `akrs test run <plan>` launches the product, waits for readiness, executes the
contract's closed `scenario` (browser and HTTP steps, measurements, screenshots), collects
evidence under `akrs/verifications/<plan>/evidence/<run-id>/`, writes a run record and tears the
process tree down. **Mechanical facts only, never a verdict.** A weak Tester must run it before
recording a result. Contracts run no JavaScript and call only loopback and the contract's
`allowed_hosts`.

**The result.** `akrs test result <plan> --verdict pass|fail|blocked --because "<why>"` appends
one structured record to `results.jsonl`; the CLI fills the snapshot, the contract hash and the
run. A `pass` is refused unless the run is current and passed, every declared measurement is
within budget, every declared evidence type has a file, no finding is open and the acceptance
answer is yes. The Tester **never edits product code** and never deletes a result.

**Stale by itself.** Any relevant change after a pass (a Road, the contract, a declared read, the
product diff) makes it stale; the CLI never carries a pass forward (`akrs stale` names why).

**Closing.** Only `akrs plan finish <plan>` closes a Plan, and it refuses without a current
required pass (see §4–7). The loop's procedure is owned by the `akrs-live-verify` skill.

**A weak point made explicit.** A run records the Tester-lease snapshot and a result records the
tested snapshot of the packet: they are different projections of the same state and differ by
design. A hash is detection, not a signature.

**When the selected tier generates no Plans**, the key is the Road ID and verification attaches to
the Road's own acceptance; nothing is invented to fill the gap.

---

## 4. The Mirror Check (B1)

A **mandatory step at Plan close-out**: the Leader walks the Plan's SoT section and confirms each
bullet is **reachable at runtime**, not merely built or exported. Reachability statements live in
the contract's `reachability` list, so the Tester sees them in the packet.

Mechanical helper (CLI-agnostic): **an exported symbol that no runtime module imports fails the
Plan.** In the mirror-test, `BVH` and `ProgressiveRefiner` were built, exported and unit-tested
but never imported by `main.js` — two of five Performance bullets were dead code, and
`LEVEL_WON` was emitted with zero subscribers.

**Scope note.** Generic CLI enforcement of this is out of scope: a zero-dependency CLI cannot
parse arbitrary project imports across arbitrary languages. The recommendation stands: a
~50-line per-project import-lint, extended per project.

---

## 5. Raw measurement against a budget (B4)

Every live pass includes **>= 1 raw measurement against a budget from the SoT** (for example
wall-clock ms per frame measured externally — **never** the product's own HUD), declared in the
contract's `measurements` (`name`, `unit`, `budget`, `direction`) and taken by a `measure` step
(`lcp`, `load`, `ttfb`) or by the Tester, plus one required sentence:

> *"As a user, is this acceptable? — yes / no because …"*

Instruments shipped by the product under test are **evidence, never verdicts**. In the
mirror-test the loop clamped `dt` at 0.1 s so the FPS counter could never read below 10; the
Worker's live-verify reported "FPS: 10" while its own overlay showed `render: 2600 ms` one line
lower. Models satisfy the criteria they are given; they do not volunteer "this is a slideshow"
unless the policy asks. This section is the policy asking. An over-budget measurement is a legal
`fail` and never a `pass`.

---

## 6. Seam ownership (B2)

Worker scope discipline is the framework's strongest mechanism — and the exact mechanism that
produced the dead code: work a Road defers but names gets wired; work no Road names falls
through silently while every Road passes its own acceptance.

Therefore: the moment a Road ships a **seam** ("X builds it, someone wires it"), the Plan's record
(`akrs/plans/<plan>.json`, `seams`) names **who wires it** — an existing or `QUEUED` Road if one
exists, otherwise the **owning Plan/Phase plus a one-line wiring intent** (Roads are generated on
demand per `02-Generation-Specification.md §4` — a seam must never force pre-generating one).
**A seam with no named owner blocks that Plan's close-out** (`plan finish` names it as
`seam_unowned`; an owner Road that does not exist or is not DONE blocks too). This is the
counterweight to scope discipline — do **not** loosen Worker scope to compensate.

---

## 7. Open questions expire (B3)

Every open question has an **owner Plan** (the Plan record's `questions`). **A Plan cannot close
while it owns an open question** (`plan finish` -> `question_open`): either resolve it, or the
Leader records *"accepted as-is because ___"* and it becomes a **Decision**. "Open forever" is not
a legal state.

In the mirror-test, blown-out lighting was correctly diagnosed and recorded as an open question
during U3 — the workflow's best moment — and then shipped anyway, because "non-blocking" had no
deadline. (The assumption-aging counterpart — escalating an Assumption consumed by >= 3 landed
Roads — is owned by `02-Generation-Specification.md §6`; not restated here.) A Tester `finding`
with status `open` blocks the Plan the same way until it is resolved.

---

## 8. SoT acceptance lines (B5)

Every SoT section carries **>= 1 measurable acceptance line** — the thing the Mirror Check checks
*against*. Without it, "Point lights" ships physically-wrong falloff, "Win condition" ships an
event with no listener, and "performance techniques" ship 2.6 s frames — each SoT-compliant, each
wrong.

Examples: *"≥ 20 FPS at 480×270 on a mid laptop"*, *"win state visible within 1 s"*.

Confirming the acceptance lines **and** the verification harness is a **Phase A structured
question** (harness + budgets are confirmed with the Developer in Phase A, never parked to the
last plan). Index behavior belongs to doc 09: `09-Scale-And-Source-Index-Specification.md §2` may
flag SoT sections missing an acceptance line (09 owns the index; this doc only cites it).

---

## 9. Persistent verification (WS5)

Verification asserts written during execution are **committed to `tests/`** (or the project's
confirmed harness), **never discarded**. The marginal cost is a file save — they are already
written every time work is verified. The Road's `checks` run them at `done`, and the evidence a
Tester run produced stays under `verifications/<plan>/evidence/`.

---

## 10. Tester notes

There is no scratch memory area. A repeated error pattern or a red-flag behavior in Leader or
Worker output is recorded as a Tester `finding` in the result (so the Leader can route a fix and
`plan finish` waits for it), and the Developer is informed. Reusable knowledge that comes out of
it is promoted by the Leader with `akrs memory add`. A Tester-owned diagnosis file never becomes a
permanent store.

---

## 11. Relationship to other documents

- The **Tester role** is defined in `01-Constitution.md §5`; the **Handoff** artifact row is in
  `01 §6`; the close-out validation additions (Mirror Check ran, no unowned seams, no open
  questions owned by a closing Plan) are in `01 §13`.
- The verification contract, the Phase-A acceptance-line + harness question and the Road-level
  `checks` live in `02-Generation-Specification.md §3, §5`.
- The Worker's baton duty and the Plan-level pass hook are in `03-Execution-Contract.md §5–6`.
- Plan-completion close-out points here from `07-State-And-Sync-Specification.md §4`.
- SoT acceptance-line indexing is owned by `09-Scale-And-Source-Index-Specification.md §2`.
- The Kernel carries the compressed Tester role and a pointer to the live-verify skill
  (`08-Kernel-Specification.md`).
- The Tester **loop** is owned by the `akrs-live-verify` skill (`skills/akrs-live-verify.md`);
  this spec and the kernel point to it, never restate it.

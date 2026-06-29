# Case Study — Atlas ERP

A complete walk-through of AKRS on a realistic, high-blast-radius project: a
cloud-native ERP (sales, inventory, manufacturing, finance, HR, …). This is the
"Full" applicability tier — exactly where AKRS is supposed to earn its keep.

> This is a condensed account of an actual test run. Models used: **DeepSeek** as
> Leader, **Gemini Flash** as Worker, **Claude** as reviewer.

---

## 1. The setup

- **Source of Truth:** a single product/requirements document (`app-info.md`)
  describing ~12 business capabilities, the tech stack (ASP.NET Core, React,
  PostgreSQL, Redis, S3, Elasticsearch, Kubernetes), non-functional targets, and
  an explicit list of **Known Unknowns** (billing provider, identity provider,
  etc.).
- **Applicability:** Full — many interconnected capabilities, high blast radius.

---

## 2. Phase A — the skeleton (Leader: DeepSeek)

After confirming the Source of Truth, DeepSeek produced the skeleton **only**:

```
akrs/
├── router.md          12 Plans, their Phases, and cross-plan dependencies
├── STATE.md           initial save-point
└── memory/
    ├── domain-model.md
    ├── technical-stack.md
    ├── non-functional.md
    ├── constraints-and-unknowns.md
    └── existing-codebase.md
```

Notable: the **Known Unknowns** were carried into Memory as `Unknown`, never
invented into facts. The Router stayed pure routing; Memory stayed an index.

Then the **Kernel** was compiled (~1 page), and — once the developer noticed it
was missing — the canonical **`AGENTS.md`** entry file was created.

---

## 3. Phase B — first Task on demand (Leader: DeepSeek)

Requested work: **Registration & Login**. DeepSeek generated exactly one Task and
one Road (`Status: ACTIVE`) with read-order, expected files, and explicit
out-of-scope items (MFA, RBAC, post-registration org joining).

---

## 4. Two requirement changes (Leader: DeepSeek)

| Change | What AKRS did | Blast radius |
|--------|---------------|--------------|
| "Add biometric login" | Updated the single owner (domain model), refreshed the Task + Road, flagged WebAuthn provider as Unknown, updated STATE | Contained to P1 |
| "Drop Google login" | Removed it from its one owner, refreshed the Road's expected files, recorded rationale, confirmed no dependents | Contained to P1 |

Neither change spawned a new Plan or rippled across the project. This is the
drift-resistance the framework is designed for.

---

## 5. Execution — one Road segment (Worker: Gemini Flash)

From a **one-line** request ("implement the JWT middleware for the active Road"),
the cheap Worker:

- self-navigated `AGENTS.md → KERNEL.md → STATE.md → Road`,
- read only what the Road named,
- wrote a minimal, correct JWT middleware (+ the models/controller to exercise
  it),
- stayed strictly in scope.

**Cost: $0.688.** Estimated frontier-model cost for the same task: ~$25–50.

---

## 6. Close-out — drift prevention in action (Worker: Gemini Flash)

When the work landed, Gemini reconciled the workflow:

- `STATE.md` → JWT work moved to *Done* with exact paths; *Next* set.
- Road → stayed `ACTIVE` (work remains); JWT line flipped `Create → Created`.
- Memory → correctly untouched.

Afterwards, **Road, Memory, and code all agreed.** A future session (or a
different tool) could resume purely from `STATE.md` + the Road.

---

## 7. What this case demonstrates

1. **Generation doesn't need a frontier model** — DeepSeek produced a
   rule-compliant workflow.
2. **Execution is cheap and reliable** — Gemini Flash executed correctly from one
   line.
3. **Change is contained** — requirement edits touched one owner + the active
   Road + STATE.
4. **Drift is prevented** — close-out kept every layer in agreement.
5. **The division of labor pays off** — think once (expensive), execute many
   (cheap).

---

## 8. Caveats

- One domain, one applicability tier (Full). Lite/Skip are reasoned about, not
  heavily exercised here.
- Long multi-tool relays across many sessions remain to be stress-tested.
- GPT-family Leader/Worker runs are planned (see [`../../ROADMAP.md`](../../ROADMAP.md)).

---

See the per-model write-ups: [`deepseek.md`](deepseek.md), [`gemini.md`](gemini.md),
[`claude.md`](claude.md).

# Validation — Gemini Flash as Worker

**Role:** Worker (execution + close-out)
**Project:** Atlas ERP (see [`case-study-atlas-erp.md`](case-study-atlas-erp.md))
**Premise:** Gemini Flash is the *cheap* model. This is the decisive test — if a
small model executes reliably from the workflow alone, AKRS works.

---

## The prompt it received

The entire instruction was a work request — **no** guidance about what to read,
no mention of the Kernel, no reminder to close out:

```
Implement the JWT middleware (backend, ASP.NET Core) for the active Road:
- Accept JWT tokens in Authorization header
- Validate token signature
- Extract claims (user, organization)
- Return 401 if invalid
- Keep code minimal
```

The framework — not the prompt — had to supply everything else.

---

## What it did, unaided

1. Booted `AGENTS.md → KERNEL.md` and understood the runtime priority
   (Road → Memory → Router → Repository).
2. Found the active Road from `STATE.md`.
3. Read only the files the Road's read-order named.
4. Implemented the JWT middleware (~110 lines) plus the minimal supporting
   models and controller needed to demonstrate it.
5. Performed **close-out** on its own.

It never asked "what should I read?"

---

## Execution quality

| Check | Result |
|-------|--------|
| Token parsing, signature validation, claim extraction, 401 | ✅ All present |
| Stayed in scope (no MFA, RBAC, password reset, biometric) | ✅ |
| Did not redesign the workflow or wander the repo | ✅ |
| Prepared for future work (WebAuthn fields) without implementing it | ✅ |
| Code minimal, conventional, configuration-driven | ✅ |

---

## Close-out (the part that prevents drift)

- **`STATE.md`** — moved the JWT work into *Done* with exact file paths; set a
  sensible *Next*.
- **Road** — kept `Status: ACTIVE` (work remains) and changed the JWT line from
  `Create` → `Created` with its path; left the rest as `Create`.
- **Memory** — correctly left **unchanged** (implementation detail belongs in
  code, not in the Memory index).

Result: Road, Memory, and the actual code all agreed. **No drift created.**

---

## Cost

| Metric | Value |
|--------|-------|
| Input tokens | ~337k |
| Output tokens | ~15k |
| Total cost | **$0.688** |

A real backend task executed **and** closed out for under a dollar in tokens —
with no loss in correctness or scope discipline.

---

## Verdict

A small, inexpensive model executed a real backend task correctly and reconciled
the workflow afterward — from a one-line prompt. This is the headline result of
the entire project.

---
name: akrs-close-out
description: Run the AKRS Road close-out when work lands — flip the Road status, append the one-line ledger entry to LOG.md, rewrite STATE, reconcile Memory, commit, and validate. Use whenever a Road's assigned work has landed.
---

# akrs-close-out

The single owner of the AKRS close-out **procedure and the ledger-line format**. The specs
(`03-Execution-Contract.md`, `07-State-And-Sync-Specification.md`) own only the *invariants*
and point here; the kernel's close-out line points here too. Do not restate these steps
anywhere else.

Run this the moment a Road's assigned work has landed. It is a **ledger** close-out: one line,
not an essay. The Road already carries scope + expected files + acceptance; Memory carries the
contracts; the handoff carries how-to-verify. Do not re-tell any of them here.

## Steps (in order)

1. **Flip the Road status.** In the active Road, set `Status: DONE + superseded by <memory>`
   (name the Memory that now owns the truth). If the work stays live under this Road rather
   than retiring, instead refresh its *Expected files* / scope to match what actually shipped.
2. **Append ONE ledger line to `akrs/LOG.md`** (append-only, newest at the bottom), in this
   exact format:

   ```
   <YYYY-MM-DD> · <ROAD-ID> · <DONE|BLOCKED> · model=<name> effort=<low|med|high> tokens=<n>k tools=<n> wall=~<n>min
   ```

   Example:

   ```
   2026-07-05 · R07c · DONE · model=sonnet-5 effort=med tokens=135k tools=58 wall=~20min
   ```

   Add a **second `deviations:` line ONLY when reality diverged from the Road** — the one
   piece of knowledge with no other home (what the Road assumed → what actually shipped, one
   clause):

   ```
   deviations: Road named Camera.setFov → the real owner was Controls.setFov
   ```

   No narrative. Keep the ledger line at or under ~40 words (the `deviations:` line is
   exempt). Never rewrite an existing ledger line; never read `LOG.md` at boot.
3. **Rewrite `STATE.md` ≤ 1 page.** Move the landed objective into *Done* (keep only the last
   3), set the single most-obvious *Next*, refresh the timestamp + author. STATE is rewritten
   fresh, never appended.
4. **Update the owning Memory only if a contract changed** (a reusable fact changed owner or
   location). If nothing reusable moved, touch no Memory.
5. **One commit.** One Road = one commit (or branch/PR); message `<ROAD-ID>: <summary>`.
6. **Validate.** Run `npm run validate` (or `npx akrs-framework validate`). Green = the Road,
   STATE, the kernel, and the ephemeral artifacts are all consistent.

## Leader plan-pass verdict

When the Leader closes a **Plan** (not a Road), the plan-pass entry is **one verdict line**,
no narrative:

```
Mirror Check: PASS · <n>/<n> asserts · <one metric>
```

## Invariants this procedure must never break

- Close-out touches **at most** LOG + STATE + the Road + one Memory + one FEATURES line.
- The Road is the record of *what was built*; the ledger is the record of *cost + chronology*;
  neither re-tells the other.
- A Road still `ACTIVE` after its work landed, or whose Expected files no longer match
  reality, is a drift defect this close-out exists to prevent.

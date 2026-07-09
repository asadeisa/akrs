---
name: akrs-live-verify
description: Verify an AKRS Plan against the RUNNING product — launch it, drive it in a real browser, take at least one raw external measurement against a Source-of-Truth budget, and answer "as a user, is this acceptable?". Use at Plan-level verification, not per Task.
---

# akrs-live-verify

The single owner of the AKRS live-verification **rig and the Test-Handoff template**. Spec
`10-Verification-Specification.md` owns only the *invariants* (Done is experiential, instruments
are evidence-never-verdicts, one measurement per pass, delete-handoff-on-pass) and points here.
Do not restate the rig steps anywhere else.

This procedure is **plain, platform-neutral**: any model on any platform can run it. Shell
steps are concrete runnable commands; browser automation is described by **capability** — drive
the running page in a real browser (a Playwright-style browser driver, or whatever browser
automation your platform provides). Never depend on a vendor-specific tool id.

## Fill-in slots (the generating Leader completes these at Phase A)

- **Launch command:** `<how to start the product, e.g. npm run dev>`
- **URL / port:** `<e.g. http://localhost:5173>`
- **Evidence goes to:** `<where measurements/screenshots are recorded, e.g. akrs/verify/evidence/>`
- **SoT budgets:** `<the measurable acceptance lines from the SoT, e.g. ≥ 20 FPS at 480×270; win state visible within 1 s>`

## Cadence (when this runs — not every Task)

- Asserts are written **per Road** and committed to `tests/`.
- The **Mirror Check** runs **per Plan** (the Leader; `10 §4`).
- This live-browser pass runs **only for Plans that touched DOM/CSS**, **plus one final
  end-to-end pass** — never once per Road.

## Steps

1. **Read the handoff.** Consume `akrs/verify/<plan>-handoff.md` (the baton the Worker left).
   Verify the **idea**, against the **running product**, never the paperwork. Never edit
   product code.
2. **Launch.** Run the launch command; open the URL/port; reach the observable state the
   handoff names.
3. **Take ≥ 1 raw measurement against a SoT budget** — measured **externally** (e.g. wall-clock
   ms per frame, real request latency), **never** the product's own HUD/overlay. Instruments
   the product ships are **evidence, never verdicts**: a model satisfies the criteria it is
   given, so measure the thing the SoT budgeted, not the thing the product reports about
   itself. Record the raw number where the evidence slot says.
4. **Confirm reachability (Mirror Check support).** Each SoT bullet for this Plan must be
   reachable at runtime, not merely built or exported — an exported symbol nothing imports
   fails the Plan.
5. **Answer the required sentence**, out loud, in the findings:

   > As a user, is this acceptable? — **yes / no because ___**

6. **Verdict.**
   - **Pass →** delete the handoff (`akrs/verify/<plan>-handoff.md`); the named deleter is the
     Tester.
   - **Bug →** write findings (the handoff **stays**), escalate to the Leader to route a fix,
     re-test after the fix lands.

## Test-Handoff template (the Worker writes this during execution; ≤ 1 page)

`akrs/verify/<plan>-handoff.md` — short, append-only notes; a baton, not a report. Hard cap:
**one page (~350 words)** — *what became observable / how to reach it / what should happen*.
Flag it `(ready)` when the Plan's idea is runnable.

```markdown
# handoff: <plan>   (ready)
- Observable: <what a user can now see/do, and where>
- Reach it: <exact steps / route / settings to get there>
- Expected: <the acceptance behavior, tied to the SoT budget>
```

## Tester memory

`akrs/memory/tester/` does not exist at start. Create a topic file **only** on a *repeated*
error pattern or a red-flag behavior, inform the developer, and **delete it once the problem is
fixed**. It is a diagnosis scratchpad, never a permanent store.

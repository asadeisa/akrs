---
name: akrs-close-out
description: Close out an AKRS Road when its work has landed — one `akrs done` call for the Worker, or the Leader's `road finish` and ledger commands — then re-render STATE, reconcile Memory, commit, and validate. Use whenever a Road's assigned work has landed.
---

# akrs-close-out

The single owner of the AKRS close-out **procedure**. The specs (`03-Execution-Contract.md`,
`07-State-And-Sync-Specification.md`) own only the *invariants* and point here; the kernel's
close-out line points here too. Do not restate these steps anywhere else.

Close-out is **one command, not an essay**. The Road already carries scope, checks and
acceptance; Memory carries the contracts; the handoff carries how to verify. Every file the
close-out writes is **canonical JSON/JSONL written by the CLI** — never edit one by hand (a
hand-edited file is reported as unverified and `validate` fails).

## Worker: `done` (the normal path)

1. **Land the work** inside the Road's declared `writes`. Do not edit anything else.
2. **Run `akrs done <road>`** with the baton for the Tester:

   ```
   akrs done <road> --result "<what is ready>" --reach "<step to reach it>" --expect "<what to see>"
   ```

   Repeat `--reach` for every step. For longer text, write a file inside the project and pass it
   with `--handoff <file>` (do not mix the file with the flat flags). Add `--deviations "<text>"`
   **only** when reality diverged from the Road (what the Road assumed -> what shipped, one
   clause). Add `--pre-existing <path>` for a file that was already dirty before you started.
3. `done` runs the Road's declared checks and the git audit, then — in **one** transaction —
   records the handoff, marks the Road `DONE`, writes the closure record and releases your lease.
   If anything fails **nothing** is finished: the packet lists every blocker with its fix. Fix
   it and run `done` again. After the number of refusals your class allows, the packet offers
   `yield` (the Road is too big): run `akrs yield <road> --reason "<why>"`.
4. Stop. A Worker has no further close-out step. Its next step is `akrs next --executor <id>`
   or `akrs work`.

The CLI fills the Road, snapshot and readiness of the handoff. Never type a hash, snapshot or
request ID.

## Leader: after the Road is DONE

Run these only when you are the Leader (or when the Road was finished without `done`):

1. **Finish a Road you closed yourself** with `akrs road finish <road>` (it runs the declared
   checks and the audit, writes the closure and releases the lease). A Road already finished by
   `done` needs nothing here.
2. **Record a closure the CLI did not write** (a Plan, or a deliberate BLOCKED) with
   `akrs log append --kind road|plan --subject <id> --outcome DONE|BLOCKED [--deviations "<text>"]`.
   The ledger is append-only (`akrs/log/NNNN.jsonl`, rotated by the CLI): never rewrite a line.
   **No telemetry** — the ledger records when something closed and how it ended, never model,
   effort, tokens or time.
3. **Re-render the save-point:** `akrs state render` (derived `STATE.md`). Change the
   Leader-owned fields only with `akrs state set` (`--phase`, `--task`, `--next`, ...).
4. **Update Memory only if a reusable fact changed owner or location:** write a draft
   (`akrs template memory --to-draft <name>`) and run `akrs memory add --input akrs/drafts/<name>.json`.
   If nothing reusable moved, touch no Memory.
5. **One commit.** One Road = one commit (or branch/PR); message `<ROAD-ID>: <summary>`.
6. **Validate:** `akrs validate`. Green = the Roads, State, ledger, Memory and verification
   records all agree. Fix a finding with the command `akrs explain <code>` names — never by
   hand-editing a canonical file.

## Plan close-out (Leader)

A Plan does not close on its Roads alone. Run the Tester loop (`akrs-live-verify`), the Mirror
Check (`10-Verification-Specification.md`), then `akrs plan finish <plan>` (use `--dry-run`
first: it names every blocker). The Plan's entry in `akrs/FEATURES.md` is the one Leader-written
line that completes it.

## Invariants this procedure must never break

- Close-out touches **at most** the Road, the ledger, STATE, one Memory and one FEATURES line,
  and all but the last two are written by the CLI.
- The Road is the record of *what was built*; the ledger is the record of *chronology*; neither
  re-tells the other.
- A Road still `ACTIVE` after its work landed is a drift defect this close-out exists to
  prevent.

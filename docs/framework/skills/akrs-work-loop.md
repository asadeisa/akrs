---
name: akrs-work-loop
description: Execute one AKRS Road as the Worker — `akrs work` to claim the Road and get the exact packet, edit only inside the declared writes, `akrs done` to finish with the Tester baton, `akrs yield` when the Road is too big. Use whenever you are told to implement the active Road.
---

# akrs-work-loop

The single owner of the Worker's **work -> done** loop. The Execution Contract
(`03-Execution-Contract.md`) owns the invariants (stay in scope, never redesign, never invent
knowledge) and points here. Do not restate these steps anywhere else.

The happy path is **two AKRS calls**: `akrs work`, then `akrs done`. You never boot the
framework, never read the Leader's files and never type a hash, snapshot or request ID.

## 1. Claim: `akrs work [<road>] [--executor <id>]`

- Run it with no argument to take the next ACTIVE ready Road of your class, or name the Road.
  Your executor ID comes from `--executor`, then `AKRS_EXECUTOR`, then the only Worker
  executor; if several exist the packet lists the choices — pick yours.
- It claims a lease on the Road and returns the **Worker packet**, shaped for your class:
  the task, the reads (windows inlined for a weak class), the allowed writes, the forbidden
  paths, boundaries, acceptance, the declared checks, ordered steps and what "done" means.
  Repeating `work` on your own lease just refreshes it.
- Another executor's lease is reported with its holder. Do **not** use `--takeover` unless the
  Leader told you to.
- `work` never activates a Road. Activation is the Leader's (`akrs road activate`).

## 2. Edit

- Read **only** what the packet lists (read windows, not whole files). If the packet is not
  enough, do not guess and do not scan the repository: use `akrs-scope-request`.
- Write **only** the declared `writes`; never a `forbidden` path and never anything under the
  workflow folder (`akrs/**`) except drafts. Where your agent supports pre-write hooks,
  `akrs guard` denies an out-of-scope write at edit time; elsewhere `done` audits the change set
  afterwards, so an undeclared change blocks the finish either way.
- Follow the ordered `steps` for a weak class. Keep changes atomic, and commit the asserts you
  write along the way to `tests/` (or the confirmed harness).
- Optionally check yourself with `akrs verify --road <id>`. It is mechanical: it runs the Road's
  declared checks, which are repository-declared commands, so run it only in a workflow you
  trust. `done` runs them anyway.

## 3. Finish: `akrs done <road>`

```
akrs done <road> --result "<what is ready>" --reach "<step to reach it>" --expect "<what to see>"
```

Repeat `--reach` per step, or pass `--handoff <file>` with `{ "result": "...", "reach": ["..."],
"expect": "..." }` (a file inside the project, not mixed with the flat flags). Optional:
`--deviations "<text>"` only when reality diverged from the Road, `--pre-existing <path>` for
files that were dirty before you started. The close-out detail is owned by `akrs-close-out`.

If `done` refuses, nothing was finished: the packet lists each blocker with its fix (a failing
declared check, an undeclared change, a pending blocking scope request, a changed contract).
Fix the cause and run `done` again. A changed contract returns the delta and the fresh packet:
run `akrs work` to refresh your lease.

## 4. Too big: `akrs yield <road> --reason "<why>"`

When `done` has refused as many times as your class allows (the packet offers `yield`), or you
can see the Road is too big for you, give it back: `akrs yield <road> --reason "<why it is too
big>"`. It releases your lease, marks the Road as needing a split and raises a question for the
Leader. Do not keep struggling, and do not split the Road yourself.

## 5. Stop

After `done` (or `yield`) you are finished with that Road. Your next step is
`akrs next --executor <id>` or the next `akrs work`. `akrs state render`, `road finish`, `log
append`, `scope approve` and `plan finish` are the Leader's; never run them.

## Output channels

Structured text goes in a file inside the project (drafts live in `akrs/drafts/`), passed with
`--input` or `--handoff`. Prefer that to quoting JSON in a shell, which breaks on Windows
PowerShell. `--json` prints one packet for a program; `--prompt` prints it for you.

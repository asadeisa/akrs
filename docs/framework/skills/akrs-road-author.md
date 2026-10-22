---
name: akrs-road-author
description: Author and change a Road as the Leader — draft from `akrs template`, create or replace it with `road new` / `road update` (or a closed `--patch`), check class fit, activate it, and define the Plan's verification contract. Use whenever the Leader creates or edits a Road, Task or contract.
---

# akrs-road-author

The single owner of the Leader's **authoring loop**. The Generation Specification
(`02-Generation-Specification.md`) owns what a Road *is* and the granularity rules; this skill
owns how to write one. The rule behind every step: **content comes from you, form comes from the
CLI** — you write a draft with your file tool, the CLI validates, normalizes, hashes and writes
the canonical file. Never hand-edit `akrs/roads/**`, `state.json`, `executors.json`, the ledger
or a contract: a hand-edited file is reported as unverified.

## 0. Before the first Road

Executors must be classified (`akrs-classify-executors`) and `akrs validate` must have no
`AKRS-S006`. The quickest start is `akrs init --scaffold [--plan <id>]`, which writes one valid
Road, Task, State and contract in a single transaction; then replace the Road's content.

## 1. Draft from the template

```
akrs template road --class weak --to-draft r2        # writes akrs/drafts/r2.json
```

`--class` pre-sets `executor_class` and the shape for that class; the `guide` in the packet
explains every field. Fill the draft with your file tool. Write it **inside the project**
(`akrs/drafts/` is the convention): `--input` refuses a path outside the repository, and
`akrs/drafts/` is excluded from snapshots and the git audit. Other kinds: `task`, `verification`,
`memory`, `scope`, `handoff`, `result`.

Field rules that trip authors:

- `forbidden` is a **list of plain path/glob strings**, not objects. `writes` entries are
  `{ "path", "class": "file|dir|glob|ephemeral", "action": "create|modify|delete" }`.
- `reads` entries are `{ "path", "lines": null | [start, end], "why": string | null }` — a
  **window**, never a whole large file. Order is kept.
- `checks` are `{ "name", "argv": ["program", "arg", ...], "timeout_ms" }` — an argv array,
  never a shell string; a weak class needs at least one.
- `executor_class` is required before the Road can be activated (`AKRS-R025`: no class, no
  executor known to fit). Set it to the class of the executor that will run it.
- `steps` (ordered, small) are required for a weak class and are the **single owner** of
  executable steps; the Task's *approach* points to them.
- `scope_policy` is the envelope for `akrs-scope-request`; leave it empty unless you mean it.
- `complexity` (0–10) is advisory; nothing gates on it.
- A weak or medium Leader cannot use `oversize_reason`.

## 2. Create or replace

- **New Road:** `akrs road new --input akrs/drafts/r2.json`. On success the draft is removed
  and both paths are listed in `changed`. On failure the draft stays and each finding carries a
  JSON pointer.
- **Narrative Task:** `akrs template task --to-draft t2`, then `akrs task new --input
  akrs/drafts/t2.json` (objective, constraints, approach, notes; it restates nothing from its
  Road).
- **Replace a Road:** the input is the **complete** Road *including* `status` (copy the current
  value; only lifecycle commands change it). Replacement is guarded by a snapshot:

  ```
  akrs road update R2 --input akrs/drafts/r2.json --reason "<why>" --dry-run   # prints the exact change
  akrs road update R2 --input akrs/drafts/r2.json --reason "<why>" --if-snapshot <snapshot.before from the dry run>
  ```

  Snapshots are **command-scoped**: take `snapshot.before` from that command's own `--dry-run`
  (or from the `next_commands` of `akrs road check`); one taken from another command is stale.
  Removing a check, read or write needs `--reason`. Never type a snapshot from memory.
- **Small change:** `akrs road update <id> --patch --input akrs/drafts/p.json` with
  `{ "schema": "akrs.road-patch/v1", "ops": [ ... ] }`. Closed operations: `add_read`,
  `remove_read`, `add_write`, `remove_write`, `add_check`, `remove_check`,
  `replace_acceptance`, `replace_boundaries`, `replace_steps`; every `remove_*` carries a
  `reason`. A patch expands to the full object and takes the identical validation path.
- **Move a Road to another Plan:** `akrs road move <id> --plan <id>` reports; add `--apply` to
  do it.
- `--input` also accepts `--json -` (stdin), but on Windows PowerShell 5.1 stdin mangles
  non-ASCII text: prefer a file.

## 3. Fit, readiness, activation

1. `akrs road fit <id>` — load against the class profile: `fits`, `split_required` or
   `reads_over_budget`, with deterministic split suggestions (`--write-drafts` saves them as
   drafts). Split before you activate, not after a Worker yields.
2. `akrs road check <id>` — readiness (dependencies DONE, class and executor, checks) and the
   legal transitions; it prints the snapshot the next command needs.
3. `akrs road activate <id> --if-snapshot <snapshot>` — makes the Road dispatchable. A Road
   whose dependencies are not DONE cannot activate. Activation is yours; `akrs work` only
   claims a lease.
4. `road reopen <id>` returns an ACTIVE or DONE Road to QUEUED; `lease release <road>` frees a
   Worker's claim. Both are Leader commands.

## 4. The Plan's verification contract

`akrs template verification --to-draft c`, fill it (`policy`: `none` | `checks` | `live` |
`measured`; a `live` or `measured` policy also needs a `launch`, at least one **evidence type**
and a `scenario`; `measured` needs at least one measurement), then `akrs test define <plan>
--input akrs/drafts/c.json`. Replacing an existing contract needs `--if-snapshot` from the
command's `--dry-run`. Scenario `http` steps take `headers` as an **array** of
`{ "name", "value" }` objects. The scenario vocabulary is closed (`goto`, `click`, `fill`,
`press`, `wait_for`, `expect_text`, `expect_no_console_errors`, `http`, `screenshot`, `measure`,
`viewport`); a contract can never run JavaScript.

## 5. After every authoring step

`akrs validate` (must stay green), then `akrs state render` — `STATE.md` is derived output and
reports `AKRS-S008` until it is re-rendered after a change. A draft left behind by a failed
command is reported (`AKRS-C017`); fix and re-run it, or delete the draft. Set the Leader-owned
fields with `akrs state set` (`--phase`, `--task`, `--next`, ...); without a `--next` note STATE
derives its Next line from the workflow itself.

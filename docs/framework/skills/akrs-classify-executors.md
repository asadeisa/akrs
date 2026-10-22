---
name: akrs-classify-executors
description: Ask the user which models execute the work and how strong each is, then record the answer with `akrs executor set` — the Leader's "classify the executor" question flow. Use before decomposing a Plan or creating the first Road, and whenever `akrs boot` returns a classify_executors question.
---

# akrs-classify-executors

The single owner of the Leader's **classify-the-executor** flow. Spec
`04-Developer-Interaction-Protocol.md` owns the interaction rules (one structured question,
recommended first) and points here.

**Classification is a user decision.** The CLI never infers capability from a model name — not
every "flash" model is weak, not every large model is frontier. Road size and packet shape
follow the class, so a wrong guess means a Road that is too big for a weak model or a packet
that wastes a strong one. Ask; do not assume.

## When

- `akrs boot` returned a `classify_executors` entry in `questions_for_user`;
- `akrs validate` reports `AKRS-S006` (a usable `executors.json` with at least one leader and
  one worker is missing), or a Road's class has no matching executor;
- before you create the first Road of a workflow, or when the user changes a model.

## The flow (one structured question per turn)

1. **Ask the Worker/Tester question** as a structured question (2–4 options, recommended first,
   one decision per turn):

   > Which model(s) will execute this work as Worker and as Tester, and how do you classify
   > each: weak, medium, or frontier?

   Options to offer, recommended first: *weak (cheap, needs small steps)* · *medium* ·
   *frontier (strong, can take a larger Road)*. Ask for the model's name or label. If the user
   runs several Workers, ask once per model.
2. **Ask for your own class** the same way (you are the Leader); record it too.
3. **Record each answer verbatim:**

   ```
   akrs executor set <id> --role leader|worker|tester --class weak|medium|frontier --label "<model via tool>" --answer "<the user's own words>"
   ```

   `<id>` is a short stable ID the executor will use (`--executor <id>` or `AKRS_EXECUTOR`).
   `--answer` keeps the evidence of what the user said; never write a class the user did not
   give. One call per executor. `akrs executor list` shows the result and the effective class
   profiles; `executor remove <id>` removes one.
4. **Tune only if the user asks:** `--override <class>.<knob>=<n>` (knobs: `max_writes`,
   `max_write_dirs`, `read_budget_tokens`, `done_failures_before_yield`, `envelope_grant_cap`)
   and `--clear-override`. The shipped defaults stand otherwise.
5. **Re-run** `akrs validate`; `AKRS-S006` must be gone. A workflow needs at least one leader and
   one worker (the Tester is declared when a Plan is tested).

## What the class changes

| Knob | weak | medium | frontier |
|---|---:|---:|---:|
| `writes` per Road | 3 | 8 | 20 |
| write path classes | `file` | file, dir, glob | file, dir, glob |
| distinct write directories | 1 | 3 | 6 |
| declared read budget (tokens) | 6 000 | 16 000 | 60 000 |
| reads in the packet | windows inlined | inlined within budget | pointers |
| `steps` | required | optional | optional |
| a declared `check` | required | required | recommended |
| envelope auto-grant | reads only | reads + file writes | reads + file writes |
| `done` refusals before `yield` is offered | 2 | 3 | 4 |

A weak or medium **Leader** cannot use `oversize_reason`; `akrs road fit` then writes split
suggestions as drafts. A weak **Tester** must run `akrs test run` before `akrs test result`.
Author a Road for its executor's class (`executor_class`, `akrs-road-author`); `akrs road fit
<id>` reports `fits`, `split_required` or `reads_over_budget`.

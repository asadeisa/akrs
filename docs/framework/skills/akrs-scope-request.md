---
name: akrs-scope-request
description: Ask for more scope when the Road is not enough (Worker) and decide the request (Leader) — `akrs scope request`, the Leader-authored scope envelope that grants safe requests automatically, and `scope approve|reject|list`. Use when a Worker needs a read or write the Road does not declare.
---

# akrs-scope-request

The single owner of **scope expansion**. The Execution Contract (`03-Execution-Contract.md`)
owns the invariant — a Worker never expands scope by guessing — and points here.

A scope request **asks**; it never grants. Only a Leader Road update changes what a Road may
read or write — either the Leader resolving the request, or the CLI applying the Road's own
Leader-authored **envelope** under fixed rules.

## Worker: ask

1. **Stop editing outside the Road.** Decide what is missing: extra `reads` and/or `writes`.
2. **Get the skeleton:** `akrs template scope --to-draft <name>` writes `akrs/drafts/<name>.json`.
3. **Fill it** with your normal file tool — no shell JSON:

   ```json
   {
     "schema": "akrs.scope-request/v1",
     "road": "R-P6-1",
     "add_reads": [{ "path": "SOT/02-rules.md", "lines": [2, 4], "why": "the flag is defined here" }],
     "add_writes": [{ "path": "src/flags.js", "class": "file", "action": "modify" }],
     "reason": "why the declared scope is not enough",
     "blocking": true
   }
   ```

   At least one of `add_reads` / `add_writes`; entries have the same shape as a Road's.
   `blocking: true` when you cannot continue without the answer, `false` when you can go on
   with what you have.
4. **Send it:** `akrs scope request --input akrs/drafts/<name>.json`. The packet says whether
   the envelope **granted** it immediately (the Road is updated; run `akrs work` to refresh
   your lease and continue) or left it **pending**.
5. **Pending and blocking:** stop and report to the Leader. `akrs done` refuses while a
   blocking request is pending. **Pending and non-blocking:** continue within the old scope.
6. Check where it stands with `akrs scope list <road>`.

If the work cannot be done even with more scope, the Road is too big: `akrs yield`
(`akrs-work-loop`). A genuinely stuck agent never guesses forward and never creates a blocking
flag file; the scope request, `yield` and a `blocked` Tester result are the escalation records.

## Leader: author the envelope (optional)

The Road's `scope_policy` is a Leader-authored envelope: `{ "auto_reads": [...], "auto_writes":
[...] }` (paths and globs). A request is granted at once, as a recorded guarded Road update
marked `granted_by: "envelope"`, only when **all** of these hold:

- every requested write is a concrete `file`-class path inside `auto_writes`, and every
  requested read is inside `auto_reads`;
- nothing is under the Road's `forbidden`;
- the grant creates no collision with another ACTIVE Road and exceeds no class cap or read
  budget;
- the Road has not used up its envelope-grant cap (default 3);
- the Road's class allows it: a **weak** class auto-grants reads only, medium and frontier
  reads and file writes.

The writer rejects an envelope that contains `akrs/**`, `SOT/**` or a bare `**`. Keep the
envelope narrow; an empty envelope (the default) means every request waits for you.

## Leader: decide

- `akrs scope list <road>` — pending, approved and rejected requests (omit the Road for all).
- `akrs scope approve <road|request-id> [--reason "<why>"]` — builds the full replacement Road
  from the request and runs the normal guarded update. The Road form works when that Road has
  exactly one pending request; otherwise pass the request ID.
- `akrs scope reject <road|request-id> --reason "<why>"` — nothing is granted; say why so the
  Worker can proceed or yield.
- A request that reveals a design problem is a signal to split the Road
  (`akrs road fit <id>`), not to keep widening it.

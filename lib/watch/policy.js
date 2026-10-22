// P2-W17: the frozen decisions of `watch --jsonl [--since <op>]`. Documentation and closed vocabularies that the tests pin down; the
// rest of lib/watch implements them. Decisions beyond the plan text are marked (decision).
const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
};

export const WATCH_SCHEMA = 'akrs.watch/v1';
export const WATCH_EVENT_KINDS = Object.freeze({ started: 'watch_started', op: 'watch_op', change: 'watch_change' });
export const WATCH_ENDINGS = Object.freeze(['duration', 'max_events', 'signal']);
export const WATCH_DEFAULTS = Object.freeze({ debounce_ms: 150, poll_ms: 1000 });
export const WATCH_LIMITS = Object.freeze({ debounce_ms: [1, 60_000], poll_ms: [1, 600_000], max_events: [1, 1_000_000], duration_ms: [1, 86_400_000] });
// the workflow-relative prefixes whose changes never reach the stream (the snapshot engine excludes the same paths)
export const WATCH_NOISE_PREFIXES = Object.freeze(['.cache/', 'drafts/']);

export const WATCH_POLICY = deepFreeze({
  source: 'The stream is driven by two sources and nothing else: the operation journal (<workflow>/.ops/journal/ops/*.jsonl, committed operations) and the workflow files (the snapshot inventory of the WORKFLOW projection, so a Road, Plan, Task, verification, scope, state, memory, log or executors change). fs.watch on the workflow folder wakes the engine; a timer poll is the safety net for a platform that loses events.',
  events: 'Events use the frozen akrs.event/v1 envelope with the existing types. `started` (kind watch_started) opens the stream with the resume cursor and the baseline workflow snapshot. `progress` carries either kind watch_op (one committed journal operation: op = its request ID, command, road and plan targets, committed time, changed files, before and after snapshots) or kind watch_change (the workflow snapshot moved: before, after and the sorted paths whose content changed, appeared or disappeared). The one terminal `complete` event carries the final akrs.packet/v2 packet.',
  order: 'Within one wake-up the operations come first (committed time, then record ID), then at most one watch_change. A committed operation also moves workflow files, so a change event accompanies it; when a scan runs between the file writes and the journal commit the change event arrives first and the operation event in a later scan (a consumer matches them by the paths in `changed`, never by arrival order). A hand edit appears as a change event alone. Sequence numbers are contiguous from 1.',
  debounce: 'A wake-up is debounced: every file event restarts a quiet window of debounce_ms (default 150) and the scan runs when it ends, but no later than 5 windows after the first event of a burst, so a steady writer cannot starve the stream. Bursts therefore give one scan and one watch_change. The timer poll (poll_ms, default 1000) triggers the same scan.',
  noise: 'Drafts (<workflow>/drafts), the cache (<workflow>/.cache), evidence folders and CLI scratch (.ops other than the journal) never produce an event: they are excluded from the snapshot and the file-event filter ignores them, so a scan they cause finds nothing new and emits nothing.',
  resume: '(decision) The op ID is the request ID of a committed journal operation. `--since <op>` first replays every committed operation after it (in committed order), then follows live; the final packet and the started event carry the cursor (the newest operation seen) to resume from. Without --since the stream starts at now: no backlog, cursor = the newest operation that already exists. An unknown op (never recorded, or pruned by the journal retention) is a usage error that names the fix (run without --since).',
  baseline: 'A change event reports the difference between two consecutive workflow snapshots; the first scan compares with the snapshot taken when the stream started, so changes made before `started` are never reported and changes after it are never lost.',
  ending: '(decision) The stream ends when the caller aborts (SIGINT, SIGTERM or SIGHUP in the CLI; an AbortSignal in the core), when --max-events events (operations plus changes, not counting started) were emitted, or when --duration-ms elapsed. It always ends with one last scan on abort (so nothing committed just before the signal is lost), closes the file watcher, clears every timer and emits the one complete event. Exit code 0. Without --jsonl the same run prints only the final packet, so a bound (--max-events or --duration-ms) is required there.',
  query: 'watch is a query: it reads the journal and the workflow files and writes nothing, takes no lock and claims no lease. A journal that does not verify stops the stream with the journal error; a torn last line is ignored like everywhere else.',
});

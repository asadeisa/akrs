// P2-W09: the frozen decisions of the navigation queries (status, next, where, graph, stale, log) and the extended doctor.
// Documentation and closed vocabularies that the tests pin down; the rest of lib/store/navigation implements them. Decisions
// beyond the packet text are marked (decision).
const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
};

export const STATUS_SCHEMA = 'akrs.status/v1';
export const NEXT_SCHEMA = 'akrs.next/v1';
export const WHERE_SCHEMA = 'akrs.where/v1';
export const GRAPH_SCHEMA = 'akrs.graph/v1';
export const STALE_SCHEMA = 'akrs.stale/v1';
export const LOG_SCHEMA = 'akrs.log/v1';

export const WHERE_RELATIONS = Object.freeze(['closures', 'readers', 'scope_requests', 'writers']);
export const GRAPH_NODE_TYPES = Object.freeze(['plan', 'road', 'task', 'verification']);
export const GRAPH_EDGE_TYPES = Object.freeze(['block', 'collision', 'dep', 'touch']);
export const NEXT_ACTION_KINDS = Object.freeze(['activate', 'close_plan', 'decide_scope', 'finish_road', 'inspect', 'run_tests', 'work']);
export const STALE_ITEM_KINDS = Object.freeze(['plan_lease', 'result', 'road_lease', 'run', 'state_render']);
export const MATCHES = Object.freeze(['exact', 'overlap', 'unknown']);
export const HEALTH_CHECKS = Object.freeze(['doctrine', 'executors', 'log', 'roads', 'state', 'workflow']);
export const HEALTH_STATUSES = Object.freeze(['error', 'not_applicable', 'ok', 'warning']);
export const LOG_LIMIT_MAX = 10_000;

export const NAVIGATION_POLICY = deepFreeze({
  compose: 'Every query composes the projections that already exist (Road files and their leader packet, Plan files, verification contracts, the Tester packet and its current-result projection, leases, scope ledgers, executors, the closure ledger, state.json). Nothing is rebuilt from prose; a source that does not verify is counted and named, never silently dropped. No query writes: not a lease, not a cache, not the journal.',
  order: 'Everything is sorted by code point of the ID (never by locale or file order) so the same workflow gives byte-identical data on every platform: Roads, Plans and executors by ID, leases by kind then target, items by kind then subject, edges by type then from then to.',
  status: '(decision) `status` is one packet: Roads by status with the ready and blocked QUEUED ones and the Roads that need splitting (class-fit blockers named), per-Plan Road counts, Tester state (unverified, ready_for_test, testing, failed, passed, stale; not_required for the none policy) and closure, the executors with their classes, every Road and Plan lease with its holder and fresh or stale state, pending scope requests and envelope grants, and the closure ledger. state.json is shown as written when it verifies. `status --all-projects` belongs to P2-W17.',
  closed_plan: '(decision) A Plan whose Plan file says closed is reported with the proof it was closed on: closing rewrites the Plan file, which the Tester packet snapshot measures, so the live projection would show the pass as stale. For a closed Plan the Tester state is passed when its latest recorded result is a pass, otherwise the live projection; `closure` is read first by every consumer.',
  next: '(decision) `next` returns only legal actions, each with a manifest command and arguments that run as they are, in this order: pending scope requests (a Leader decision), ready QUEUED Roads to activate, ACTIVE Roads to work (no lease) or to finish (a fresh lease), then the Tester loop of every Plan whose Roads are all DONE: run the scenario or inspect the packet, close a Plan with a current pass (plan finish --dry-run names the snapshot). A QUEUED Road that is not ready is blocked with its readiness blockers and never offered. An empty answer is explicit: empty.reason is nothing_to_do or blocked. `--executor <id>` keeps only what that executor can take (Road class and role); an unknown executor is a usage error.',
  where: '(decision) `where <path>` has four deterministic relations and no others, labelled provisional: writers (Roads that declare a write over the path), readers (Roads whose declared reads cover it), scope_requests (requests that name it) and closures (closure records of the Roads and Plans that touch it). A match is exact (the same pattern), overlap (the glob patterns provably intersect) or unknown (the overlap cannot be decided, which is reported, never dropped). No file content is read and no similarity is guessed.',
  graph: '(decision) `graph [--touches <path>]` is the one akrs.graph/v1 schema. Nodes: plan, road, task, verification (P2-W17 extends the set). Edges: dep (a Road to what it depends on), block (an unfinished dependency to the Road it blocks), touch (a Plan to its Roads and to its verification, a Road to its Task), collision (two unfinished Roads whose declared writes overlap, with certainty overlap or unknown). Attributes: status, class, lease, needs_split. `--touches` returns the subgraph of the Roads that touch the path plus their neighbours, in the same schema, without dangling edges.',
  stale: '(decision) `stale` names what is no longer current and the exact inputs that invalidated it: Road and Plan leases (the added, changed and removed inputs of the lease projection), Tester passes (a changed tested snapshot or contract hash; a result records no per-input inventory, so its inputs are null and are not guessed), run records that are not for the current state, and a STATE.md that differs from the render of the canonical inputs. Nothing is refreshed.',
  log: '(decision) `log` lists the closure ledger in ledger order, segment by segment, newest last; --kind, --subject and --limit (the newest entries, still chronological) narrow it. A record whose hash does not verify is shown with verified false and never repaired or dropped; the segments are never written.',
  doctor: '(decision) `doctor` keeps its git posture and adds one health row per check, sorted: doctrine (the docs/akrs install record), executors, log, roads, state, workflow. A row is ok, warning, error or not_applicable (nothing to check yet is not a defect). Any warning or error row makes the packet a warning (a row is a fact with its detail, not a catalogued finding, so no new finding code is added); the git posture finding is kept. doctor never repairs.',
  reuse_scan: '(decision) `reuse-scan` is not retained in this packet: the plan marks it optional, it is opt-in only and never part of validation, and no packet owns a need for it. It stays out of the manifest (no placeholder entry); nothing else depends on it.',
});

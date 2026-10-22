// The STATE.md renderer: a pure function of the canonical state and the derived inputs. It reads nothing and never
// parses a previous STATE.md.
import { compareStrings } from '../../schemas/common.js';
import { STATE_DONE_LIMIT } from './policy.js';

const lines = (text) => text.split(/\r\n|\r|\n/);
const quote = (text) => (text === null ? ['-'] : lines(text).map((line) => (line === '' ? '>' : `> ${line}`)));
const dash = (value) => (value === null || value === undefined ? '-' : String(value));

function readyRoads(roads) {
  const done = new Set(roads.filter(({ status }) => status === 'DONE').map(({ id }) => id));
  return roads.filter(({ status, deps }) => status === 'QUEUED' && deps.every((dependency) => done.has(dependency)));
}

function blockers({ closures, pending }) {
  const closed = new Set(closures.filter(({ outcome }) => outcome === 'DONE').map(({ kind, subject }) => `${kind}:${subject}`));
  const seen = new Set();
  const out = [];
  for (const { kind, subject, outcome } of closures) {
    const key = `${kind}:${subject}`;
    if (outcome !== 'BLOCKED' || closed.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(`- ${kind} ${subject}: closed BLOCKED in the ledger`);
  }
  for (const { road, id } of pending.filter(({ blocking }) => blocking).sort((a, b) => compareStrings(a.road, b.road) || compareStrings(a.id, b.id))) {
    out.push(`- road ${road}: waiting for a scope decision (request ${id})`);
  }
  return out;
}

// The Next section when the Leader wrote no `next` note: derived from the workflow itself, so it can never be a frozen instruction
// that stopped being true (the scaffold used to store one). An explicit `next` in state.json always wins. Pure: it reads only `derived`.
export function derivedNext({ roads, closures, pending, plans }) {
  const blocking = pending.filter(({ blocking: isBlocking }) => isBlocking).sort((a, b) => compareStrings(a.road, b.road) || compareStrings(a.id, b.id));
  if (blocking.length > 0) return `Decide the blocking scope request on Road ${blocking[0].road} (akrs scope list ${blocking[0].road}).`;
  const active = roads.filter(({ status }) => status === 'ACTIVE');
  if (active.length > 0) return `Road ${active.map(({ id }) => id).join(', ')} ${active.length === 1 ? 'is' : 'are'} ACTIVE: the executor runs work, then done.`;
  const ready = readyRoads(roads);
  if (ready.length > 0) return `Activate Road ${ready[0].id} (akrs road activate ${ready[0].id}).`;
  if (roads.length === 0) return null;
  const closedPlans = new Set(closures.filter(({ kind, outcome }) => kind === 'plan' && outcome === 'DONE').map(({ subject }) => subject));
  const open = plans.filter(({ key }) => !closedPlans.has(key));
  if (open.length > 0 && roads.every(({ status }) => status === 'DONE')) {
    return `Every Road is DONE: the Tester runs akrs test-details ${open[0].key}, then the Leader closes the Plan (akrs plan finish ${open[0].key}).`;
  }
  return null;
}

// state: the stored state.json object; derived: the result of deriveState.
export function renderStateMarkdown({ state, derived }) {
  const { roads, closures, pending, plans, untrusted } = derived;
  const out = [];
  const section = (title, body) => out.push('', `## ${title}`, ...(body.length === 0 ? ['-'] : body));

  out.push('# STATE', `Updated: ${state.updated.at} by ${state.updated.by}`);
  section('Active', [
    `- Mode: ${state.mode}`,
    `- Role: ${state.role}`,
    `- Plan: ${dash(state.plan)}`,
    `- Task: ${dash(state.task)}`,
    ...roads.filter(({ status }) => status === 'ACTIVE').map(({ id, plan }) => `- Road: ${id} (plan ${dash(plan)}, ACTIVE)`),
  ]);
  section('Phase', quote(state.phase));
  section('Done (last 3 closures; full history in akrs/log)', closures.filter(({ outcome }) => outcome === 'DONE').slice(-STATE_DONE_LIMIT).reverse().map(({ kind, subject, ts }) => `- ${kind} ${subject} DONE (${ts})`));
  section('Next', quote(state.next ?? derivedNext(derived)));
  section('Ready', readyRoads(roads).map(({ id, plan }) => `- ${id} (plan ${dash(plan)})`));
  section('Blockers', blockers({ closures, pending }));
  section('Scope requests', pending.map(({ road, id, blocking }) => `- ${road}: ${id} (${blocking ? 'blocking' : 'non-blocking'}, pending)`));
  section('Verification', plans.map(({ key, policy, contract, handoffs, ready }) => `- ${key}: ${contract ? `contract ${dash(policy)}` : 'no contract'}, ${handoffs} handoff(s)${ready === null ? '' : `, last ready=${ready}`}`));
  if (untrusted.roads + untrusted.closures + untrusted.sources > 0) {
    section('Not trusted', [`- left out: ${untrusted.roads} Road(s), ${untrusted.closures} closure record(s) that do not verify; ${untrusted.sources} source issue(s)`]);
  }
  return `${out.join('\n')}\n`;
}

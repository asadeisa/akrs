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
  section('Next', quote(state.next));
  section('Ready', readyRoads(roads).map(({ id, plan }) => `- ${id} (plan ${dash(plan)})`));
  section('Blockers', blockers({ closures, pending }));
  section('Scope requests', pending.map(({ road, id, blocking }) => `- ${road}: ${id} (${blocking ? 'blocking' : 'non-blocking'}, pending)`));
  section('Verification', plans.map(({ key, policy, contract, handoffs, ready }) => `- ${key}: ${contract ? `contract ${dash(policy)}` : 'no contract'}, ${handoffs} handoff(s)${ready === null ? '' : `, last ready=${ready}`}`));
  if (untrusted.roads + untrusted.closures + untrusted.sources > 0) {
    section('Not trusted', [`- left out: ${untrusted.roads} Road(s), ${untrusted.closures} closure record(s) that do not verify; ${untrusted.sources} source issue(s)`]);
  }
  return `${out.join('\n')}\n`;
}

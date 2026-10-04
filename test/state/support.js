// Shared helpers for the P1-W11 State tests. Seeding uses the canonical codec and the finished writers of earlier
// packets only for their own artifacts (closures through the codec, Roads through seedRoad), never the writers under test.
import { renderState, setState } from '../../lib/store/state/index.js';
import { appendClosure } from '../../lib/store/log/index.js';
import { everything, providersOf, request, snapshotOf, strict } from '../change/support.js';
import { authoringOptions, createRepo, runCommand, seedPlan, seedRoad, treeDigest, ulid } from '../road/support.js';

export { createRepo, everything, request, runCommand, seedPlan, seedRoad, snapshotOf, strict, treeDigest, ulid };

const opts = (repo, extra) => authoringOptions(repo, { providers: providersOf(repo), ...extra });
export const set = (repo, changes, extra = {}) => setState({ ...opts(repo, extra), changes, clear: extra.clear ?? [] });
export const render = (repo, extra = {}) => renderState(opts(repo, extra));
export const closeOut = (repo, document) => appendClosure({
  ...opts(repo), document: { deviations: null, ...document },
});
export const stateJson = async (repo) => JSON.parse(await repo.read('akrs/state.json'));
export const stateMd = (repo) => repo.read('akrs/STATE.md');
export const reasons = (packet) => packet.findings.filter(({ code }) => code === 'AKRS-S004').map(({ detail }) => detail.reason);

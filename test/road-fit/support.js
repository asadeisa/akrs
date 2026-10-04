// Shared helpers for the P1-W15 executor-class tests. Roads are seeded through the canonical codec; the executor file
// goes through the writer under test only in the writer tests.
import { createRoad } from '../../lib/store/roads/index.js';
import { removeExecutor, setExecutor } from '../../lib/store/executors/index.js';
import { everything, providersOf, strict } from '../change/support.js';
import { authoringOptions, createRepo, roadInput, runCommand, seedPlan, seedRoad, treeDigest, ulid } from '../road/support.js';

export { createRepo, everything, roadInput, runCommand, seedPlan, seedRoad, strict, treeDigest, ulid };

const opts = (repo, extra) => authoringOptions(repo, { providers: providersOf(repo), ...extra });
const stdin = (document) => ({ stdin: Buffer.from(JSON.stringify(document)) });

export const lead = { id: 'lead', role: 'leader', class: 'frontier', label: 'Opus via Claude Code', user_answer: 'frontier' };
export const flash = { id: 'flash', role: 'worker', class: 'weak', label: 'DeepSeek Flash', user_answer: 'weak — cheap, needs small steps' };

export const setExec = (repo, executor, extra = {}) => setExecutor({ ...opts(repo, extra), executor, setOverrides: extra.setOverrides ?? [], clearOverrides: extra.clearOverrides ?? [] });
export const removeExec = (repo, id, extra = {}) => removeExecutor({ ...opts(repo, extra), id });
export const newRoad = (repo, document, extra = {}) => createRoad({ ...opts(repo, extra), channel: stdin(document) });
export const executorsFile = async (repo) => JSON.parse(await repo.read('akrs/executors.json'));

const writes = (count, { dirs = 1, kind = 'file' } = {}) => Array.from({ length: count }, (_, index) => ({
  path: `src/d${index % dirs}/f${index}.js`, class: kind, action: 'create',
}));
export const bigRoad = (overrides = {}) => roadInput({ plan: null, task: null, id: 'R-BIG', writes: writes(4), ...overrides });
export { writes };

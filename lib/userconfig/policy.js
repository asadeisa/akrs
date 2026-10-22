// F21 (P2-W17, A1 section 8): the user-config root and the projects registry. Documentation and closed vocabularies that the tests pin
// down; the rest of lib/userconfig implements them. Decisions beyond the plan text are marked (decision).
const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
};

export const CONFIG_HOME_ENV = 'AKRS_CONFIG_HOME';
export const CONFIG_DIRECTORY = 'akrs';
export const REGISTRY_FILE = 'projects.json';
export const REGISTRY_SCHEMA = 'akrs.projects/v1';
export const REGISTRY_KEYS = Object.freeze(['schema', 'projects']);
export const PROJECT_KEYS = Object.freeze(['root', 'workflow', 'name', 'added_at']);
export const CONFIG_SOURCES = Object.freeze(['AKRS_CONFIG_HOME', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'home']);
export const MAX_PROJECTS = 500;
export const MAX_NAME_LENGTH = 80;
export const REGISTRY_MAX_BYTES = 256 * 1024;
export const DEFAULT_WORKFLOW = 'akrs';
// the files and folders any one of which makes a workflow folder an AKRS workflow
export const WORKFLOW_MARKERS = Object.freeze(['executors.json', 'plans', 'roads', 'state.json', 'tasks', 'verifications']);
// why a root is not a usable project (finding AKRS-C022 `reason`)
export const PROJECT_REASONS = Object.freeze(['missing', 'not_a_directory', 'not_akrs', 'registry_full', 'registry_invalid', 'unsafe']);
// the state of one registered project in `status --all-projects` (finding AKRS-C023 `reason`)
export const PROJECT_STATES = Object.freeze(['missing', 'not_a_directory', 'not_akrs', 'ok', 'unreadable']);
export const PROJECTS_FINDING_CODES = Object.freeze({ rejected: 'AKRS-C022', unreadable: 'AKRS-C023' });
export const PROJECTS_LOCK_COMMANDS = Object.freeze(['projects-add', 'projects-remove']);

export const USER_CONFIG_POLICY = deepFreeze({
  root: 'The user-config root is the one directory AKRS owns outside every repository, and it is a second validated root used only by the projects registry (Lock 13 amendment). AKRS_CONFIG_HOME names it directly when set and non-empty (it must be an absolute path; a relative or NUL-carrying value is a usage error, never guessed). Otherwise Windows uses %LOCALAPPDATA%\akrs (an unset or relative LOCALAPPDATA falls back to <home>\AppData\Local\akrs), and every other platform uses $XDG_CONFIG_HOME/akrs when that is an absolute path (a relative XDG_CONFIG_HOME is ignored, as the XDG specification says) and ~/.config/akrs otherwise.',
  injection: 'The environment, the platform and the home directory are inputs of the resolver (never read from process behind its back), so every test points AKRS_CONFIG_HOME at a temporary directory and the real user profile is never read or written by a test.',
  registry: 'One file, <root>/projects.json, a closed akrs.projects/v1 document { schema, projects[] } written through the canonical JSON codec (two-space indent, LF, one final newline). A project is the closed object { root, workflow, name, added_at }: root is the normalized absolute repository root (forward slashes, drive letter kept, no trailing slash, no . or .. segment), workflow is the repository-relative workflow folder (default akrs), name is a single-line label (default: the last segment of the root, at most 80 characters) and added_at is the add timestamp. Projects are listed in code point order of root; a root is listed once.',
  lock: 'The registry has its own lock, never the repository lock of a project: <root>/.ops/lock, the same lock protocol (owner record, stale-owner proof, wait budget) taken with lockRoot. Every read-modify-write of projects.json happens while it is held; a lock that cannot be taken in time answers blocked with AKRS-C009.',
  writes: 'The registry is replaced as a whole: the new bytes go to a temporary file in the same directory (fsync), which is renamed over projects.json. A reader therefore sees the old or the new file, never a torn one. A leftover temporary file is garbage, never read. A dry run takes no lock and writes nothing, not even the config folder.',
  validation: '(decision) A root is added only when it exists, is a directory and holds a workflow folder that is a directory carrying at least one AKRS marker (executors.json, plans, roads, state.json, tasks or verifications); otherwise nothing is written and the answer is finding AKRS-C022 with the reason missing, not_a_directory, not_akrs or unsafe (a workflow folder that resolves outside its repository). The stored root is the real path of the directory, so one project reached through two paths is listed once. An unreadable or invalid registry is never overwritten: every command answers AKRS-C022 with reason registry_invalid and the pointer of the first problem.',
  remove: 'Removing a project deletes its registry entry and nothing else: the repository is never opened for writing, and a root that no longer exists can still be removed. A project is named by its stored root, by the path that resolves to it, or by its name when that is unambiguous.',
  projects_read: '`status --all-projects` reads the registered roots read-only through the same query projections as `status`: it takes no lock, writes no cache, lease or journal record in any project, and a project that is missing, not an AKRS workflow or unreadable is reported (AKRS-C023 warning) and skipped, never repaired or removed.',
  scope: 'Only the registry may live in the user-config root. No project data, cache or log is copied there, and nothing in a registered project is ever written because it is registered.',
  snapshot: 'The packet snapshot of the projects commands is the sha256 of the registry bytes (the empty snapshot when the file is absent), so a caller can tell whether the registry moved.',
});

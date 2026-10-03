import { FINDING_SEVERITIES, compareStrings } from '../schemas/common.js';
import {
  isPlainObject,
  issue,
  validateClosedObject,
  validateJsonValue,
  validationResult,
} from '../schemas/validation.js';

export const FINDING_CODE_FAMILIES = Object.freeze({
  R: 'road',
  M: 'memory',
  S: 'state',
  G: 'git',
  C: 'command',
  T: 'tester',
});

export const FINDING_CATALOG_KEYS = Object.freeze([
  'code',
  'category',
  'severity',
  'rationale',
  'data_schema',
  'remediation',
]);

function objectSchema(properties, required = Object.keys(properties)) {
  return {
    type: 'object',
    required,
    properties,
    additionalProperties: false,
  };
}

const string = { type: 'string' };
const stringArray = { type: 'array', items: { type: 'string' } };

const definitions = [
  {
    code: 'AKRS-C001',
    category: 'command',
    severity: 'error',
    rationale: 'The command line does not match the closed command manifest.',
    data_schema: objectSchema({ reason: string }),
    remediation: 'Correct the command or arguments shown by manifest-backed help and retry.',
  },
  {
    code: 'AKRS-C003',
    category: 'command',
    severity: 'error',
    rationale: 'The selected workflow root does not exist or is not readable as a directory.',
    data_schema: objectSchema({ reason: string }),
    remediation: 'Select an existing workflow with --workflow-root or create one with init.',
  },
  {
    code: 'AKRS-C004',
    category: 'command',
    severity: 'error',
    rationale: 'The command or renderer failed outside a declared product outcome.',
    data_schema: objectSchema({ reason: string }),
    remediation: 'Inspect the diagnostic reason, preserve the input, and report the internal failure.',
  },
  {
    code: 'AKRS-C005',
    category: 'command',
    severity: 'warning',
    rationale: 'A validation check stopped before it could complete its declared coverage.',
    data_schema: objectSchema({ check: string, error: string }),
    remediation: 'Restore readable input or fix the check failure, then run validation again.',
  },
  {
    code: 'AKRS-C006',
    category: 'command',
    severity: 'warning',
    rationale: 'A declared path differs in case from the filesystem entry and would behave differently across hosts.',
    data_schema: objectSchema({ actual_path: string, expected_path: string }),
    remediation: 'Change the declared path to exactly match the filesystem entry case.',
  },
  {
    code: 'AKRS-C007',
    category: 'command',
    severity: 'warning',
    rationale: 'An installed doctrine file was preserved because it was edited locally, was never installed by AKRS, or sits where the doctrine cannot be written safely.',
    data_schema: objectSchema({ path: string, reason: string, other_path: string }, ['path', 'reason']),
    remediation: 'Review the file. A v1 install has no ownership record, so AKRS cannot tell your edits from older packaged text and reports unowned_differs for every file that differs; sync keeps them. Options: keep the local file (it is reported again on each sync and never overwritten), delete it and run sync to restore the packaged copy, or run init --force, which replaces all of docs/akrs and discards every local edit there. For case_collision, rename or remove one of the two spellings named in the finding.',
  },
  {
    code: 'AKRS-R001',
    category: 'road',
    severity: 'error',
    rationale: 'Duplicate Road identities make dependency lookup ambiguous and lossy.',
    data_schema: objectSchema({ road_id: string, conflicting_files: stringArray }),
    remediation: 'Assign a unique Road identity to every Road before resolving references.',
  },
  {
    code: 'AKRS-R002',
    category: 'road',
    severity: 'error',
    rationale: 'A legacy Road has no readable Status line.',
    data_schema: objectSchema({ road_id: string }),
    remediation: 'Add an explicit legal Road status.',
  },
  {
    code: 'AKRS-R003',
    category: 'road',
    severity: 'error',
    rationale: 'A legacy Road status is outside the characterized lifecycle vocabulary.',
    data_schema: objectSchema({ road_id: string, status: string }),
    remediation: 'Use QUEUED, ACTIVE, or DONE superseded by <memory> for the legacy Road.',
  },
  {
    code: 'AKRS-R004',
    category: 'road',
    severity: 'warning',
    rationale: 'Required Expected files input was unreadable by the retained legacy parser.',
    data_schema: objectSchema({ road_id: string, parser: string }),
    remediation: 'Treat the check as skipped; do not infer success from zero parsed inputs.',
  },
  {
    code: 'AKRS-R005',
    category: 'road',
    severity: 'error',
    rationale: 'A Road dependency names no registered Road identity.',
    data_schema: objectSchema({ road_id: string, dependency: string, status: string }),
    remediation: 'Correct the dependency identity or add the missing Road.',
  },
  {
    code: 'AKRS-R006',
    category: 'road',
    severity: 'error',
    rationale: 'The Road dependency graph contains a cycle and cannot define an execution order.',
    data_schema: objectSchema({ cycle: stringArray }),
    remediation: 'Remove or redirect at least one dependency edge in the reported cycle.',
  },
  {
    code: 'AKRS-R007',
    category: 'road',
    severity: 'error',
    rationale: 'An ACTIVE Road depends on a Road that is not DONE.',
    data_schema: objectSchema({ road_id: string, dependency: string, dependency_status: string }),
    remediation: 'Finish the dependency or return the dependent Road to QUEUED.',
  },
  {
    code: 'AKRS-R008',
    category: 'road',
    severity: 'warning',
    rationale: 'An ACTIVE legacy Road names an Expected path that is not present.',
    data_schema: objectSchema({ road_id: string, expected_path: string, status: string }),
    remediation: 'Create the declared path or correct the legacy Road declaration.',
  },
  {
    code: 'AKRS-R009',
    category: 'road',
    severity: 'error',
    rationale: 'A DONE legacy Road names an Expected path that is no longer present.',
    data_schema: objectSchema({ road_id: string, expected_path: string, status: string }),
    remediation: 'Restore the path or explicitly retire and supersede the stale Road contract.',
  },
  {
    code: 'AKRS-R010',
    category: 'road',
    severity: 'error',
    rationale: 'A legacy Road declares an unsafe Expected path that cannot be resolved inside the repository.',
    data_schema: objectSchema({ road_id: string, expected_path: string, reason: string }),
    remediation: 'Replace the declaration with a normalized repository-relative contained path.',
  },
];

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export function validateFindingCatalog(value) {
  const issues = [];
  if (!Array.isArray(value) || value.length === 0) {
    issue(issues, '$', 'invalid_type', 'must be a non-empty array');
    return validationResult(issues);
  }

  const codes = new Set();
  value.forEach((entry, index) => {
    const path = `$[${index}]`;
    if (!validateClosedObject(entry, FINDING_CATALOG_KEYS, path, issues)) return;
    const match = typeof entry.code === 'string' && entry.code.match(/^AKRS-([RMSGCT])[0-9]{3}$/);
    if (!match) {
      issue(issues, `${path}.code`, 'invalid_format', 'must use a reserved AKRS finding family');
    } else {
      if (codes.has(entry.code)) issue(issues, `${path}.code`, 'duplicate_value', 'code must be unique');
      codes.add(entry.code);
      if (entry.category !== FINDING_CODE_FAMILIES[match[1]]) {
        issue(issues, `${path}.category`, 'invalid_value', 'category must match the code family');
      }
    }
    if (!FINDING_SEVERITIES.includes(entry.severity)) {
      issue(issues, `${path}.severity`, 'invalid_value', 'must be info, warning, or error');
    }
    for (const key of ['rationale', 'remediation']) {
      if (typeof entry[key] !== 'string' || entry[key].length === 0) {
        issue(issues, `${path}.${key}`, 'invalid_type', 'must be a non-empty string');
      }
    }
    if (!isPlainObject(entry.data_schema)) {
      issue(issues, `${path}.data_schema`, 'invalid_type', 'must be an object');
    } else {
      validateJsonValue(entry.data_schema, `${path}.data_schema`, issues);
    }
  });

  const ordered = value.map(({ code }) => code);
  if (ordered.some((code, index) => index > 0 && compareStrings(ordered[index - 1], code) >= 0)) {
    issue(issues, '$', 'invalid_order', 'catalog codes must be sorted and unique');
  }
  return validationResult(issues);
}

definitions.sort((left, right) => compareStrings(left.code, right.code));
const validation = validateFindingCatalog(definitions);
if (!validation.ok) throw new TypeError(`finding catalog failed validation: ${JSON.stringify(validation.issues)}`);

export const findingCatalog = deepFreeze(definitions);
const catalogByCode = new Map(findingCatalog.map((entry) => [entry.code, entry]));

export function getFindingDefinition(code) {
  return catalogByCode.get(code) ?? null;
}

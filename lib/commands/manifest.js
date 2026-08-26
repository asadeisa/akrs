import { validateCommandManifest } from '../schemas/command-manifest.js';
import { ContractValidationError } from '../schemas/validation.js';

const manifest = {
  schema_version: 'akrs.command-manifest/v1',
  commands: [],
};

const result = validateCommandManifest(manifest);
if (!result.ok) throw new ContractValidationError('command manifest', result.issues);

export const commandManifest = Object.freeze({
  schema_version: manifest.schema_version,
  commands: Object.freeze([]),
});

export const nextCommandBuilders = Object.freeze({
  none: () => [],
});

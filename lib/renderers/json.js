import { validatePacket } from '../schemas/packet.js';
import { ContractValidationError } from '../schemas/validation.js';

export function renderJson(packet, { knownCommands } = {}) {
  const result = validatePacket(packet, { knownCommands });
  if (!result.ok) throw new ContractValidationError('packet', result.issues);
  return `${JSON.stringify(packet, null, 2)}\n`;
}

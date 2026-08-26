import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(value, length) {
  let remaining = BigInt(value);
  let output = '';
  for (let index = 0; index < length; index += 1) {
    output = ENCODING[Number(remaining & 31n)] + output;
    remaining >>= 5n;
  }
  return output;
}

export function createRunId(timestamp = new Date(), entropy = randomBytes(10)) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.valueOf())) throw new TypeError('timestamp must be a valid date');
  if (!(entropy instanceof Uint8Array) || entropy.length !== 10) {
    throw new TypeError('entropy must contain exactly 10 bytes');
  }

  let randomValue = 0n;
  for (const byte of entropy) randomValue = (randomValue << 8n) | BigInt(byte);
  return `${encodeBase32(date.valueOf(), 10)}${encodeBase32(randomValue, 16)}`;
}

export function createDefaultProviders({ clock = () => new Date(), entropy = randomBytes } = {}) {
  return {
    now() {
      const value = clock();
      return (value instanceof Date ? value : new Date(value)).toISOString();
    },
    runId() {
      return createRunId(clock(), entropy(10));
    },
  };
}

// The deterministic read-token estimator (policy.estimator): integer quarter-token units per code point.
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿\u{20000}-\u{2fa1f}]/u;

export function estimateTokens(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  let units = 0;
  for (const character of text) {
    if (character.codePointAt(0) < 0x80) units += 1;
    else units += CJK.test(character) ? 4 : 2;
  }
  return Math.ceil(units / 4);
}

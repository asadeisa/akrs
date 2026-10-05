// Path matching shared by `where` and `graph --touches`: a declared pattern against a path or another pattern, decided by the
// glob engine, never guessed. -> 'exact' | 'overlap' | 'unknown' | null (provably disjoint)
import { pathOverlap } from '../../schemas/glob.js';
import { patternOf } from '../road-details/relations.js';

export function matchOf(declared, pathClass, query, queryClass = null) {
  const left = patternOf(declared, pathClass);
  const right = patternOf(query, queryClass);
  if (left === right) return 'exact';
  const state = pathOverlap(left, right);
  if (state === 'disjoint') return null;
  return state === 'overlap' ? 'overlap' : 'unknown';
}

const RANK = { exact: 0, overlap: 1, unknown: 2 };
export const strongest = (matches) => matches.filter((entry) => entry !== null).sort((left, right) => RANK[left] - RANK[right])[0] ?? null;

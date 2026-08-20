import test from 'node:test';
import assert from 'node:assert/strict';
import { selectListings } from '../src/normalize.js';

test('filters area, deduplicates representative groups, and keeps three cheapest per supply area', () => {
  const articleList = [
    ['1', 114, 120000, 'g1'], ['2', 114, 110000, 'g1'], ['3', 114, 130000, 'g3'],
    ['4', 114, 100000, 'g4'], ['5', 114, 90000, 'g5'], ['6', 84, 80000, 'g6'],
  ].map(([articleNumber, supplySpace, dealPrice, representativeArticleNumber]) => ({
    representativeArticleNumber,
    representativeArticleInfo: { articleNumber, supplySpace, dealPrice },
  }));
  const rows = selectListings({ articleList }, { complexNumber: 107482, complexName: 'test' });
  assert.deepEqual(rows.map((row) => row.articleNumber), ['5', '4', '2']);
});

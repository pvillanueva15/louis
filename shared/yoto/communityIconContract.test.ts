import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildCommunityIconAssetUrl,
  buildCommunityIconSearchUrl,
  normalizeCommunityIconId,
  normalizeCommunityIconPage,
  normalizeCommunityIconQuery,
} from './communityIconContract.ts'

describe('community icon contract', () => {
  it('normalizes search text and constructs only fixed popular-singles page URLs', () => {
    assert.equal(normalizeCommunityIconQuery('  blue   cat  '), 'blue cat')
    assert.equal(
      buildCommunityIconSearchUrl('  blue   cat  '),
      'https://www.yotoicons.com/icons?tag=blue+cat&sort=popular&type=singles&page=1',
    )
    assert.equal(
      buildCommunityIconSearchUrl('cats & dogs'),
      'https://www.yotoicons.com/icons?tag=cats+%26+dogs&sort=popular&type=singles&page=1',
    )
    assert.equal(
      buildCommunityIconSearchUrl('cat', 2),
      'https://www.yotoicons.com/icons?tag=cat&sort=popular&type=singles&page=2',
    )
  })

  it('accepts only bounded canonical page numbers', () => {
    assert.equal(normalizeCommunityIconPage(undefined), 1)
    assert.equal(normalizeCommunityIconPage('2'), 2)
    assert.equal(normalizeCommunityIconPage(1_000), 1_000)
    for (const invalid of [0, -1, 1.5, 1_001, '02', '1.0', 'next', null]) {
      assert.throws(() => normalizeCommunityIconPage(invalid), /Page must be an integer/)
    }
  })

  it('rejects missing, oversized, and control-character search text', () => {
    assert.throws(() => normalizeCommunityIconQuery(undefined), /required/)
    assert.throws(() => normalizeCommunityIconQuery('   '), /between 1 and 80/)
    assert.throws(() => normalizeCommunityIconQuery('a'.repeat(81)), /between 1 and 80/)
    assert.throws(() => normalizeCommunityIconQuery('cat\u0000dog'), /unsupported/)
  })

  it('accepts only canonical positive numeric IDs and fixed PNG paths', () => {
    assert.equal(normalizeCommunityIconId('12583'), '12583')
    assert.equal(
      buildCommunityIconAssetUrl('12583'),
      'https://www.yotoicons.com/static/uploads/12583.png',
    )
    for (const invalid of ['0', '01', '-1', '1.0', '1/../2', '1.png', '12345678901']) {
      assert.throws(() => normalizeCommunityIconId(invalid), /canonical numeric ID/)
    }
  })
})

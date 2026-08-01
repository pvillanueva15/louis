import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  deriveRawCardRevision,
  unwrapRawYotoCard,
} from './yoto-card-raw-contract.ts'

describe('raw Yoto card contract', () => {
  it('unwraps wrapped and direct card responses without normalizing fields', () => {
    const raw = {
      cardId: 'card-1',
      title: 'Title',
      content: { unknown: { sentinel: true } },
    }

    assert.equal(unwrapRawYotoCard({ card: raw }), raw)
    assert.equal(unwrapRawYotoCard(raw), raw)
  })

  it('derives an opaque deterministic revision from the complete raw card', () => {
    const first = {
      cardId: 'card-1',
      updatedAt: '2026-07-31T12:00:00Z',
      nested: { b: 2, a: 1 },
    }
    const reordered = {
      nested: { a: 1, b: 2 },
      updatedAt: '2026-07-31T12:00:00Z',
      cardId: 'card-1',
    }

    assert.equal(deriveRawCardRevision(first), deriveRawCardRevision(reordered))
    assert.notEqual(
      deriveRawCardRevision(first),
      deriveRawCardRevision({ ...first, nested: { b: 3, a: 1 } }),
    )
    assert.match(deriveRawCardRevision(first), /^v1\.[A-Za-z0-9_-]{43}$/)
  })
})

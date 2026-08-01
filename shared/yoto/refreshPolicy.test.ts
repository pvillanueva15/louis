import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { shouldPreserveAuxiliaryRefreshState } from './refreshPolicy.ts'

describe('auxiliary Yoto refresh failure policy', () => {
  it('preserves a connected editor after a transient post-mutation refresh failure', () => {
    assert.equal(
      shouldPreserveAuxiliaryRefreshState(true, true, 502),
      true,
    )
    assert.equal(
      shouldPreserveAuxiliaryRefreshState(true, true),
      true,
    )
  })

  it('does not preserve confirmed authentication or authorization loss', () => {
    assert.equal(
      shouldPreserveAuxiliaryRefreshState(true, true, 401),
      false,
    )
    assert.equal(
      shouldPreserveAuxiliaryRefreshState(true, true, 403),
      false,
    )
  })

  it('leaves normal refresh failure behavior unchanged', () => {
    assert.equal(
      shouldPreserveAuxiliaryRefreshState(false, true, 502),
      false,
    )
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { requireValidUpdateCardTitle } from './yoto-card-save-contract.ts'

function rejectsWithBadRequest(value: unknown): boolean {
  try {
    requireValidUpdateCardTitle(value)
    return false
  }
  catch (error) {
    return (error as { statusCode?: number }).statusCode === 400
  }
}

describe('Yoto card update save contract', () => {
  it('rejects blank and overlong titles before save-job startup', () => {
    assert.equal(rejectsWithBadRequest(undefined), true)
    assert.equal(rejectsWithBadRequest('   '), true)
    assert.equal(rejectsWithBadRequest('x'.repeat(141)), true)
  })

  it('accepts and trims valid titles', () => {
    assert.equal(requireValidUpdateCardTitle('  Bedtime  '), 'Bedtime')
    assert.equal(requireValidUpdateCardTitle('x'.repeat(140)), 'x'.repeat(140))
  })
})

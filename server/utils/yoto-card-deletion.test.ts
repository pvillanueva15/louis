import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DeleteCardRequest } from '../../shared/yoto/cardDeletion.ts'
import { deriveRawCardRevision, type RawYotoCard } from './yoto-card-raw-contract.ts'
import {
  CardDeletionError,
  cardDeletionStatusCode,
  deleteYotoCard,
  validateDeletionCardId,
  type CardDeletionDependencies,
} from './yoto-card-deletion.ts'

function card(overrides: RawYotoCard = {}): RawYotoCard {
  return {
    cardId: 'card-1',
    title: ' Bedtime 🌙 ',
    deleted: false,
    content: {
      chapters: [{ key: 'chapter-1', tracks: [{ key: 'track-1' }] }],
      unknown: { keep: true },
    },
    metadata: { title: 'metadata may differ', note: 'keep' },
    unknown: { keep: true },
    ...overrides,
  }
}

function requestFor(rawCard: RawYotoCard): DeleteCardRequest {
  return {
    expectedRevision: deriveRawCardRevision(rawCard),
    expectedTitle: rawCard.title as string,
  }
}

function recordingDependencies(
  rawCard: RawYotoCard,
  overrides: Partial<CardDeletionDependencies> = {},
) {
  const calls: string[] = []
  const dependencies: CardDeletionDependencies = {
    async fetchOwnedCards() {
      calls.push('mine:get')
      return { cards: [{ cardId: 'card-1', deleted: false }] }
    },
    async fetchCard() {
      calls.push('detail:get')
      return { card: rawCard }
    },
    async deleteCard() {
      calls.push('delete')
      return { status: 'ok' }
    },
    ...overrides,
  }
  return { calls, dependencies }
}

async function expectDeletionError(
  operation: () => Promise<unknown>,
  kind: CardDeletionError['kind'],
  outcomeUncertain = false,
) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof CardDeletionError)
    assert.equal(error.kind, kind)
    assert.equal(error.outcomeUncertain, outcomeUncertain)
    return true
  })
}

describe('Yoto card deletion service', () => {
  it('rejects malformed identity and request bodies before any upstream call', async () => {
    const rawCard = card()
    for (const [cardId, request] of [
      ['', requestFor(rawCard)],
      [' card-1', requestFor(rawCard)],
      ['card-1', null],
      ['card-1', { expectedRevision: 'v1.bad', expectedTitle: rawCard.title }],
      ['card-1', { expectedRevision: requestFor(rawCard).expectedRevision }],
    ] as const) {
      const { calls, dependencies } = recordingDependencies(rawCard)
      await expectDeletionError(
        () => deleteYotoCard(cardId, request, 'token', dependencies),
        'invalid',
      )
      assert.deepEqual(calls, [])
    }
  })

  it('uses exactly mine GET, detail GET, and one DELETE for a valid request', async () => {
    const rawCard = card()
    const { calls, dependencies } = recordingDependencies(rawCard)
    assert.deepEqual(
      await deleteYotoCard('card-1', requestFor(rawCard), 'token', dependencies),
      { status: 'ok', cardId: 'card-1' },
    )
    assert.deepEqual(calls, ['mine:get', 'detail:get', 'delete'])
  })

  it('requires an exact active owned identity before fetching detail', async () => {
    const rawCard = card()
    for (const owned of [
      { cards: [] },
      { cards: [{ cardId: 'card-1', deleted: true }] },
      { cards: [{ cardId: 'CARD-1', deleted: false }] },
    ]) {
      const { calls, dependencies } = recordingDependencies(rawCard, {
        async fetchOwnedCards() {
          calls.push('mine:get')
          return owned
        },
      })
      await expectDeletionError(
        () => deleteYotoCard('card-1', requestFor(rawCard), 'token', dependencies),
        'not-found',
      )
      assert.deepEqual(calls, ['mine:get'])
    }
  })

  it('treats malformed and duplicate owned identities as safe upstream failures', async () => {
    const rawCard = card()
    for (const owned of [
      null,
      { cards: [{}] },
      { cards: [{ cardId: 'card-1' }, { cardId: 'card-1' }] },
      { cards: [{ cardId: 'card-1', deleted: 'false' }] },
    ]) {
      const { calls, dependencies } = recordingDependencies(rawCard, {
        async fetchOwnedCards() {
          calls.push('mine:get')
          return owned
        },
      })
      await expectDeletionError(
        () => deleteYotoCard('card-1', requestFor(rawCard), 'token', dependencies),
        'upstream',
      )
      assert.deepEqual(calls, ['mine:get'])
    }
  })

  it('rejects every detail preflight conflict with zero DELETE calls', async () => {
    const baseline = card()
    const podcast = card({ metadata: { feedUrl: 'https://example.com/feed.xml' } })
    const malformedMetadata = card({ metadata: null })
    const cases: Array<{ detail: unknown; request?: DeleteCardRequest; kind: CardDeletionError['kind'] }> = [
      { detail: null, kind: 'upstream' },
      { detail: card({ cardId: 'card-2' }), kind: 'upstream' },
      { detail: card({ title: 42 }), kind: 'upstream' },
      { detail: card({ title: 'bedtime 🌙' }), kind: 'conflict' },
      { detail: card({ deleted: true }), kind: 'not-found' },
      { detail: podcast, request: requestFor(podcast), kind: 'invalid' },
      { detail: malformedMetadata, request: requestFor(malformedMetadata), kind: 'upstream' },
      { detail: baseline, request: { ...requestFor(baseline), expectedRevision: `v1.${'b'.repeat(43)}` }, kind: 'conflict' },
    ]

    for (const testCase of cases) {
      const { calls, dependencies } = recordingDependencies(baseline, {
        async fetchCard() {
          calls.push('detail:get')
          return testCase.detail
        },
      })
      await expectDeletionError(
        () => deleteYotoCard(
          'card-1',
          testCase.request ?? requestFor(baseline),
          'token',
          dependencies,
        ),
        testCase.kind,
      )
      assert.deepEqual(calls, ['mine:get', 'detail:get'])
    }
  })

  it('accepts only status ok and marks every ambiguous DELETE result uncertain', async () => {
    const rawCard = card()
    for (const response of [null, {}, { status: 'error' }, { status: 'OK' }]) {
      const { calls, dependencies } = recordingDependencies(rawCard, {
        async deleteCard() {
          calls.push('delete')
          return response
        },
      })
      await expectDeletionError(
        () => deleteYotoCard('card-1', requestFor(rawCard), 'token', dependencies),
        'upstream',
        true,
      )
      assert.deepEqual(calls, ['mine:get', 'detail:get', 'delete'])
    }

    const { calls, dependencies } = recordingDependencies(rawCard, {
      async deleteCard() {
        calls.push('delete')
        throw Object.assign(new Error('timeout'), { statusCode: 408 })
      },
    })
    await expectDeletionError(
      () => deleteYotoCard('card-1', requestFor(rawCard), 'token', dependencies),
      'upstream',
      true,
    )
    assert.deepEqual(calls, ['mine:get', 'detail:get', 'delete'])
  })

  it('maps safe errors without confusing them with uncertain deletion outcomes', () => {
    assert.equal(cardDeletionStatusCode(new CardDeletionError('invalid', 'x')), 400)
    assert.equal(cardDeletionStatusCode(new CardDeletionError('not-found', 'x')), 404)
    assert.equal(cardDeletionStatusCode(new CardDeletionError('conflict', 'x')), 409)
    assert.equal(cardDeletionStatusCode(new CardDeletionError('upstream', 'x')), 502)
    assert.equal(validateDeletionCardId('card-1'), 'card-1')
    assert.throws(() => validateDeletionCardId(' card-1'), /malformed/)
    assert.throws(() => validateDeletionCardId(''), /malformed/)
  })
})

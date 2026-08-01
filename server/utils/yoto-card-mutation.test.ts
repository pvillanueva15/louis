import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MutateCardRequest } from '../../shared/yoto/cardMutation.ts'
import {
  deriveRawCardRevision,
  type RawYotoCard,
} from './yoto-card-raw-contract.ts'
import {
  mutateYotoCard,
  type CardMutationDependencies,
} from './yoto-card-mutation.ts'

function requestFor(rawCard: RawYotoCard, expectedTitle = 'Old title'): MutateCardRequest {
  return {
    expectedRevision: deriveRawCardRevision(rawCard),
    mutations: [{
      kind: 'rename-card',
      expectedTitle,
      title: 'New title',
    }],
  }
}

function card(overrides: RawYotoCard = {}): RawYotoCard {
  return {
    cardId: 'card-1',
    title: 'Old title',
    updatedAt: '2026-07-31T12:00:00Z',
    content: {
      chapters: [{
        key: 'chapter-1',
        title: 'Chapter sentinel',
        tracks: [{
          key: 'track-1',
          title: 'Track sentinel',
          unknownTrackField: 'keep',
        }],
        unknownChapterField: 'keep',
      }],
      unknownContentField: 'keep',
    },
    metadata: {
      title: 'Old title',
      note: 'keep',
      cover: { imageL: 'keep' },
      unknownMetadataField: 'keep',
    },
    display: { icon16x16: 'yoto:#keep' },
    config: { keep: true },
    events: [{ keep: true }],
    ambient: { keep: true },
    stream: { keep: true },
    unknownTopLevelField: { keep: true },
    ...overrides,
  }
}

function recordingDependencies(rawCard: RawYotoCard) {
  const calls: Array<{ kind: 'get' | 'post'; card?: RawYotoCard }> = []
  const dependencies: CardMutationDependencies = {
    async fetchCard() {
      calls.push({ kind: 'get' })
      return rawCard
    },
    async postCard(_accessToken, postedCard) {
      calls.push({ kind: 'post', card: postedCard })
      return {}
    },
  }
  return { calls, dependencies }
}

describe('Yoto card mutation service', () => {
  it('performs one fresh GET and one POST while preserving every non-title field', async () => {
    const rawCard = card()
    const { calls, dependencies } = recordingDependencies(rawCard)

    const result = await mutateYotoCard(
      'card-1',
      requestFor(rawCard),
      'access-token',
      dependencies,
    )

    assert.deepEqual(result, { cardId: 'card-1', title: 'New title' })
    assert.deepEqual(calls.map(call => call.kind), ['get', 'post'])
    assert.deepEqual(calls[1]?.card, {
      ...rawCard,
      title: 'New title',
      metadata: {
        ...(rawCard.metadata as Record<string, unknown>),
        title: 'New title',
      },
    })
  })

  it('renames a canonical card without metadata.title while preserving metadata', async () => {
    const rawCard = card({
      metadata: {
        note: 'keep',
        cover: { imageL: 'keep' },
        unknownMetadataField: 'keep',
      },
    })
    const { calls, dependencies } = recordingDependencies(rawCard)

    const result = await mutateYotoCard(
      'card-1',
      requestFor(rawCard),
      'access-token',
      dependencies,
    )

    assert.deepEqual(result, { cardId: 'card-1', title: 'New title' })
    assert.deepEqual(calls.map(call => call.kind), ['get', 'post'])
    assert.deepEqual(calls[1]?.card, {
      ...rawCard,
      title: 'New title',
    })
    assert.deepEqual(calls[1]?.card?.metadata, rawCard.metadata)
  })

  it('renames a canonical card without metadata while preserving its absence', async () => {
    const rawCard = card()
    delete rawCard.metadata
    const { calls, dependencies } = recordingDependencies(rawCard)

    const result = await mutateYotoCard(
      'card-1',
      requestFor(rawCard),
      'access-token',
      dependencies,
    )

    assert.deepEqual(result, { cardId: 'card-1', title: 'New title' })
    assert.deepEqual(calls.map(call => call.kind), ['get', 'post'])
    assert.deepEqual(calls[1]?.card, {
      ...rawCard,
      title: 'New title',
    })
    assert.equal('metadata' in (calls[1]?.card ?? {}), false)
  })

  it('returns a conflict for a stale revision without POSTing', async () => {
    const rawCard = card()
    const { calls, dependencies } = recordingDependencies(rawCard)
    const request = requestFor(rawCard)
    request.expectedRevision = 'v1.stale'

    await assert.rejects(
      mutateYotoCard('card-1', request, 'access-token', dependencies),
      error => (error as { kind?: string }).kind === 'conflict',
    )
    assert.deepEqual(calls.map(call => call.kind), ['get'])
  })

  it('returns a conflict for an expected-title mismatch without POSTing', async () => {
    const rawCard = card()
    const { calls, dependencies } = recordingDependencies(rawCard)

    await assert.rejects(
      mutateYotoCard(
        'card-1',
        requestFor(rawCard, 'Earlier title'),
        'access-token',
        dependencies,
      ),
      error => (error as { kind?: string }).kind === 'conflict',
    )
    assert.deepEqual(calls.map(call => call.kind), ['get'])
  })

  it('returns a conflict without POSTing when metadata.title is absent', async () => {
    const rawCard = card({ metadata: { note: 'missing title' } })
    const { calls, dependencies } = recordingDependencies(rawCard)

    await assert.rejects(
      mutateYotoCard(
        'card-1',
        requestFor(rawCard, 'Earlier title'),
        'access-token',
        dependencies,
      ),
      error => (error as { kind?: string }).kind === 'conflict',
    )
    assert.deepEqual(calls.map(call => call.kind), ['get'])
  })

  it('rejects podcast cards without POSTing', async () => {
    const rawCard = card({
      metadata: {
        title: 'Old title',
        feedUrl: 'https://example.com/feed.xml',
      },
    })
    const { calls, dependencies } = recordingDependencies(rawCard)

    await assert.rejects(
      mutateYotoCard('card-1', requestFor(rawCard), 'access-token', dependencies),
      /Podcast cards/,
    )
    assert.deepEqual(calls.map(call => call.kind), ['get'])
  })

  it('rejects malformed raw title targets without POSTing', async () => {
    const rawCard = card({ metadata: { title: null } })
    const { calls, dependencies } = recordingDependencies(rawCard)

    await assert.rejects(
      mutateYotoCard('card-1', requestFor(rawCard), 'access-token', dependencies),
      /metadata.title is malformed/,
    )
    assert.deepEqual(calls.map(call => call.kind), ['get'])
  })

  it('rejects malformed metadata containers without POSTing', async () => {
    for (const metadata of [null, []]) {
      const rawCard = card({ metadata })
      const { calls, dependencies } = recordingDependencies(rawCard)

      await assert.rejects(
        mutateYotoCard('card-1', requestFor(rawCard), 'access-token', dependencies),
        /metadata is malformed/,
      )
      assert.deepEqual(calls.map(call => call.kind), ['get'])
    }
  })
})

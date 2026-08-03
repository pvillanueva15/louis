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

const MEDIA_ID = 'a'.repeat(43)

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

function iconRequestFor(
  rawCard: RawYotoCard,
  overrides: Record<string, unknown> = {},
): MutateCardRequest {
  return {
    expectedRevision: deriveRawCardRevision(rawCard),
    mutations: [{
      kind: 'set-track-icon',
      chapterKey: 'chapter-1',
      trackKey: 'track-1',
      expectedChapterIcon: { kind: 'absent' },
      expectedTrackIcon: { kind: 'absent' },
      mode: 'icon',
      mediaId: MEDIA_ID,
      ...overrides,
    } as MutateCardRequest['mutations'][number]],
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
      grouping: { nested: ['keep'] },
      unknownContentField: 'keep',
    },
    metadata: {
      title: 'Old title',
      note: 'keep',
      cover: { imageL: 'keep' },
      media: { uploadedMedia: { keep: true } },
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

  it('performs exactly one raw GET and POST for an icon save without media operations', async () => {
    const rawCard = card()
    const { calls, dependencies } = recordingDependencies(rawCard)

    const result = await mutateYotoCard(
      'card-1',
      iconRequestFor(rawCard),
      'access-token',
      dependencies,
    )

    assert.deepEqual(result, { cardId: 'card-1', title: 'Old title' })
    assert.deepEqual(calls.map(call => call.kind), ['get', 'post'])
    const posted = calls[1]!.card!
    const content = posted.content as { chapters: Array<{
      display?: { icon16x16?: string }
      tracks: Array<{
        display?: { icon16x16?: string }
        unknownTrackField?: unknown
      }>
    }> }
    assert.equal(content.chapters[0]!.display!.icon16x16, `yoto:#${MEDIA_ID}`)
    assert.equal(content.chapters[0]!.tracks[0]!.display!.icon16x16, `yoto:#${MEDIA_ID}`)
    assert.deepEqual((posted.content as Record<string, unknown>).grouping, {
      nested: ['keep'],
    })
    assert.deepEqual(posted.metadata, rawCard.metadata)
    assert.deepEqual(posted.stream, rawCard.stream)
    assert.deepEqual(posted.unknownTopLevelField, rawCard.unknownTopLevelField)
    assert.equal(content.chapters[0]!.tracks[0]!.unknownTrackField, 'keep')
    assert.equal(calls.length, 2)
  })

  it('saves a title and icon batch through one preserved raw document POST', async () => {
    const rawCard = card()
    const { calls, dependencies } = recordingDependencies(rawCard)
    const request = iconRequestFor(rawCard)
    request.mutations.unshift({
      kind: 'rename-card',
      expectedTitle: 'Old title',
      title: 'New title',
    })

    const result = await mutateYotoCard('card-1', request, 'access-token', dependencies)

    assert.deepEqual(result, { cardId: 'card-1', title: 'New title' })
    assert.deepEqual(calls.map(call => call.kind), ['get', 'post'])
    assert.equal(calls[1]!.card!.title, 'New title')
    assert.deepEqual(calls[1]!.card!.unknownTopLevelField, rawCard.unknownTopLevelField)
  })

  it('saves card title, track renames, icons, and removals with one GET and one POST', async () => {
    const rawCard = card({
      content: {
        chapters: [{
          key: 'chapter-1',
          title: 'Track one',
          tracks: [
            { key: 'track-1', title: 'Track one', unknown: 'keep-one' },
            { key: 'track-2', title: 'Track two', unknown: 'keep-two' },
          ],
          unknownChapterField: 'keep',
        }],
        grouping: { nested: ['keep'] },
        unknownContentField: 'keep',
      },
    })
    const { calls, dependencies } = recordingDependencies(rawCard)
    const request: MutateCardRequest = {
      expectedRevision: deriveRawCardRevision(rawCard),
      mutations: [
        { kind: 'rename-card', expectedTitle: 'Old title', title: 'New title' },
        { kind: 'rename-track', chapterKey: 'chapter-1', trackKey: 'track-1', expectedTitle: 'Track one', title: 'Renamed one' },
        {
          kind: 'set-track-icon',
          chapterKey: 'chapter-1',
          trackKey: 'track-1',
          expectedChapterIcon: { kind: 'absent' },
          expectedTrackIcon: { kind: 'absent' },
          mode: 'icon',
          mediaId: MEDIA_ID,
        },
        { kind: 'remove-track', chapterKey: 'chapter-1', trackKey: 'track-2', expectedTitle: 'Track two' },
      ],
    }

    await mutateYotoCard('card-1', request, 'access-token', dependencies)

    assert.deepEqual(calls.map(call => call.kind), ['get', 'post'])
    const posted = calls[1]!.card!
    const chapter = (posted.content as { chapters: Array<Record<string, unknown>> }).chapters[0]!
    const tracks = chapter.tracks as Array<Record<string, unknown>>
    assert.equal(posted.title, 'New title')
    assert.equal(chapter.title, 'Track one')
    assert.deepEqual(tracks.map(track => track.key), ['track-1'])
    assert.equal(tracks[0]!.title, 'Renamed one')
    assert.equal((tracks[0]!.display as { icon16x16: string }).icon16x16, `yoto:#${MEDIA_ID}`)
    assert.deepEqual(posted.metadata, {
      ...(rawCard.metadata as Record<string, unknown>),
      title: 'New title',
    })
    assert.deepEqual((posted.content as Record<string, unknown>).grouping, { nested: ['keep'] })
    assert.equal(calls.length, 2)
  })

  it('rejects stale icon state, podcasts, and wrong identity before POST', async () => {
    const staleCard = card({
      content: {
        chapters: [{
          key: 'chapter-1',
          title: 'Chapter sentinel',
          tracks: [{
            key: 'track-1',
            title: 'Track sentinel',
            display: { icon16x16: 'yoto:#changed' },
          }],
        }],
      },
    })
    const stale = recordingDependencies(staleCard)
    await assert.rejects(
      mutateYotoCard(
        'card-1',
        iconRequestFor(staleCard),
        'access-token',
        stale.dependencies,
      ),
      error => (error as { kind?: string }).kind === 'conflict',
    )
    assert.deepEqual(stale.calls.map(call => call.kind), ['get'])

    const podcastCard = card({
      metadata: { title: 'Old title', feedUrl: 'https://example.com/feed.xml' },
    })
    const podcast = recordingDependencies(podcastCard)
    await assert.rejects(
      mutateYotoCard(
        'card-1',
        iconRequestFor(podcastCard),
        'access-token',
        podcast.dependencies,
      ),
      /Podcast cards/,
    )
    assert.deepEqual(podcast.calls.map(call => call.kind), ['get'])

    const wrongCard = card({ cardId: 'card-2' })
    const wrong = recordingDependencies(wrongCard)
    await assert.rejects(
      mutateYotoCard(
        'card-1',
        iconRequestFor(wrongCard),
        'access-token',
        wrong.dependencies,
      ),
      /wrong card identity/,
    )
    assert.deepEqual(wrong.calls.map(call => call.kind), ['get'])
  })

  it('preflights track drift, missing or ambiguous targets, malformed cards, and final removal with zero POSTs', async () => {
    const scenarios: Array<{ rawCard: RawYotoCard; mutation: MutateCardRequest['mutations'][number]; message: RegExp }> = [
      {
        rawCard: card(),
        mutation: { kind: 'rename-track', chapterKey: 'chapter-1', trackKey: 'track-1', expectedTitle: 'stale', title: 'New' },
        message: /track title changed/,
      },
      {
        rawCard: card(),
        mutation: { kind: 'remove-track', chapterKey: 'chapter-1', trackKey: 'missing', expectedTitle: 'Track sentinel' },
        message: /no longer exists/,
      },
      {
        rawCard: card({
          content: {
            chapters: [{
              key: 'chapter-1',
              title: 'Chapter',
              tracks: [
                { key: 'track-1', title: 'Track sentinel' },
                { key: 'track-1', title: 'Track sentinel' },
              ],
            }],
          },
        }),
        mutation: { kind: 'rename-track', chapterKey: 'chapter-1', trackKey: 'track-1', expectedTitle: 'Track sentinel', title: 'New' },
        message: /ambiguous/,
      },
      {
        rawCard: card({ content: { chapters: null } }),
        mutation: { kind: 'rename-track', chapterKey: 'chapter-1', trackKey: 'track-1', expectedTitle: 'Track sentinel', title: 'New' },
        message: /chapters are malformed/,
      },
      {
        rawCard: card({
          content: {
            chapters: [{
              key: 'chapter-1',
              title: 'Only',
              tracks: [{ key: 'track-1', title: 'Only' }],
            }],
          },
        }),
        mutation: { kind: 'remove-track', chapterKey: 'chapter-1', trackKey: 'track-1', expectedTitle: 'Only' },
        message: /keep at least one/,
      },
    ]

    for (const scenario of scenarios) {
      const { calls, dependencies } = recordingDependencies(scenario.rawCard)
      await assert.rejects(
        mutateYotoCard('card-1', {
          expectedRevision: deriveRawCardRevision(scenario.rawCard),
          mutations: [scenario.mutation],
        }, 'access-token', dependencies),
        scenario.message,
      )
      assert.deepEqual(calls.map(call => call.kind), ['get'])
    }
  })
})

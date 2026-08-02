import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyCardMutations,
  applyRenameCardMutation,
  applySetTrackIconMutation,
  CardMutationError,
  cardMutationStatusCode,
  classifyExistingCardChanges,
  getCardTitleValidationError,
  mapRawIconState,
  parseMutateCardRequest,
  resetCardTitle,
} from './cardMutation.ts'

const MEDIA_ID = 'a'.repeat(43)

describe('raw icon state mapping', () => {
  it('distinguishes absent and explicit-null display icons', () => {
    assert.deepEqual(mapRawIconState(undefined), { kind: 'absent' })
    assert.deepEqual(mapRawIconState({}), { kind: 'absent' })
    assert.deepEqual(mapRawIconState({ icon16x16: null }), {
      kind: 'present',
      value: null,
    })
    assert.deepEqual(mapRawIconState({ icon16x16: 'yoto:#icon' }), {
      kind: 'present',
      value: 'yoto:#icon',
    })
  })
})

describe('existing card title state', () => {
  it('distinguishes unchanged, title-only, and playlist changes', () => {
    assert.deepEqual(
      classifyExistingCardChanges('Bedtime', 'Bedtime', false),
      {
        titleDirty: false,
        playlistDirty: false,
        iconDirty: false,
        isDirty: false,
        rawMutationOnly: false,
        titleOnly: false,
      },
    )
    assert.deepEqual(
      classifyExistingCardChanges('  Bedtime  ', 'Bedtime', false),
      {
        titleDirty: false,
        playlistDirty: false,
        iconDirty: false,
        isDirty: false,
        rawMutationOnly: false,
        titleOnly: false,
      },
    )
    assert.deepEqual(
      classifyExistingCardChanges('Stories', 'Bedtime', false),
      {
        titleDirty: true,
        playlistDirty: false,
        iconDirty: false,
        isDirty: true,
        rawMutationOnly: true,
        titleOnly: true,
      },
    )
    assert.deepEqual(
      classifyExistingCardChanges('Stories', 'Bedtime', true),
      {
        titleDirty: true,
        playlistDirty: true,
        iconDirty: false,
        isDirty: true,
        rawMutationOnly: false,
        titleOnly: false,
      },
    )
    assert.deepEqual(
      classifyExistingCardChanges('Stories', 'Bedtime', false, true),
      {
        titleDirty: true,
        playlistDirty: false,
        iconDirty: true,
        isDirty: true,
        rawMutationOnly: true,
        titleOnly: false,
      },
    )
    assert.deepEqual(
      classifyExistingCardChanges('Bedtime', 'Bedtime', true, true),
      {
        titleDirty: false,
        playlistDirty: true,
        iconDirty: true,
        isDirty: true,
        rawMutationOnly: false,
        titleOnly: false,
      },
    )
  })

  it('enforces a trimmed title from 1 to 140 characters', () => {
    assert.match(getCardTitleValidationError('   ') ?? '', /title/)
    assert.equal(getCardTitleValidationError('x'.repeat(140)), null)
    assert.match(getCardTitleValidationError('x'.repeat(141)) ?? '', /140/)
  })

  it('resets an existing title to its loaded baseline', () => {
    assert.equal(resetCardTitle(false, 'Loaded title'), 'Loaded title')
    assert.equal(resetCardTitle(true, 'Ignored baseline'), '')
  })
})

describe('rename-card mutation', () => {
  it('parses the exact W1 request and trims the new title', () => {
    assert.deepEqual(
      parseMutateCardRequest({
        expectedRevision: 'revision-1',
        mutations: [{
          kind: 'rename-card',
          expectedTitle: 'Old title',
          title: '  New title  ',
        }],
      }),
      {
        expectedRevision: 'revision-1',
        mutations: [{
          kind: 'rename-card',
          expectedTitle: 'Old title',
          title: 'New title',
        }],
      },
    )
  })

  it('rejects empty, overlong, and non-singleton mutations', () => {
    for (const title of ['   ', 'x'.repeat(141)]) {
      assert.throws(
        () => parseMutateCardRequest({
          expectedRevision: 'revision-1',
          mutations: [{ kind: 'rename-card', expectedTitle: 'Old', title }],
        }),
      )
    }
    assert.throws(
      () => parseMutateCardRequest({ expectedRevision: 'revision-1', mutations: [] }),
      /At least one/,
    )
  })

  it('changes only top-level title and metadata.title', () => {
    const rawCard = {
      cardId: 'card-1',
      title: 'Old title',
      updatedAt: '2026-07-31T12:00:00Z',
      content: {
        version: 'sentinel-version',
        chapters: [{
          key: 'chapter-1',
          title: 'Chapter sentinel',
          tracks: [{
            key: 'track-1',
            title: 'Track sentinel',
            display: { icon16x16: 'yoto:#icon' },
            unknownTrackField: { keep: true },
          }],
          unknownChapterField: ['keep'],
        }],
        unknownContentField: 17,
      },
      metadata: {
        title: 'Old title',
        note: 'sentinel-note',
        cover: { imageL: 'sentinel-cover' },
        unknownMetadataField: { keep: true },
      },
      display: { icon16x16: 'yoto:#card-icon' },
      config: { sentinel: true },
      events: [{ sentinel: 'event' }],
      ambient: { sentinel: 'ambient' },
      stream: { sentinel: 'stream' },
      unknownTopLevelField: { keep: ['everything'] },
    }

    const renamed = applyRenameCardMutation(rawCard, {
      kind: 'rename-card',
      expectedTitle: 'Old title',
      title: 'New title',
    })

    assert.deepEqual(renamed, {
      ...rawCard,
      title: 'New title',
      metadata: {
        ...rawCard.metadata,
        title: 'New title',
      },
    })
    assert.deepEqual(renamed.content, rawCard.content)
    assert.deepEqual(renamed.display, rawCard.display)
    assert.deepEqual(renamed.config, rawCard.config)
    assert.deepEqual(renamed.events, rawCard.events)
    assert.deepEqual(renamed.ambient, rawCard.ambient)
    assert.deepEqual(renamed.stream, rawCard.stream)
    assert.deepEqual(renamed.unknownTopLevelField, rawCard.unknownTopLevelField)
  })

  it('changes only top-level title when metadata.title is absent', () => {
    const rawCard = {
      cardId: 'card-1',
      title: 'Old title',
      content: { unknownContentField: { keep: true } },
      metadata: {
        note: 'sentinel-note',
        unknownMetadataField: { keep: true },
      },
      unknownTopLevelField: { keep: true },
    }

    const renamed = applyRenameCardMutation(rawCard, {
      kind: 'rename-card',
      expectedTitle: 'Old title',
      title: 'New title',
    })

    assert.deepEqual(renamed, {
      ...rawCard,
      title: 'New title',
    })
    assert.deepEqual(renamed.metadata, rawCard.metadata)
    assert.deepEqual(renamed.content, rawCard.content)
    assert.deepEqual(renamed.unknownTopLevelField, rawCard.unknownTopLevelField)
  })

  it('rejects title drift, malformed targets, and podcast cards', () => {
    assert.throws(
      () => applyRenameCardMutation(
        { title: 'Fresh title', metadata: { title: 'Fresh title' } },
        { kind: 'rename-card', expectedTitle: 'Old title', title: 'New title' },
      ),
      /changed after it was loaded/,
    )
    assert.throws(
      () => applyRenameCardMutation(
        { title: 'Old title', metadata: { title: null } },
        { kind: 'rename-card', expectedTitle: 'Old title', title: 'New title' },
      ),
      /metadata.title is malformed/,
    )
    assert.throws(
      () => applyRenameCardMutation(
        {
          title: 'Old title',
          metadata: { title: 'Old title', feedUrl: 'https://example.com/feed.xml' },
        },
        { kind: 'rename-card', expectedTitle: 'Old title', title: 'New title' },
      ),
      /Podcast cards/,
    )
  })

  it('maps optimistic conflicts to HTTP 409', () => {
    assert.equal(
      cardMutationStatusCode(new CardMutationError('conflict', 'stale')),
      409,
    )
    assert.equal(
      cardMutationStatusCode(new CardMutationError('invalid', 'bad request')),
      400,
    )
  })
})

describe('set-track-icon mutation', () => {
  function expected(value?: string | null) {
    return arguments.length === 0
      ? { kind: 'absent' as const }
      : { kind: 'present' as const, value: value ?? null }
  }

  function iconMutation(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'set-track-icon',
      chapterKey: 'chapter-1',
      trackKey: 'track-1',
      expectedChapterIcon: expected(),
      expectedTrackIcon: expected(),
      mode: 'icon',
      mediaId: MEDIA_ID,
      ...overrides,
    }
  }

  function rawCard(tracks: Record<string, unknown>[]) {
    return {
      cardId: 'card-1',
      title: 'Old title',
      content: {
        chapters: [{
          key: 'chapter-1',
          title: 'Chapter',
          unknownChapterField: { keep: true },
          tracks,
        }],
        grouping: { nested: ['keep'] },
        unknownContentField: 'keep',
      },
      metadata: {
        title: 'Old title',
        media: { uploaded: true },
        unknownMetadataField: 'keep',
      },
      streams: [{ keep: true }],
      unknownTopLevelField: { keep: true },
    }
  }

  it('parses icon-only and title-plus-icon requests', () => {
    const icon = iconMutation()
    assert.deepEqual(
      parseMutateCardRequest({ expectedRevision: 'revision-1', mutations: [icon] }),
      { expectedRevision: 'revision-1', mutations: [icon] },
    )

    const rename = {
      kind: 'rename-card',
      expectedTitle: 'Old title',
      title: '  New title  ',
    }
    const parsed = parseMutateCardRequest({
      expectedRevision: 'revision-1',
      mutations: [rename, icon],
    })
    assert.deepEqual(parsed.mutations, [
      { ...rename, title: 'New title' },
      icon,
    ])
  })

  it('validates mediaId, unique stable-key targets, and the 100-track cap', () => {
    assert.throws(
      () => parseMutateCardRequest({
        expectedRevision: 'revision-1',
        mutations: [iconMutation({ mediaId: 'not-a-media-id' })],
      }),
      /malformed/,
    )
    assert.throws(
      () => parseMutateCardRequest({
        expectedRevision: 'revision-1',
        mutations: [iconMutation(), iconMutation({ mode: 'inherit', mediaId: undefined })],
      }),
      /unique/,
    )
    assert.throws(
      () => parseMutateCardRequest({
        expectedRevision: 'revision-1',
        mutations: Array.from({ length: 101 }, (_, index) => iconMutation({
          trackKey: `track-${index}`,
        })),
      }),
      /100/,
    )
    assert.throws(
      () => parseMutateCardRequest({
        expectedRevision: 'revision-1',
        mutations: [iconMutation({ chapterKey: '' })],
      }),
      /chapterKey/,
    )
  })

  it('assigns a one-track icon to exactly the chapter and track display paths', () => {
    const original = rawCard([{
      key: 'track-1',
      title: 'Track',
      stream: { url: 'https://example.com/audio' },
      unknownTrackField: ['keep'],
    }])
    const mutated = applySetTrackIconMutation(original, iconMutation())
    const icon = `yoto:#${MEDIA_ID}`

    assert.deepEqual(mutated, {
      ...original,
      content: {
        ...original.content,
        chapters: [{
          ...original.content.chapters[0],
          display: { icon16x16: icon },
          tracks: [{
            ...original.content.chapters[0]!.tracks[0],
            display: { icon16x16: icon },
          }],
        }],
      },
    })
  })

  it('changes only the selected track in a multi-track chapter', () => {
    const sibling = {
      key: 'track-2',
      title: 'Sibling',
      display: { icon16x16: 'yoto:#sibling', keep: true },
    }
    const original = rawCard([
      { key: 'track-1', title: 'Track', display: { keep: 'track-display' } },
      sibling,
    ])
    original.content.chapters[0]!.display = {
      icon16x16: 'yoto:#chapter-default',
      keep: 'chapter-display',
    }

    const mutated = applySetTrackIconMutation(original, iconMutation({
      expectedChapterIcon: expected('yoto:#chapter-default'),
    }))
    const chapter = (mutated.content as typeof original.content).chapters[0]!
    assert.deepEqual(chapter.display, original.content.chapters[0]!.display)
    assert.deepEqual(chapter.tracks[1], sibling)
    assert.deepEqual(chapter.tracks[0], {
      ...original.content.chapters[0]!.tracks[0],
      display: {
        keep: 'track-display',
        icon16x16: `yoto:#${MEDIA_ID}`,
      },
    })
  })

  it('inherit removes only the explicit track icon and preserves display siblings', () => {
    const original = rawCard([{
      key: 'track-1',
      title: 'Track',
      display: { icon16x16: null, keep: 'display-sibling' },
    }])
    original.content.chapters[0]!.display = {
      icon16x16: 'yoto:#chapter-default',
      keep: 'chapter-sibling',
    }

    const mutated = applySetTrackIconMutation(original, iconMutation({
      mode: 'inherit',
      mediaId: undefined,
      expectedChapterIcon: expected('yoto:#chapter-default'),
      expectedTrackIcon: expected(null),
    }))
    const chapter = (mutated.content as typeof original.content).chapters[0]!
    assert.deepEqual(chapter.display, original.content.chapters[0]!.display)
    assert.deepEqual(chapter.tracks[0]!.display, { keep: 'display-sibling' })
  })

  it('distinguishes absent, null, and string expected icon states', () => {
    const absent = rawCard([{ key: 'track-1', title: 'Track' }])
    assert.throws(
      () => applySetTrackIconMutation(absent, iconMutation({
        expectedTrackIcon: expected(null),
      })),
      /track icon changed/,
    )

    const presentNull = rawCard([{
      key: 'track-1',
      title: 'Track',
      display: { icon16x16: null },
    }])
    assert.throws(
      () => applySetTrackIconMutation(presentNull, iconMutation()),
      /track icon changed/,
    )
    assert.throws(
      () => applySetTrackIconMutation(presentNull, iconMutation({
        expectedTrackIcon: expected('yoto:#old'),
      })),
      /track icon changed/,
    )
  })

  it('rejects missing and ambiguous targets', () => {
    const original = rawCard([{ key: 'track-1', title: 'Track' }])
    assert.throws(
      () => applySetTrackIconMutation(original, iconMutation({ trackKey: 'missing' })),
      /no longer exists/,
    )

    const ambiguous = rawCard([
      { key: 'track-1', title: 'Track A' },
      { key: 'track-1', title: 'Track B' },
    ])
    assert.throws(
      () => applySetTrackIconMutation(ambiguous, iconMutation()),
      /ambiguous/,
    )
  })

  it('applies an optional rename and icon batch without touching preserved fields', () => {
    const original = rawCard([{ key: 'track-1', title: 'Track' }])
    const mutated = applyCardMutations(original, [
      {
        kind: 'rename-card',
        expectedTitle: 'Old title',
        title: 'New title',
      },
      iconMutation(),
    ])

    assert.equal(mutated.title, 'New title')
    assert.deepEqual(mutated.metadata, {
      ...original.metadata,
      title: 'New title',
    })
    assert.deepEqual(mutated.streams, original.streams)
    assert.deepEqual(mutated.unknownTopLevelField, original.unknownTopLevelField)
    assert.deepEqual(
      (mutated.content as typeof original.content).grouping,
      original.content.grouping,
    )
  })
})

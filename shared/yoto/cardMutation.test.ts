import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyRenameCardMutation,
  CardMutationError,
  cardMutationStatusCode,
  classifyExistingCardChanges,
  getCardTitleValidationError,
  parseMutateCardRequest,
  resetCardTitle,
} from './cardMutation.ts'

describe('existing card title state', () => {
  it('distinguishes unchanged, title-only, and playlist changes', () => {
    assert.deepEqual(
      classifyExistingCardChanges('Bedtime', 'Bedtime', false),
      { titleDirty: false, playlistDirty: false, isDirty: false, titleOnly: false },
    )
    assert.deepEqual(
      classifyExistingCardChanges('  Bedtime  ', 'Bedtime', false),
      { titleDirty: false, playlistDirty: false, isDirty: false, titleOnly: false },
    )
    assert.deepEqual(
      classifyExistingCardChanges('Stories', 'Bedtime', false),
      { titleDirty: true, playlistDirty: false, isDirty: true, titleOnly: true },
    )
    assert.deepEqual(
      classifyExistingCardChanges('Stories', 'Bedtime', true),
      { titleDirty: true, playlistDirty: true, isDirty: true, titleOnly: false },
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
      /Exactly one/,
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

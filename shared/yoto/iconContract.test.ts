import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  normalizePersonalIcon,
  normalizePersonalIconList,
  normalizePersonalIconUpload,
} from './iconContract.ts'

const MEDIA_A = 'A'.repeat(43)
const MEDIA_B = 'B'.repeat(43)
const MEDIA_C = 'C'.repeat(43)

describe('personal Yoto icon contract', () => {
  it('normalizes, redacts, and sorts the personal library', () => {
    const result = normalizePersonalIconList({
      displayIcons: [
        {
          mediaId: MEDIA_A,
          displayIconId: 'older',
          url: 'https://cdn.example/older.png',
          createdAt: '2026-07-30T10:00:00Z',
          userId: 'must-not-leak',
        },
        {
          mediaId: MEDIA_B,
          _id: 'newer-fallback',
          url: 'http://cdn.example/not-secure.png',
          createdAt: '2026-08-01T10:00:00Z',
        },
        {
          mediaId: MEDIA_C,
          displayIconId: 'no-date',
          url: null,
          createdAt: 'not-a-date',
        },
      ],
    })

    assert.deepEqual(result, {
      icons: [
        {
          mediaId: MEDIA_B,
          displayIconId: 'newer-fallback',
          url: null,
          createdAt: '2026-08-01T10:00:00Z',
        },
        {
          mediaId: MEDIA_A,
          displayIconId: 'older',
          url: 'https://cdn.example/older.png',
          createdAt: '2026-07-30T10:00:00Z',
        },
        {
          mediaId: MEDIA_C,
          displayIconId: 'no-date',
          url: null,
          createdAt: null,
        },
      ],
    })
    assert.equal('userId' in result.icons[0]!, false)
  })

  it('keeps missing dates stable', () => {
    const result = normalizePersonalIconList({
      displayIcons: [
        { mediaId: MEDIA_A, displayIconId: 'first' },
        { mediaId: MEDIA_B, displayIconId: 'second' },
      ],
    })

    assert.deepEqual(result.icons.map(icon => icon.displayIconId), ['first', 'second'])
  })

  it('deduplicates media identities after newest-first ordering', () => {
    const result = normalizePersonalIconList({
      displayIcons: [
        {
          mediaId: MEDIA_A,
          displayIconId: 'older-copy',
          createdAt: '2026-07-30T10:00:00Z',
        },
        {
          mediaId: MEDIA_B,
          displayIconId: 'other-icon',
          createdAt: '2026-08-01T10:00:00Z',
        },
        {
          mediaId: MEDIA_A,
          displayIconId: 'newer-copy',
          createdAt: '2026-08-02T10:00:00Z',
        },
      ],
    })

    assert.deepEqual(
      result.icons.map(icon => icon.displayIconId),
      ['newer-copy', 'other-icon'],
    )
  })

  it('rejects malformed envelopes and identifiers', () => {
    assert.throws(() => normalizePersonalIconList({}), /malformed personal icon library/)
    assert.throws(
      () => normalizePersonalIcon({ mediaId: 'short', displayIconId: 'icon' }),
      /invalid mediaId/,
    )
    assert.throws(
      () => normalizePersonalIcon({ mediaId: MEDIA_A }),
      /invalid displayIconId/,
    )
  })

  it('normalizes created and duplicate upload responses', () => {
    assert.deepEqual(
      normalizePersonalIconUpload({
        displayIcon: {
          mediaId: MEDIA_A,
          displayIconId: 'created-icon',
          url: 'https://cdn.example/created.png',
          new: true,
          userId: 'must-not-leak',
        },
      }),
      {
        icon: {
          mediaId: MEDIA_A,
          displayIconId: 'created-icon',
          url: 'https://cdn.example/created.png',
          createdAt: null,
        },
        disposition: 'created',
      },
    )

    assert.deepEqual(
      normalizePersonalIconUpload({
        displayIcon: {
          mediaId: MEDIA_B,
          _id: 'existing-icon',
          url: {},
        },
      }),
      {
        icon: {
          mediaId: MEDIA_B,
          displayIconId: 'existing-icon',
          url: null,
          createdAt: null,
        },
        disposition: 'existing',
      },
    )
  })
})

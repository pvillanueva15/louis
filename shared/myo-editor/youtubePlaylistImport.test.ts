import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PlaylistTrack } from './types.ts'
import {
  evaluateYoutubePlaylistImport,
  parseYoutubePlaylistUrl,
  preselectYoutubePlaylistImport,
  type YoutubePlaylistImportItem,
} from './youtubePlaylistImport.ts'
import {
  YOTO_MYO_MAX_CARD_SECONDS,
  YOTO_MYO_MAX_TRACK_SECONDS,
  YOTO_MYO_MAX_TRACKS,
} from './yotoMyoLimits.ts'

function item(
  id: string,
  partial: Partial<YoutubePlaylistImportItem> = {},
): YoutubePlaylistImportItem {
  return {
    playlistItemId: `item-${id}`,
    videoId: id,
    position: 0,
    title: id,
    channelTitle: 'Channel',
    thumbnailUrl: '',
    durationSeconds: 60,
    available: true,
    ...partial,
  }
}

function track(
  id: string,
  partial: Partial<PlaylistTrack> = {},
): PlaylistTrack {
  return {
    id,
    title: id,
    subtitle: '',
    thumbnailUrl: '',
    source: 'app-youtube',
    youtubeId: id,
    duration: 60,
    ...partial,
  }
}

describe('parseYoutubePlaylistUrl', () => {
  it('accepts supported HTTPS YouTube hosts', () => {
    assert.equal(
      parseYoutubePlaylistUrl('https://www.youtube.com/playlist?list=PL1234567890'),
      'PL1234567890',
    )
    assert.equal(
      parseYoutubePlaylistUrl('https://music.youtube.com/watch?v=abc&list=PLabcdefghij'),
      'PLabcdefghij',
    )
    assert.equal(
      parseYoutubePlaylistUrl('https://youtu.be/abc?list=PLabcdefghij'),
      'PLabcdefghij',
    )
  })

  it('rejects ambiguous, spoofed, and non-HTTPS URLs', () => {
    assert.equal(parseYoutubePlaylistUrl('PL1234567890'), null)
    assert.equal(parseYoutubePlaylistUrl('http://youtube.com/playlist?list=PL1234567890'), null)
    assert.equal(parseYoutubePlaylistUrl('https://youtube.com.example/playlist?list=PL1234567890'), null)
    assert.equal(
      parseYoutubePlaylistUrl('https://youtube.com/playlist?list=PL1234567890&list=PLabcdefghij'),
      null,
    )
  })
})

describe('YouTube playlist import selection', () => {
  it('preselects valid unique items in source order', () => {
    const plan = preselectYoutubePlaylistImport(
      [
        item('one'),
        item('two'),
        item('one', { playlistItemId: 'item-one-again' }),
      ],
      [],
      false,
    )

    assert.deepEqual([...plan.selectedKeys], ['item-one', 'item-two'])
    assert.equal(plan.items[2]?.blockReason, 'duplicate-source')
  })

  it('blocks existing, unavailable, missing-duration, and long tracks', () => {
    const plan = preselectYoutubePlaylistImport(
      [
        item('existing'),
        item('gone', { available: false }),
        item('unknown', { durationSeconds: undefined }),
        item('long', { durationSeconds: YOTO_MYO_MAX_TRACK_SECONDS + 1 }),
      ],
      [track('existing')],
      false,
    )

    assert.deepEqual(
      plan.items.map(entry => entry.blockReason),
      ['duplicate-existing', 'unavailable', 'missing-duration', 'over-track-duration'],
    )
    assert.equal(plan.selectedCount, 0)
  })

  it('allows long tracks when enabled', () => {
    const long = item('long', { durationSeconds: YOTO_MYO_MAX_TRACK_SECONDS + 1 })
    const plan = preselectYoutubePlaylistImport([long], [], true)
    assert.deepEqual([...plan.selectedKeys], [long.playlistItemId])
  })

  it('allows exact track and duration capacity', () => {
    const existing = Array.from({ length: YOTO_MYO_MAX_TRACKS - 1 }, (_, index) =>
      track(`existing-${index}`, { duration: 1 }),
    )
    const remainingDuration
      = YOTO_MYO_MAX_CARD_SECONDS - (YOTO_MYO_MAX_TRACKS - 1)
    const candidate = item('last', { durationSeconds: remainingDuration })
    const plan = preselectYoutubePlaylistImport([candidate], existing, true)

    assert.equal(plan.selectedCount, 1)
  })

  it('keeps earlier requested selections when capacity is exceeded', () => {
    const existing = Array.from({ length: YOTO_MYO_MAX_TRACKS - 1 }, (_, index) =>
      track(`existing-${index}`),
    )
    const first = item('first')
    const second = item('second')
    const requested = new Set([first.playlistItemId, second.playlistItemId])
    const plan = evaluateYoutubePlaylistImport([first, second], existing, requested, false)

    assert.deepEqual([...plan.selectedKeys], [first.playlistItemId])
    assert.equal(plan.items[1]?.blockReason, 'track-capacity')
  })
})

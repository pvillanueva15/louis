import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PlaylistTrack, SaveTrackAction } from './types.ts'
import { playlistToYotoContent } from './playlistToYotoContent.ts'

const MEDIA_ID = 'M'.repeat(43)

function track(draftIcon?: PlaylistTrack['draftIcon']): PlaylistTrack {
  return {
    id: 'video-a',
    title: 'Track A',
    subtitle: '',
    thumbnailUrl: '',
    source: 'app-youtube',
    youtubeId: 'video-a',
    draftTrackId: '11111111-1111-4111-8111-111111111111',
    draftIcon,
  }
}

const plan: SaveTrackAction[] = [{
  kind: 'extract-youtube',
  youtubeId: 'video-a',
  playlistIndex: 0,
}]
const uploads = new Map([[0, {
  transcodedSha256: 'audio-a',
  transcodedInfo: { duration: 10, fileSize: 20, format: 'aac' },
}]])

describe('standalone draft icon serialization', () => {
  it('sets the generated one-track chapter and track to the selected icon', () => {
    const built = playlistToYotoContent('Draft', [track({ mode: 'icon', mediaId: MEDIA_ID })], plan, uploads)
    assert.equal(built.chapters[0]!.display.icon16x16, `yoto:#${MEDIA_ID}`)
    assert.equal(built.chapters[0]!.tracks[0]!.display?.icon16x16, `yoto:#${MEDIA_ID}`)
  })

  it('keeps explicit none from falling through to older display fallbacks', () => {
    const cleared = track({ mode: 'none' })
    cleared.chapterDisplay = { icon16x16: 'yoto:#chapter-old' }
    cleared.yotoReuse = {
      trackUrl: 'yoto:#audio',
      type: 'audio',
      format: 'aac',
      duration: 10,
      fileSize: 20,
      display: { icon16x16: 'yoto:#track-old' },
    }
    const built = playlistToYotoContent('Draft', [cleared], plan, uploads)
    assert.equal(built.chapters[0]!.display.icon16x16, null)
    assert.equal(built.chapters[0]!.tracks[0]!.display?.icon16x16, null)
  })

  it('serializes an absent new-row choice as null instead of using display fallbacks', () => {
    const absent = track()
    absent.chapterDisplay = { icon16x16: 'yoto:#chapter-old' }
    absent.yotoReuse = {
      trackUrl: 'yoto:#audio',
      type: 'audio',
      format: 'aac',
      duration: 10,
      fileSize: 20,
      display: { icon16x16: 'yoto:#track-old' },
    }
    const built = playlistToYotoContent('Draft', [absent], plan, uploads)
    assert.equal(built.chapters[0]!.display.icon16x16, null)
    assert.equal(built.chapters[0]!.tracks[0]!.display?.icon16x16, null)
  })

  it('rejects forged chapter choices on standalone output', () => {
    assert.throws(
      () => playlistToYotoContent('Draft', [track({ mode: 'chapter' })], plan, uploads),
      /not available for standalone/,
    )
  })
})

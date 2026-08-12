import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PlaylistTrack, SaveAsSourceSnapshot } from './types.ts'
import { prepareSaveAsDraft } from './saveAsDraft.ts'

function track(): PlaylistTrack {
  return {
    id: 'source-row',
    title: 'Track one',
    subtitle: 'Yoto upload',
    thumbnailUrl: '',
    source: 'yoto-upload',
    chapterKey: 'chapter-a',
    trackKey: 'track-a',
    yotoReuse: {
      trackUrl: 'yoto:#media-a',
      type: 'audio',
      format: 'aac',
      duration: 30,
      fileSize: 40,
      uid: 'uid-a',
    },
  }
}

function source(): SaveAsSourceSnapshot {
  return {
    title: 'Source title',
    content: {
      version: 'source-version',
      chapters: [{
        key: 'chapter-a',
        title: 'Track one',
        tracks: [{
          key: 'track-a',
          title: 'Track one',
          trackUrl: 'yoto:#media-a',
          stream: { keep: true },
          unknownTrackField: ['keep'],
        }],
        unknownChapterField: { keep: true },
      }],
      grouping: { nested: ['chapter-a'] },
    },
    metadata: {
      title: 'Source title',
      cover: { imageL: 'cover' },
      unknownMetadataField: { keep: true },
    },
  }
}

describe('Save As draft preparation', () => {
  it('creates an isolated local draft with the exact copy title and no source identity', () => {
    const sourceSnapshot = source()
    const sourcePlaylist = [track()]
    const draft = prepareSaveAsDraft({
      source: sourceSnapshot,
      sourceReference: { cardId: 'source-card', expectedRevision: 'revision-1' },
      title: '  Source title  ',
      playlist: sourcePlaylist,
      mutations: [],
    })

    assert.equal(draft.title, 'Copy of Source title')
    assert.notEqual(draft.playlist, sourcePlaylist)
    assert.notEqual(draft.baseline, draft.playlist)
    assert.deepEqual(draft.source, sourceSnapshot)
    assert.equal('cardId' in draft.source, false)
    assert.equal('revision' in draft.source, false)
    assert.deepEqual(draft.sourceReference, {
      cardId: 'source-card',
      expectedRevision: 'revision-1',
    })
    assert.deepEqual(draft.mutations, [])

    draft.playlist[0]!.title = 'Changed only in draft'
    assert.equal(sourcePlaylist[0]!.title, 'Track one')
  })

  it('materializes staged raw changes into the detached source without changing the source snapshot', () => {
    const sourceSnapshot = source()
    const draft = prepareSaveAsDraft({
      source: sourceSnapshot,
      sourceReference: { cardId: 'source-card', expectedRevision: 'revision-1' },
      title: 'Renamed source',
      playlist: [{ ...track(), title: 'Renamed track' }],
      mutations: [
        {
          kind: 'rename-card',
          expectedTitle: 'Source title',
          title: 'Renamed source',
        },
        {
          kind: 'rename-track',
          chapterKey: 'chapter-a',
          trackKey: 'track-a',
          expectedTitle: 'Track one',
          title: 'Renamed track',
        },
      ],
    })

    assert.equal(draft.title, 'Copy of Renamed source')
    assert.equal(draft.source.title, 'Renamed source')
    assert.equal(draft.source.metadata?.title, 'Renamed source')
    const chapter = (draft.source.content.chapters as Array<Record<string, unknown>>)[0]!
    assert.equal(chapter.title, 'Renamed track')
    assert.equal((chapter.tracks as Array<Record<string, unknown>>)[0]!.title, 'Renamed track')
    assert.equal(sourceSnapshot.title, 'Source title')
    assert.deepEqual(sourceSnapshot.content.grouping, { nested: ['chapter-a'] })
  })

  it('assigns fresh draft identities and projects materialized icon changes into the visible baseline', () => {
    const sourceSnapshot = source()
    const first = prepareSaveAsDraft({
      source: sourceSnapshot,
      sourceReference: { cardId: 'source-card', expectedRevision: 'revision-1' },
      title: 'Source title',
      playlist: [{
        ...track(),
        rawIconState: { kind: 'absent' },
        chapterRawIconState: { kind: 'absent' },
      }],
      mutations: [{
        kind: 'set-track-icon',
        chapterKey: 'chapter-a',
        trackKey: 'track-a',
        expectedChapterIcon: { kind: 'absent' },
        expectedTrackIcon: { kind: 'absent' },
        mode: 'icon',
        mediaId: 'M'.repeat(43),
      }],
    })
    const second = prepareSaveAsDraft({
      source: sourceSnapshot,
      sourceReference: { cardId: 'source-card', expectedRevision: 'revision-1' },
      title: 'Source title',
      playlist: [track()],
      mutations: [],
    })

    assert.notEqual(first.playlist[0]!.draftTrackId, second.playlist[0]!.draftTrackId)
    assert.equal(first.playlist[0]!.draftTrackId, first.baseline[0]!.draftTrackId)
    assert.deepEqual(first.playlist[0]!.rawIconState, {
      kind: 'present', value: `yoto:#${'M'.repeat(43)}`,
    })
    assert.deepEqual(first.playlist[0]!.chapterRawIconState, {
      kind: 'present', value: `yoto:#${'M'.repeat(43)}`,
    })
    assert.equal(sourceSnapshot.content.chapters instanceof Array, true)
  })

  it('restores the detached icon baseline when post-detach choices are reset', () => {
    const draft = prepareSaveAsDraft({
      source: source(),
      sourceReference: { cardId: 'source-card', expectedRevision: 'revision-1' },
      title: 'Source title',
      playlist: [track()],
      mutations: [],
    })
    draft.playlist[0]!.draftIcon = { mode: 'none' }
    const reset = structuredClone(draft.baseline)
    assert.equal(reset[0]!.draftIcon, undefined)
    assert.equal(reset[0]!.draftTrackId, draft.playlist[0]!.draftTrackId)
  })
})

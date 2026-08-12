import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PlaylistTrack, SaveAsSourceSnapshot } from '../../shared/myo-editor/types.ts'
import { getCardTotalsLimitError } from '../../shared/myo-editor/yotoMyoLimits.ts'
import { classifyYotoTrack } from '../../shared/myo-editor/classifyYotoTrack.ts'
import {
  buildManifestLookup,
  isWritableProvenance,
  parseProvenance,
} from '../../shared/myo-editor/parseProvenance.ts'
import { mapYotoCardDetail } from './yoto-card-detail.ts'
import {
  buildSaveAsContent,
  buildSaveAsCreateBody,
  buildSaveAsPlan,
} from './save-as-content.ts'

function sourceTrack(
  chapterKey: string,
  trackKey: string,
  title: string,
  overrides: Partial<PlaylistTrack> = {},
): PlaylistTrack {
  return {
    id: `row:${chapterKey}:${trackKey}`,
    title,
    subtitle: 'Yoto upload',
    thumbnailUrl: '',
    source: 'yoto-upload',
    chapterKey,
    trackKey,
    duration: 60,
    yotoReuse: {
      trackUrl: `yoto:#media-${trackKey}`,
      type: 'audio',
      format: 'aac',
      duration: 60,
      fileSize: 100,
      uid: `uid-${trackKey}`,
    },
    ...overrides,
  }
}

function source(): SaveAsSourceSnapshot {
  return {
    title: 'Source card',
    content: {
      version: 'source-version',
      chapters: [
        {
          key: 'chapter-a',
          title: 'Nested chapter',
          overlayLabel: 'A',
          display: { icon16x16: 'yoto:#chapter-icon' },
          tracks: [
            {
              key: 'track-a1',
              title: 'Alpha',
              trackUrl: 'yoto:#media-track-a1',
              type: 'audio',
              format: 'aac',
              duration: 60,
              fileSize: 100,
              uid: 'uid-track-a1',
              display: { icon16x16: 'yoto:#track-icon' },
              unknownTrackField: { keep: 'alpha' },
            },
            {
              key: 'track-a2',
              title: 'Beta',
              trackUrl: 'yoto:#media-track-a2',
              type: 'audio',
              format: 'aac',
              duration: 70,
              fileSize: 110,
              uid: 'uid-track-a2',
              stream: { keep: true },
            },
          ],
          unknownChapterField: ['keep'],
        },
        {
          key: 'chapter-b',
          title: 'Live',
          tracks: [{
            key: 'track-b1',
            title: 'Live',
            trackUrl: 'https://stream.example/live',
            type: 'stream',
            format: 'aac',
            duration: 80,
            fileSize: 120,
            unknownStreamField: { keep: true },
          }],
        },
      ],
      grouping: { nested: ['chapter-a', 'chapter-b'] },
      unknownContentField: { keep: true },
    },
    metadata: {
      title: 'Source card',
      note: 'source-note',
      cover: { imageL: 'cover-url' },
      media: { duration: 210, fileSize: 330, customMediaField: 'keep' },
      unknownMetadataField: { keep: true },
    },
  }
}

function sourcePlaylist(): PlaylistTrack[] {
  return [
    sourceTrack('chapter-a', 'track-a1', 'Alpha'),
    sourceTrack('chapter-a', 'track-a2', 'Beta'),
    sourceTrack('chapter-b', 'track-b1', 'Live', {
      source: 'stream',
      duration: 80,
      yotoReuse: {
        trackUrl: 'https://stream.example/live',
        type: 'stream',
        format: 'aac',
        duration: 80,
        fileSize: 120,
      },
    }),
  ]
}

describe('Save As content creation', () => {
  it('reuses every source track without any extraction or media-upload action', () => {
    const plan = buildSaveAsPlan(sourcePlaylist(), source())

    assert.deepEqual(plan.errors, [])
    assert.deepEqual(plan.tracks.map(action => action.kind), [
      'reuse-source',
      'reuse-source',
      'reuse-source',
    ])
    assert.equal(plan.tracks.some(action => action.kind === 'extract-youtube'), false)
  })

  it('preserves nested chapters, stable keys, icons, streams, and unknown fields', () => {
    const snapshot = source()
    const playlist = sourcePlaylist()
    const plan = buildSaveAsPlan(playlist, snapshot)
    const built = buildSaveAsContent(playlist, snapshot, plan.tracks, new Map())

    assert.deepEqual(built.content, snapshot.content)
    assert.equal(built.metadata?.note, snapshot.metadata?.note)
    assert.equal(built.totalDuration, 210)
    assert.equal(built.totalFileSize, 330)
    assert.deepEqual(built.content.grouping, { nested: ['chapter-a', 'chapter-b'] })

    const chapters = built.content.chapters as Array<Record<string, unknown>>
    assert.deepEqual(chapters.map(chapter => chapter.key), ['chapter-a', 'chapter-b'])
    const nestedTracks = chapters[0]!.tracks as Array<Record<string, unknown>>
    assert.deepEqual(nestedTracks.map(track => track.key), ['track-a1', 'track-a2'])
    assert.deepEqual(nestedTracks[0]!.display, { icon16x16: 'yoto:#track-icon' })
    assert.deepEqual(nestedTracks[1]!.stream, { keep: true })
    assert.deepEqual(chapters[0]!.unknownChapterField, ['keep'])
  })

  it('preserves a plain note byte-for-byte for a no-op direct-YouTube source row', () => {
    const snapshot = source()
    snapshot.metadata!.note = '  keep this note: verbatim  '
    const chapters = snapshot.content.chapters as Array<Record<string, unknown>>
    const tracks = chapters[0]!.tracks as Array<Record<string, unknown>>
    tracks[0]!.trackUrl = 'https://www.youtube.com/watch?v=existing-video'
    const playlist = sourcePlaylist()
    playlist[0] = {
      ...playlist[0]!,
      source: 'youtube-url',
      youtubeId: 'existing-video',
    }
    const plan = buildSaveAsPlan(playlist, snapshot)
    const built = buildSaveAsContent(playlist, snapshot, plan.tracks, new Map())

    assert.deepEqual(plan.errors, [])
    assert.equal(built.metadata?.note, '  keep this note: verbatim  ')
  })

  it('builds a create body without source identity and does not modify the source snapshot', () => {
    const snapshot = source()
    const before = structuredClone(snapshot)
    const playlist = sourcePlaylist()
    const plan = buildSaveAsPlan(playlist, snapshot)
    const built = buildSaveAsContent(playlist, snapshot, plan.tracks, new Map())
    const body = buildSaveAsCreateBody('Copy of Source card', built)

    assert.equal(body.title, 'Copy of Source card')
    assert.equal(body.metadata.title, 'Copy of Source card')
    assert.equal('cardId' in body, false)
    assert.equal('revision' in body, false)
    assert.deepEqual(body.metadata.unknownMetadataField, { keep: true })
    assert.deepEqual((body.metadata.media as Record<string, unknown>).customMediaField, 'keep')
    assert.deepEqual(snapshot, before)
  })

  it('applies normal card-capacity enforcement to reused source media totals', () => {
    const snapshot = source()
    const chapters = snapshot.content.chapters as Array<Record<string, unknown>>
    const tracks = (chapters[0]!.tracks as Array<Record<string, unknown>>)
    tracks[0]!.duration = 3 * 60 * 60
    tracks[1]!.duration = 3 * 60 * 60
    const playlist = sourcePlaylist()
    const plan = buildSaveAsPlan(playlist, snapshot)
    const built = buildSaveAsContent(playlist, snapshot, plan.tracks, new Map())

    assert.match(
      getCardTotalsLimitError({
        totalDuration: built.totalDuration,
        totalFileSize: built.totalFileSize,
      }) ?? '',
      /5-hour/,
    )
  })

  it('rejects negative source media values instead of allowing an over-limit bypass', () => {
    const chapters = Array.from({ length: 8 }, (_, index) => ({
      key: `chapter-${index}`,
      title: `Track ${index}`,
      tracks: [{
        key: 'track-1',
        title: `Track ${index}`,
        trackUrl: `yoto:#media-${index}`,
        type: 'audio',
        format: 'aac',
        duration: index === 7 ? -5_000 : 3_000,
        fileSize: index === 7 ? -1_000_000_000 : 90_000_000,
      }],
    }))
    const snapshot: SaveAsSourceSnapshot = {
      title: 'Malformed totals',
      content: { chapters },
    }
    const playlist = chapters.map((chapter, index) => sourceTrack(
      chapter.key,
      'track-1',
      `Track ${index}`,
    ))
    const plan = buildSaveAsPlan(playlist, snapshot)

    assert.throws(
      () => buildSaveAsContent(playlist, snapshot, plan.tracks, new Map()),
      /malformed duration/,
    )
  })

  it('keeps optional missing Yoto media values compatible without undercounting malformed numbers', () => {
    const snapshot = source()
    const chapters = snapshot.content.chapters as Array<Record<string, unknown>>
    const tracks = chapters[0]!.tracks as Array<Record<string, unknown>>
    delete tracks[0]!.duration
    delete tracks[0]!.fileSize
    const playlist = sourcePlaylist()
    const plan = buildSaveAsPlan(playlist, snapshot)
    const built = buildSaveAsContent(playlist, snapshot, plan.tracks, new Map())

    assert.equal(built.totalDuration, 150)
    assert.equal(built.totalFileSize, 230)
  })

  it('records an added YouTube track for cardToPlaylist reload classification', () => {
    const snapshot = source()
    snapshot.metadata!.note = JSON.stringify({
      preservedEnvelopeField: { keep: true },
      yotoCards: {
        version: 1,
        preservedManifestField: { keep: true },
        tracks: [{
          chapterKey: 'chapter-a',
          trackKey: 'track-a1',
          youtubeId: 'existing-video',
          title: 'Alpha',
        }],
      },
    })
    const playlist = [
      ...sourcePlaylist(),
      {
        id: 'new-video',
        title: 'New YouTube track',
        subtitle: 'YouTube',
        thumbnailUrl: '',
        source: 'app-youtube' as const,
        youtubeId: 'new-video',
      },
    ]
    const plan = buildSaveAsPlan(playlist, snapshot)
    const built = buildSaveAsContent(playlist, snapshot, plan.tracks, new Map([[
      3,
      {
        transcodedSha256: 'uploaded-new-video',
        transcodedInfo: { duration: 40, fileSize: 50, format: 'aac' },
      },
    ]]))
    const body = buildSaveAsCreateBody('Copy of Source card', built)
    const note = JSON.parse(String(body.metadata.note)) as Record<string, unknown>
    const manifest = note.yotoCards as Record<string, unknown>
    const entries = manifest.tracks as Array<Record<string, unknown>>
    assert.deepEqual(note.preservedEnvelopeField, { keep: true })
    assert.deepEqual(manifest.preservedManifestField, { keep: true })
    assert.equal(entries.length, 2)
    assert.equal(entries.some(entry => entry.youtubeId === 'existing-video'), true)
    assert.equal(entries.some(entry => entry.youtubeId === 'new-video'), true)
    assert.deepEqual(body.metadata.unknownMetadataField, { keep: true })

    const detail = mapYotoCardDetail({
      cardId: 'created-card',
      title: body.title,
      content: body.content,
      metadata: body.metadata,
    } as Parameters<typeof mapYotoCardDetail>[0], 'created-revision')
    const lookup = buildManifestLookup(parseProvenance(
      detail.metadataNote,
      detail.contentVersion,
    ))
    const addedTrack = detail.chapters
      .flatMap(chapter => chapter.tracks)
      .find(track => track.title === 'New YouTube track')!
    const classified = classifyYotoTrack(addedTrack, lookup)
    assert.equal(classified.source, 'app-youtube')
    assert.equal(classified.youtubeId, 'new-video')
    assert.equal(classified.title, 'New YouTube track')
  })

  it('rejects adding YouTube to a plain-note source before extraction or POST', () => {
    const snapshot = source()
    const playlist = [
      ...sourcePlaylist(),
      {
        id: 'new-video',
        title: 'New YouTube track',
        subtitle: 'YouTube',
        thumbnailUrl: '',
        source: 'app-youtube' as const,
        youtubeId: 'new-video',
      },
    ]
    const plan = buildSaveAsPlan(playlist, snapshot)
    let extractionCount = 0
    let postCount = 0
    if (plan.errors.length === 0) {
      extractionCount += plan.tracks.filter(action => action.kind === 'extract-youtube').length
      postCount += 1
    }

    assert.match(plan.errors[0] ?? '', /not a Louis provenance manifest/)
    assert.equal(extractionCount, 0)
    assert.equal(postCount, 0)
    assert.equal(snapshot.metadata?.note, 'source-note')
  })

  it('preserves a malformed provenance note and rejects additions before extraction or POST', () => {
    const snapshot = source()
    const malformedNote = JSON.stringify({
      keep: true,
      yotoCards: { version: 1, tracks: 'malformed-sentinel' },
    })
    snapshot.metadata!.note = malformedNote

    const noOpPlaylist = sourcePlaylist()
    const noOpPlan = buildSaveAsPlan(noOpPlaylist, snapshot)
    const noOpBuilt = buildSaveAsContent(noOpPlaylist, snapshot, noOpPlan.tracks, new Map())
    assert.deepEqual(noOpPlan.errors, [])
    assert.equal(noOpBuilt.metadata?.note, malformedNote)
    assert.equal(parseProvenance(malformedNote, undefined), null)

    const playlist = [
      ...noOpPlaylist,
      {
        id: 'new-video',
        title: 'New YouTube track',
        subtitle: 'YouTube',
        thumbnailUrl: '',
        source: 'app-youtube' as const,
        youtubeId: 'new-video',
      },
    ]
    const plan = buildSaveAsPlan(playlist, snapshot)
    let extractionCount = 0
    let postCount = 0
    if (plan.errors.length === 0) {
      extractionCount += plan.tracks.filter(action => action.kind === 'extract-youtube').length
      postCount += 1
    }

    assert.match(plan.errors[0] ?? '', /not a Louis provenance manifest/)
    assert.equal(extractionCount, 0)
    assert.equal(postCount, 0)
    assert.equal(snapshot.metadata?.note, malformedNote)
  })

  it('rejects duplicate provenance targets without rewriting or stale classification', () => {
    const snapshot = source()
    const duplicateNote = JSON.stringify({
      keep: true,
      yotoCards: {
        version: 1,
        tracks: [
          {
            chapterKey: 'chapter-a',
            trackKey: 'track-a1',
            youtubeId: 'first-video',
            title: 'Alpha',
          },
          {
            chapterKey: 'chapter-a',
            trackKey: 'track-a1',
            youtubeId: 'stale-video',
            title: 'Stale Alpha',
          },
        ],
      },
    })
    snapshot.metadata!.note = duplicateNote

    assert.equal(isWritableProvenance(duplicateNote), false)
    const manifest = parseProvenance(duplicateNote, undefined)
    assert.equal(manifest, null)
    const lookup = buildManifestLookup(manifest)
    assert.equal(lookup.size, 0)
    const detail = mapYotoCardDetail({
      cardId: 'duplicate-card',
      title: snapshot.title,
      content: snapshot.content,
      metadata: snapshot.metadata,
    } as Parameters<typeof mapYotoCardDetail>[0], 'revision')
    const classified = classifyYotoTrack(detail.chapters[0]!.tracks[0]!, lookup)
    assert.equal(classified.source, 'yoto-upload')
    assert.equal(classified.youtubeId, undefined)

    const noOpPlaylist = sourcePlaylist()
    const noOpPlan = buildSaveAsPlan(noOpPlaylist, snapshot)
    const noOpBuilt = buildSaveAsContent(noOpPlaylist, snapshot, noOpPlan.tracks, new Map())
    assert.deepEqual(noOpPlan.errors, [])
    assert.equal(noOpBuilt.metadata?.note, duplicateNote)

    const playlist = [
      ...noOpPlaylist,
      {
        id: 'new-video',
        title: 'New YouTube track',
        subtitle: 'YouTube',
        thumbnailUrl: '',
        source: 'app-youtube' as const,
        youtubeId: 'new-video',
      },
    ]
    const plan = buildSaveAsPlan(playlist, snapshot)
    let extractionCount = 0
    let postCount = 0
    if (plan.errors.length === 0) {
      extractionCount += plan.tracks.filter(action => action.kind === 'extract-youtube').length
      postCount += 1
    }

    assert.match(plan.errors[0] ?? '', /not a Louis provenance manifest/)
    assert.equal(extractionCount, 0)
    assert.equal(postCount, 0)
    assert.equal(snapshot.metadata?.note, duplicateNote)
  })

  it('keeps delimiter-bearing provenance tuples distinct during lookup and classification', () => {
    const lookup = buildManifestLookup({
      version: 1,
      tracks: [
        { chapterKey: 'a:b', trackKey: 'c', youtubeId: 'first-video', title: 'First' },
        { chapterKey: 'a', trackKey: 'b:c', youtubeId: 'second-video', title: 'Second' },
      ],
    })
    const detail = mapYotoCardDetail({
      cardId: 'delimiter-card',
      title: 'Delimiter card',
      content: {
        chapters: [
          {
            key: 'a:b',
            title: 'First',
            tracks: [{ key: 'c', title: 'First', trackUrl: 'yoto:#first', type: 'audio' }],
          },
          {
            key: 'a',
            title: 'Second',
            tracks: [{ key: 'b:c', title: 'Second', trackUrl: 'yoto:#second', type: 'audio' }],
          },
        ],
      },
    }, 'revision')
    const [first, second] = detail.chapters.flatMap(chapter => chapter.tracks)

    assert.equal(lookup.size, 2)
    assert.equal(classifyYotoTrack(first!, lookup).youtubeId, 'first-video')
    assert.equal(classifyYotoTrack(second!, lookup).youtubeId, 'second-video')
  })

  it('rejects interleaving a new track inside a nested source chapter', () => {
    const playlist = sourcePlaylist()
    playlist.splice(1, 0, {
      id: 'new-video',
      title: 'New video',
      subtitle: 'YouTube',
      thumbnailUrl: '',
      source: 'app-youtube',
      youtubeId: 'new-video',
    })
    const snapshot = source()
    const plan = buildSaveAsPlan(playlist, snapshot)

    assert.match(
      plan.errors[0] ?? '',
      /Keep the tracks from nested chapter "Nested chapter" together/,
    )
  })

  it('overlays only the selected retained track in a multi-track chapter', () => {
    const snapshot = source()
    const chapters = snapshot.content.chapters as Array<Record<string, unknown>>
    const sourceTracks = chapters[0]!.tracks as Array<Record<string, unknown>>
    sourceTracks[0]!.display = { icon16x16: 'yoto:#old-track', animation: 'keep' }
    const playlist = sourcePlaylist()
    playlist[0]!.draftIcon = { mode: 'icon', mediaId: 'I'.repeat(43) }
    const plan = buildSaveAsPlan(playlist, snapshot)
    const built = buildSaveAsContent(playlist, snapshot, plan.tracks, new Map())
    const builtChapters = built.content.chapters as Array<Record<string, unknown>>
    const builtTracks = builtChapters[0]!.tracks as Array<Record<string, unknown>>

    assert.deepEqual(builtChapters[0]!.display, { icon16x16: 'yoto:#chapter-icon' })
    assert.deepEqual(builtTracks[0]!.display, {
      icon16x16: `yoto:#${'I'.repeat(43)}`,
      animation: 'keep',
    })
    assert.equal(builtTracks[1]!.display, undefined)
    assert.deepEqual(sourceTracks[0]!.display, { icon16x16: 'yoto:#old-track', animation: 'keep' })
  })

  it('rejects malformed authoritative chapter and track displays before building a copy', () => {
    for (const target of ['chapter', 'track'] as const) {
      const snapshot = source()
      const chapters = snapshot.content.chapters as Array<Record<string, unknown>>
      const sourceTracks = chapters[0]!.tracks as Array<Record<string, unknown>>
      if (target === 'chapter') chapters[0]!.display = []
      else sourceTracks[0]!.display = 'not-a-record'

      assert.throws(() => {
        const playlist = sourcePlaylist()
        const plan = buildSaveAsPlan(playlist, snapshot)
        buildSaveAsContent(playlist, snapshot, plan.tracks, new Map())
      }, /display.*malformed/i)
    }
  })

  it('removes only icon16x16 for a chapter choice and preserves display siblings', () => {
    const snapshot = source()
    const chapters = snapshot.content.chapters as Array<Record<string, unknown>>
    const sourceTracks = chapters[0]!.tracks as Array<Record<string, unknown>>
    sourceTracks[0]!.display = { icon16x16: 'yoto:#old-track', animation: 'keep' }
    const playlist = sourcePlaylist()
    playlist[0]!.draftIcon = { mode: 'chapter' }
    const plan = buildSaveAsPlan(playlist, snapshot)
    const built = buildSaveAsContent(playlist, snapshot, plan.tracks, new Map())
    const builtTracks = ((built.content.chapters as Array<Record<string, unknown>>)[0]!.tracks) as Array<Record<string, unknown>>
    assert.deepEqual(builtTracks[0]!.display, { animation: 'keep' })
    assert.deepEqual((built.content.chapters as Array<Record<string, unknown>>)[0]!.display, {
      icon16x16: 'yoto:#chapter-icon',
    })
  })

  it('synchronizes retained one-track set and clear while preserving other raw fields', () => {
    const snapshot = source()
    const playlist = [sourcePlaylist()[0]!]
    playlist[0]!.draftIcon = { mode: 'icon', mediaId: 'S'.repeat(43) }
    let plan = buildSaveAsPlan(playlist, snapshot)
    let built = buildSaveAsContent(playlist, snapshot, plan.tracks, new Map())
    let chapter = (built.content.chapters as Array<Record<string, unknown>>)[0]!
    let builtTrack = (chapter.tracks as Array<Record<string, unknown>>)[0]!
    assert.equal((chapter.display as Record<string, unknown>).icon16x16, `yoto:#${'S'.repeat(43)}`)
    assert.equal((builtTrack.display as Record<string, unknown>).icon16x16, `yoto:#${'S'.repeat(43)}`)
    assert.deepEqual(builtTrack.unknownTrackField, { keep: 'alpha' })

    playlist[0]!.draftIcon = { mode: 'none' }
    plan = buildSaveAsPlan(playlist, snapshot)
    built = buildSaveAsContent(playlist, snapshot, plan.tracks, new Map())
    chapter = (built.content.chapters as Array<Record<string, unknown>>)[0]!
    builtTrack = (chapter.tracks as Array<Record<string, unknown>>)[0]!
    assert.equal((chapter.display as Record<string, unknown>).icon16x16, null)
    assert.equal((builtTrack.display as Record<string, unknown>).icon16x16, null)
  })

  it('preserves the source chapter for a prior chapter choice after removal to one track', () => {
    const snapshot = source()
    const playlist = [sourcePlaylist()[0]!]
    playlist[0]!.draftIcon = { mode: 'chapter' }
    const plan = buildSaveAsPlan(playlist, snapshot)
    const built = buildSaveAsContent(playlist, snapshot, plan.tracks, new Map())
    const chapter = (built.content.chapters as Array<Record<string, unknown>>)[0]!
    const builtTrack = (chapter.tracks as Array<Record<string, unknown>>)[0]!
    assert.deepEqual(chapter.display, { icon16x16: 'yoto:#chapter-icon' })
    assert.deepEqual(builtTrack.display, {})
  })

  it('rejects none on shared chapters and chapter choices on new Save As rows', () => {
    const snapshot = source()
    const playlist = sourcePlaylist()
    playlist[0]!.draftIcon = { mode: 'none' }
    assert.match(buildSaveAsPlan(playlist, snapshot).errors[0] ?? '', /shared chapter icon/)

    const added: PlaylistTrack = {
      id: 'new-video',
      title: 'New video',
      subtitle: '',
      thumbnailUrl: '',
      source: 'app-youtube',
      youtubeId: 'new-video',
      draftIcon: { mode: 'chapter' },
    }
    assert.match(buildSaveAsPlan([added], snapshot).errors[0] ?? '', /cannot use a source chapter icon/)
  })

  it('sets and clears icons on new Save As rows as one-track chapters', () => {
    const snapshot = source()
    delete snapshot.metadata?.note
    const added: PlaylistTrack = {
      id: 'new-video',
      title: 'New video',
      subtitle: '',
      thumbnailUrl: '',
      source: 'app-youtube',
      youtubeId: 'new-video',
      draftIcon: { mode: 'icon', mediaId: 'N'.repeat(43) },
    }
    const uploads = new Map([[0, {
      transcodedSha256: 'audio',
      transcodedInfo: { duration: 10, fileSize: 20, format: 'aac' },
    }]])
    let plan = buildSaveAsPlan([added], snapshot)
    let built = buildSaveAsContent([added], snapshot, plan.tracks, uploads)
    let chapter = (built.content.chapters as Array<Record<string, unknown>>)[0]!
    let builtTrack = (chapter.tracks as Array<Record<string, unknown>>)[0]!
    assert.equal((chapter.display as Record<string, unknown>).icon16x16, `yoto:#${'N'.repeat(43)}`)
    assert.equal((builtTrack.display as Record<string, unknown>).icon16x16, `yoto:#${'N'.repeat(43)}`)

    added.draftIcon = { mode: 'none' }
    plan = buildSaveAsPlan([added], snapshot)
    built = buildSaveAsContent([added], snapshot, plan.tracks, uploads)
    chapter = (built.content.chapters as Array<Record<string, unknown>>)[0]!
    builtTrack = (chapter.tracks as Array<Record<string, unknown>>)[0]!
    assert.equal((chapter.display as Record<string, unknown>).icon16x16, null)
    assert.equal((builtTrack.display as Record<string, unknown>).icon16x16, null)
  })
})

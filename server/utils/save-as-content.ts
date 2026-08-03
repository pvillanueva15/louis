import type {
  PlaylistTrack,
  ProvenanceTrackEntry,
  SaveAsSourceSnapshot,
  SavePlan,
  SaveTrackAction,
  TranscodedAudioResult,
  YotoTrackPayload,
} from '../../shared/myo-editor/types.ts'
import { isWritableProvenance } from '../../shared/myo-editor/parseProvenance.ts'
import { rawTrackTargetKey } from '../../shared/myo-editor/rawTrackManagement.ts'
import { getTrackTitleValidationError } from '../../shared/yoto/cardMutation.ts'
import {
  normalizeYotoAudioFormat,
  yotoChannelsOrStereo,
} from '../../shared/myo-editor/transcodedTrackDefaults.ts'

type RawRecord = Record<string, unknown>

interface SourceTrack {
  chapterKey: string
  trackKey: string
  raw: RawRecord
}

interface SourceChapter {
  key: string
  raw: RawRecord
  tracks: SourceTrack[]
}

interface ParsedSource {
  content: RawRecord
  metadata?: SaveAsSourceSnapshot['metadata']
  chapters: SourceChapter[]
  tracksByTarget: Map<string, SourceTrack>
}

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseSource(source: SaveAsSourceSnapshot): ParsedSource {
  if (!source || typeof source.title !== 'string' || !isRecord(source.content)) {
    throw new Error('The Save As source snapshot is malformed. Reload the card and try again.')
  }
  if (source.metadata !== undefined && !isRecord(source.metadata)) {
    throw new Error('The Save As source metadata is malformed. Reload the card and try again.')
  }
  if (typeof source.metadata?.feedUrl === 'string' && source.metadata.feedUrl.trim()) {
    throw new Error('Podcast cards cannot be duplicated yet.')
  }
  if (!Array.isArray(source.content.chapters)) {
    throw new Error('The Save As source chapters are malformed. Reload the card and try again.')
  }

  const chapterKeys = new Set<string>()
  const tracksByTarget = new Map<string, SourceTrack>()
  const chapters = source.content.chapters.map((chapterValue) => {
    if (
      !isRecord(chapterValue)
      || typeof chapterValue.key !== 'string'
      || !chapterValue.key.trim()
      || typeof chapterValue.title !== 'string'
      || !Array.isArray(chapterValue.tracks)
    ) {
      throw new Error('A Save As source chapter is malformed. Reload the card and try again.')
    }
    if (chapterKeys.has(chapterValue.key)) {
      throw new Error('The Save As source has duplicate chapter keys and cannot be duplicated safely.')
    }
    chapterKeys.add(chapterValue.key)

    const trackKeys = new Set<string>()
    const tracks = chapterValue.tracks.map((trackValue) => {
      if (
        !isRecord(trackValue)
        || typeof trackValue.key !== 'string'
        || !trackValue.key.trim()
        || typeof trackValue.title !== 'string'
      ) {
        throw new Error('A Save As source track is malformed. Reload the card and try again.')
      }
      if (trackKeys.has(trackValue.key)) {
        throw new Error('The Save As source has duplicate track keys and cannot be duplicated safely.')
      }
      trackKeys.add(trackValue.key)
      const sourceTrack: SourceTrack = {
        chapterKey: chapterValue.key as string,
        trackKey: trackValue.key,
        raw: trackValue,
      }
      tracksByTarget.set(
        rawTrackTargetKey(sourceTrack.chapterKey, sourceTrack.trackKey),
        sourceTrack,
      )
      return sourceTrack
    })

    return { key: chapterValue.key as string, raw: chapterValue, tracks }
  })

  return {
    content: source.content,
    metadata: source.metadata,
    chapters,
    tracksByTarget,
  }
}

function nestedChapterInterleaveError(
  playlist: PlaylistTrack[],
  parsed: ParsedSource,
): string | null {
  const playlistIndexByTarget = new Map<string, number>()
  for (let index = 0; index < playlist.length; index++) {
    const track = playlist[index]!
    if (!track.chapterKey || !track.trackKey) continue
    playlistIndexByTarget.set(rawTrackTargetKey(track.chapterKey, track.trackKey), index)
  }

  for (const chapter of parsed.chapters) {
    const indexes = chapter.tracks
      .map(track => playlistIndexByTarget.get(rawTrackTargetKey(track.chapterKey, track.trackKey)))
      .filter((index): index is number => typeof index === 'number')
      .sort((left, right) => left - right)
    for (let index = 1; index < indexes.length; index++) {
      if (indexes[index] !== indexes[index - 1]! + 1) {
        return `Keep the tracks from nested chapter "${String(chapter.raw.title)}" together before creating the copy.`
      }
    }
  }
  return null
}

export function buildSaveAsPlan(
  playlist: PlaylistTrack[],
  source: SaveAsSourceSnapshot,
): SavePlan {
  const parsed = parseSource(source)
  const errors: string[] = []
  const seenTargets = new Set<string>()
  const newYoutubeIds = new Set<string>()

  const tracks = playlist.map((track, index): SaveTrackAction => {
    const hasChapterKey = typeof track.chapterKey === 'string' && Boolean(track.chapterKey.trim())
    const hasTrackKey = typeof track.trackKey === 'string' && Boolean(track.trackKey.trim())
    if (hasChapterKey || hasTrackKey) {
      if (!hasChapterKey || !hasTrackKey) {
        return {
          kind: 'unsupported',
          reason: `Track "${track.title}" has incomplete source identity. Reload the card and try again.`,
          playlistIndex: index,
        }
      }
      const target = rawTrackTargetKey(track.chapterKey!, track.trackKey!)
      if (seenTargets.has(target)) {
        return {
          kind: 'unsupported',
          reason: `Track "${track.title}" appears more than once in the Save As draft.`,
          playlistIndex: index,
        }
      }
      seenTargets.add(target)
      if (!parsed.tracksByTarget.has(target)) {
        return {
          kind: 'unsupported',
          reason: `Track "${track.title}" is not present in the detached Save As source.`,
          playlistIndex: index,
        }
      }
      return { kind: 'reuse-source', playlistIndex: index }
    }

    const youtubeId = track.youtubeId
      ?? (track.source === 'app-youtube' ? track.id : undefined)
    if (
      (track.source === 'app-youtube' || track.source === 'youtube-url')
      && youtubeId
    ) {
      if (newYoutubeIds.has(youtubeId)) {
        return {
          kind: 'unsupported',
          reason: `Duplicate new YouTube video in playlist: ${youtubeId}`,
          playlistIndex: index,
        }
      }
      newYoutubeIds.add(youtubeId)
      return { kind: 'extract-youtube', youtubeId, playlistIndex: index }
    }

    return {
      kind: 'unsupported',
      reason: `Unsupported new track "${track.title}". Remove it before creating this playlist.`,
      playlistIndex: index,
    }
  })

  for (const action of tracks) {
    if (action.kind === 'unsupported') errors.push(action.reason)
  }
  const interleaveError = nestedChapterInterleaveError(playlist, parsed)
  if (interleaveError) errors.push(interleaveError)
  if (
    tracks.some(action => action.kind === 'extract-youtube')
    && !canAddProvenance(parsed.metadata?.note)
  ) {
    errors.push(
      'This card metadata note is not a Louis provenance manifest. Remove the added YouTube tracks to preserve the note unchanged.',
    )
  }
  return { tracks, errors }
}

function nextChapterKey(used: Set<string>): string {
  for (let index = 1; index <= 9999; index++) {
    const candidate = String(index).padStart(2, '0')
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
  throw new Error('Could not allocate a chapter key for the Save As draft.')
}

function newTrackPayload(
  track: PlaylistTrack,
  action: SaveTrackAction,
  uploadedByIndex: Map<number, TranscodedAudioResult>,
): YotoTrackPayload {
  if (action.kind === 'extract-youtube') {
    const uploaded = uploadedByIndex.get(action.playlistIndex)
    if (!uploaded) throw new Error(`Missing upload result for track "${track.title}"`)
    const info = uploaded.transcodedInfo
    return {
      key: '01',
      title: track.title,
      trackUrl: `yoto:#${uploaded.transcodedSha256}`,
      type: 'audio',
      format: normalizeYotoAudioFormat(info.format),
      duration: info.duration ?? 0,
      fileSize: info.fileSize ?? 0,
      overlayLabel: String(action.playlistIndex + 1),
      channels: yotoChannelsOrStereo(info.channels),
      display: { icon16x16: null },
    }
  }
  throw new Error(`Track "${track.title}" cannot be added to the Save As draft.`)
}

function numericField(record: RawRecord, field: 'duration' | 'fileSize'): number {
  const value = record[field]
  if (value === undefined) return 0
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  throw new Error(`A Save As source track has a malformed ${field}. Reload the card and try again.`)
}

function canAddProvenance(note: string | undefined): boolean {
  return note === undefined || isWritableProvenance(note)
}

function mergeProvenanceMetadata(
  metadata: SaveAsSourceSnapshot['metadata'],
  updates: ProvenanceTrackEntry[],
): SaveAsSourceSnapshot['metadata'] {
  if (updates.length === 0) return metadata

  const existingNote = metadata?.note
  let envelope: RawRecord = {}
  if (typeof existingNote === 'string' && existingNote.trim()) {
    if (!canAddProvenance(existingNote)) {
      throw new Error('Cannot add YouTube provenance without replacing the source metadata note.')
    }
    envelope = JSON.parse(existingNote) as RawRecord
  }

  const existingManifest = isRecord(envelope.yotoCards) ? envelope.yotoCards : {}
  const existingTracks = Array.isArray(existingManifest.tracks)
    ? [...existingManifest.tracks]
    : []
  const updateByTarget = new Map(
    updates.map(entry => [rawTrackTargetKey(entry.chapterKey, entry.trackKey), entry]),
  )
  let changed = false
  const tracks = existingTracks.map((entry) => {
    if (!isRecord(entry)) return entry
    const target = typeof entry.chapterKey === 'string' && typeof entry.trackKey === 'string'
      ? rawTrackTargetKey(entry.chapterKey, entry.trackKey)
      : null
    if (!target) return entry
    const update = updateByTarget.get(target)
    if (!update) return entry
    updateByTarget.delete(target)
    if (
      entry.chapterKey === update.chapterKey
      && entry.trackKey === update.trackKey
      && entry.youtubeId === update.youtubeId
      && entry.title === update.title
    ) return entry
    changed = true
    return { ...entry, ...update }
  })
  if (updateByTarget.size > 0) changed = true
  if (!changed) return metadata
  tracks.push(...updateByTarget.values())

  return {
    ...metadata,
    note: JSON.stringify({
      ...envelope,
      yotoCards: {
        ...existingManifest,
        version: 1,
        tracks,
      },
    }),
  }
}

export interface BuiltSaveAsContent {
  content: RawRecord
  metadata?: SaveAsSourceSnapshot['metadata']
  totalDuration: number
  totalFileSize: number
  tracks: RawRecord[]
}

export function buildSaveAsCreateBody(
  title: string,
  built: BuiltSaveAsContent,
): {
  title: string
  content: RawRecord
  metadata: RawRecord
} {
  const readableFileSize = Math.round((built.totalFileSize / 1024 / 1024) * 10) / 10
  return {
    title,
    content: built.content,
    metadata: {
      ...built.metadata,
      title,
      media: {
        ...(built.metadata?.media ?? {}),
        duration: built.totalDuration,
        fileSize: built.totalFileSize,
        readableFileSize,
      },
    },
  }
}

export function buildSaveAsContent(
  playlist: PlaylistTrack[],
  source: SaveAsSourceSnapshot,
  plan: SaveTrackAction[],
  uploadedByIndex: Map<number, TranscodedAudioResult>,
): BuiltSaveAsContent {
  const parsed = parseSource(source)
  if (plan.length !== playlist.length) {
    throw new Error('The Save As plan does not match the draft playlist.')
  }

  const playlistIndexByTarget = new Map<string, number>()
  for (let index = 0; index < playlist.length; index++) {
    const track = playlist[index]!
    if (!track.chapterKey || !track.trackKey) continue
    const target = rawTrackTargetKey(track.chapterKey, track.trackKey)
    if (playlistIndexByTarget.has(target)) {
      throw new Error(`Track "${track.title}" appears more than once in the Save As draft.`)
    }
    playlistIndexByTarget.set(target, index)
  }

  const usedChapterKeys = new Set(parsed.chapters.map(chapter => chapter.key))
  const units: Array<{ playlistIndex: number; chapter: RawRecord; tracks: RawRecord[] }> = []
  const provenanceUpdates: ProvenanceTrackEntry[] = []

  for (const sourceChapter of parsed.chapters) {
    const retained = sourceChapter.tracks
      .map(sourceTrack => ({
        sourceTrack,
        playlistIndex: playlistIndexByTarget.get(
          rawTrackTargetKey(sourceTrack.chapterKey, sourceTrack.trackKey),
        ),
      }))
      .filter((entry): entry is { sourceTrack: SourceTrack; playlistIndex: number } =>
        typeof entry.playlistIndex === 'number',
      )
      .sort((left, right) => left.playlistIndex - right.playlistIndex)

    if (retained.length === 0) continue
    for (let index = 1; index < retained.length; index++) {
      if (retained[index]!.playlistIndex !== retained[index - 1]!.playlistIndex + 1) {
        throw new Error(
          `Keep the tracks from nested chapter "${String(sourceChapter.raw.title)}" together before creating the copy.`,
        )
      }
    }

    const tracks = retained.map(({ sourceTrack, playlistIndex }) => {
      if (plan[playlistIndex]?.kind !== 'reuse-source') {
        throw new Error('A source track was not marked for direct reuse.')
      }
      const playlistTrack = playlist[playlistIndex]!
      const titleError = getTrackTitleValidationError(playlistTrack.title)
      if (titleError) throw new Error(titleError)
      const title = playlistTrack.title.trim()
      return { ...sourceTrack.raw, title }
    })
    const originalSingleTrack = sourceChapter.tracks.length === 1
    const chapterFollowedTrackTitle = originalSingleTrack
      && sourceChapter.raw.title === sourceChapter.tracks[0]!.raw.title
    units.push({
      playlistIndex: retained[0]!.playlistIndex,
      chapter: {
        ...sourceChapter.raw,
        ...(chapterFollowedTrackTitle ? { title: tracks[0]!.title } : {}),
        tracks,
      },
      tracks,
    })
  }

  for (let index = 0; index < playlist.length; index++) {
    const action = plan[index]!
    if (action.kind === 'reuse-source') continue
    const payload = newTrackPayload(playlist[index]!, action, uploadedByIndex)
    const chapterKey = nextChapterKey(usedChapterKeys)
    const chapter = {
      key: chapterKey,
      title: playlist[index]!.title,
      overlayLabel: String(index + 1),
      tracks: [payload],
      display: playlist[index]!.chapterDisplay ?? payload.display ?? { icon16x16: null },
    }
    if (action.kind === 'extract-youtube') {
      provenanceUpdates.push({
        chapterKey,
        trackKey: payload.key,
        youtubeId: action.youtubeId,
        title: playlist[index]!.title.trim(),
      })
    }
    units.push({ playlistIndex: index, chapter, tracks: [payload] })
  }

  units.sort((left, right) => left.playlistIndex - right.playlistIndex)
  const chapters = units.map(unit => unit.chapter)
  const tracks = units.flatMap(unit => unit.tracks)

  return {
    content: { ...parsed.content, chapters },
    metadata: mergeProvenanceMetadata(parsed.metadata, provenanceUpdates),
    totalDuration: tracks.reduce((total, track) => total + numericField(track, 'duration'), 0),
    totalFileSize: tracks.reduce((total, track) => total + numericField(track, 'fileSize'), 0),
    tracks,
  }
}

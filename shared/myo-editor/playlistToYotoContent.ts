import type {
  PlaylistTrack,
  SaveTrackAction,
  TranscodedAudioResult,
  YotoTrackPayload,
} from './types.ts'
import { buildProvenance } from './parseProvenance.ts'
import { resolveDisplayIcon, toYotoTrackPayload } from './yotoTrackPayload.ts'
import { YOTO_CARDS_CONTENT_VERSION } from './types.ts'
import {
  normalizeYotoAudioFormat,
  yotoChannelsOrStereo,
} from './transcodedTrackDefaults.ts'

const TRACK_KEY = '01'

function padKey(index: number): string {
  return String(index + 1).padStart(2, '0')
}

function trackFromTranscoded(
  title: string,
  overlayLabel: string,
  transcoded: TranscodedAudioResult,
  display?: { icon16x16: string | null },
): YotoTrackPayload {
  const info = transcoded.transcodedInfo
  return {
    key: TRACK_KEY,
    title,
    trackUrl: `yoto:#${transcoded.transcodedSha256}`,
    type: 'audio',
    format: normalizeYotoAudioFormat(info.format),
    duration: info.duration ?? 0,
    fileSize: info.fileSize ?? 0,
    overlayLabel,
    channels: yotoChannelsOrStereo(info.channels),
    display: resolveDisplayIcon(display),
  }
}

function displaysForPlaylistTrack(playlistTrack: PlaylistTrack) {
  if (playlistTrack.draftIcon?.mode === 'chapter') {
    throw new Error('Use chapter icon is not available for standalone draft tracks.')
  }
  if (playlistTrack.draftIcon?.mode === 'icon') {
    const display = { icon16x16: `yoto:#${playlistTrack.draftIcon.mediaId}` }
    return { chapter: display, track: display }
  }
  if (playlistTrack.draftIcon?.mode === 'none') {
    const display = { icon16x16: null }
    return { chapter: display, track: display }
  }
  if (playlistTrack.draftTrackId) {
    const display = { icon16x16: null }
    return { chapter: display, track: display }
  }
  const trackDisplay = playlistTrack.yotoReuse?.display
  const chapterDisplay = playlistTrack.chapterDisplay
  return {
    chapter: resolveDisplayIcon(chapterDisplay, trackDisplay),
    track: resolveDisplayIcon(trackDisplay, chapterDisplay),
  }
}

export interface BuiltYotoContent {
  chapters: Array<{
    key: string
    title: string
    overlayLabel: string
    tracks: YotoTrackPayload[]
    display: { icon16x16: string | null }
  }>
  note: string
  contentVersion: string
  totalDuration: number
  totalFileSize: number
}

export function playlistToYotoContent(
  cardTitle: string,
  playlist: PlaylistTrack[],
  plan: SaveTrackAction[],
  uploadedByIndex: Map<number, TranscodedAudioResult>,
  options?: {
    existingMetadataNote?: string | null
    existingContentVersion?: string | null
  },
): BuiltYotoContent {
  const chapters: BuiltYotoContent['chapters'] = []
  const provenanceInputs: Array<{
    chapterKey: string
    trackKey: string
    title: string
    youtubeId: string
  }> = []

  let totalDuration = 0
  let totalFileSize = 0

  for (let i = 0; i < playlist.length; i++) {
    const playlistTrack = playlist[i]!
    const action = plan[i]
    const chapterKey = padKey(i)
    const chapterOverlayLabel = String(i + 1)

    if (!action) {
      throw new Error(`Missing save plan for track "${playlistTrack.title}"`)
    }

    let payload: YotoTrackPayload

    const displays = displaysForPlaylistTrack(playlistTrack)

    if (action.kind === 'extract-youtube') {
      const transcoded = uploadedByIndex.get(i)
      if (!transcoded) {
        throw new Error(`Missing upload result for track "${playlistTrack.title}"`)
      }
      payload = trackFromTranscoded(
        playlistTrack.title,
        chapterOverlayLabel,
        transcoded,
        displays.track,
      )
      provenanceInputs.push({
        chapterKey,
        trackKey: TRACK_KEY,
        title: playlistTrack.title,
        youtubeId: action.youtubeId,
      })
    }
    else if (action.kind === 'reuse-yoto' || action.kind === 'passthrough-stream') {
      payload = {
        ...toYotoTrackPayload(
          action.snapshot,
          playlistTrack.title,
          TRACK_KEY,
          chapterOverlayLabel,
        ),
        display: displays.track,
      }
      if (action.kind === 'reuse-yoto' && playlistTrack.youtubeId) {
        provenanceInputs.push({
          chapterKey,
          trackKey: TRACK_KEY,
          title: playlistTrack.title,
          youtubeId: playlistTrack.youtubeId,
        })
      }
    }
    else {
      throw new Error(`Cannot build content for unsupported track "${playlistTrack.title}"`)
    }

    totalDuration += payload.duration ?? 0
    totalFileSize += payload.fileSize ?? 0

    chapters.push({
      key: chapterKey,
      title: playlistTrack.title,
      overlayLabel: chapterOverlayLabel,
      tracks: [payload],
      display: displays.chapter,
    })
  }

  const provenance = provenanceInputs.length > 0
    ? buildProvenance(provenanceInputs)
    : {
        note: options?.existingMetadataNote?.trim() || buildProvenance([]).note,
        contentVersion: options?.existingContentVersion?.trim() || YOTO_CARDS_CONTENT_VERSION,
      }

  return {
    chapters,
    note: provenance.note,
    contentVersion: provenance.contentVersion,
    totalDuration,
    totalFileSize,
  }
}

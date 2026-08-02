import type { YotoCardDetail, YotoTrackDetail } from '#shared/myo-editor/types'
import type { YotoCardMetadata } from '#shared/myo-editor/types'
import { mapRawIconState } from '#shared/yoto/cardMutation'
import {
  fetchRawYotoCard,
} from './yoto-card-raw'
import {
  deriveRawCardRevision,
  type RawYotoCard,
} from './yoto-card-raw-contract'

interface YotoApiTrack {
  key: string
  title: string
  trackUrl: string
  type: string
  duration?: number
  format?: string
  fileSize?: number
  channels?: string | number
  overlayLabel?: string
  display?: { icon16x16?: string | null }
  uid?: string
}

interface YotoApiChapter {
  key: string
  title: string
  display?: { icon16x16?: string | null }
  tracks?: YotoApiTrack[]
}

interface YotoApiCardDetail {
  cardId: string
  title: string
  content?: {
    version?: string
    chapters?: YotoApiChapter[]
  }
  metadata?: YotoCardMetadata
}

function mapChannels(channels: string | number | undefined): 'stereo' | 'mono' | undefined {
  if (channels === 'stereo' || channels === 2 || channels === '2') return 'stereo'
  if (channels === 'mono' || channels === 1 || channels === '1') return 'mono'
  return undefined
}

function mapTrack(
  chapterKey: string,
  chapterDisplay: YotoApiChapter['display'],
  chapterTrackCount: number,
  track: YotoApiTrack,
): YotoTrackDetail {
  return {
    chapterKey,
    trackKey: track.key,
    rawIconState: mapRawIconState(track.display),
    chapterRawIconState: mapRawIconState(chapterDisplay),
    chapterTrackCount,
    key: track.key,
    title: track.title,
    trackUrl: track.trackUrl,
    type: track.type === 'stream' ? 'stream' : 'audio',
    format: track.format ?? '',
    duration: track.duration ?? 0,
    fileSize: track.fileSize ?? 0,
    overlayLabel: track.overlayLabel ?? track.key,
    channels: mapChannels(track.channels),
    display: track.display ? { icon16x16: track.display.icon16x16 ?? null } : undefined,
    uid: track.uid,
  }
}

export function mapYotoCardDetail(
  data: YotoApiCardDetail,
  revision: string,
): YotoCardDetail {
  const chapters = (data.content?.chapters ?? []).map((chapter) => {
    const tracks = chapter.tracks ?? []
    return {
      key: chapter.key,
      title: chapter.title,
      rawIconState: mapRawIconState(chapter.display),
      display: chapter.display
        ? { icon16x16: chapter.display.icon16x16 ?? null }
        : undefined,
      tracks: tracks.map(track => mapTrack(
        chapter.key,
        chapter.display,
        tracks.length,
        track,
      )),
    }
  })

  const metadata = data.metadata ?? null

  return {
    cardId: data.cardId,
    title: data.title,
    revision,
    contentVersion: data.content?.version ?? null,
    metadataNote: metadata?.note ?? null,
    feedUrl: metadata?.feedUrl ?? null,
    metadata,
    chapters,
  }
}

export async function fetchYotoCardDetail(
  cardId: string,
  accessToken: string,
): Promise<YotoCardDetail> {
  const raw = await fetchRawYotoCard(cardId, accessToken)
  return mapYotoCardDetail(
    raw as RawYotoCard & YotoApiCardDetail,
    deriveRawCardRevision(raw),
  )
}

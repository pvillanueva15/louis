import type {
  TrackSource,
  YotoTrackDetail,
} from './types.ts'
import { manifestLookupKey } from './parseProvenance.ts'
import { extractYoutubeIdFromUrl } from './youtubeUrl.ts'

export interface ClassifiedYotoTrack extends YotoTrackDetail {
  source: TrackSource
  youtubeId?: string
}

export function classifyYotoTrack(
  track: YotoTrackDetail,
  manifestLookup: Map<string, { youtubeId: string; title: string }>,
): ClassifiedYotoTrack {
  const manifestEntry = manifestLookup.get(manifestLookupKey(track.chapterKey, track.trackKey))
  if (manifestEntry) {
    return {
      ...track,
      source: 'app-youtube',
      youtubeId: manifestEntry.youtubeId,
    }
  }

  const youtubeId = extractYoutubeIdFromUrl(track.trackUrl)
  if (youtubeId) return { ...track, source: 'youtube-url', youtubeId }
  if (track.trackUrl?.startsWith('yoto:#')) return { ...track, source: 'yoto-upload' }
  if (track.type === 'stream') return { ...track, source: 'stream' }
  return { ...track, source: 'unknown' }
}

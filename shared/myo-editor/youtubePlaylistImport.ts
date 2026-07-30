import type { PlaylistTrack } from './types.ts'
import {
  YOTO_MYO_MAX_CARD_SECONDS,
  YOTO_MYO_MAX_TRACK_SECONDS,
  YOTO_MYO_MAX_TRACKS,
} from './yotoMyoLimits.ts'

const YOUTUBE_PLAYLIST_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
])

const YOUTUBE_PLAYLIST_ID = /^[A-Za-z0-9_-]{10,100}$/

export interface YoutubePlaylistSummary {
  id: string
  title: string
  channelTitle: string
  itemCount?: number
}

export interface YoutubePlaylistImportItem {
  playlistItemId: string
  videoId: string
  position: number
  title: string
  channelTitle: string
  thumbnailUrl: string
  duration?: string
  durationSeconds?: number
  available: boolean
}

export interface YoutubePlaylistImportResponse {
  playlist?: YoutubePlaylistSummary
  items: YoutubePlaylistImportItem[]
  nextPageToken?: string
}

export type YoutubePlaylistImportBlockReason =
  | 'unavailable'
  | 'missing-duration'
  | 'over-track-duration'
  | 'duplicate-existing'
  | 'duplicate-source'
  | 'track-capacity'
  | 'duration-capacity'

export interface YoutubePlaylistImportEvaluation {
  items: Array<{
    item: YoutubePlaylistImportItem
    selected: boolean
    blockReason?: YoutubePlaylistImportBlockReason
  }>
  selectedKeys: Set<string>
  selectedCount: number
  selectedDurationSeconds: number
}

export function isYoutubePlaylistId(value: string): boolean {
  return YOUTUBE_PLAYLIST_ID.test(value)
}

export function parseYoutubePlaylistUrl(value: string): string | null {
  let url: URL
  try {
    url = new URL(value.trim())
  }
  catch {
    return null
  }

  if (url.protocol !== 'https:' || !YOUTUBE_PLAYLIST_HOSTS.has(url.hostname.toLowerCase())) {
    return null
  }

  const values = url.searchParams.getAll('list')
  if (values.length !== 1) return null

  const playlistId = values[0]?.trim() ?? ''
  return isYoutubePlaylistId(playlistId) ? playlistId : null
}

function trackDurationSeconds(track: PlaylistTrack): number | undefined {
  if (typeof track.duration === 'number' && Number.isFinite(track.duration) && track.duration > 0) {
    return track.duration
  }
  const duration = track.yotoReuse?.duration
  if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
    return duration
  }
  return undefined
}

function baseBlockReason(
  item: YoutubePlaylistImportItem,
  existingYoutubeIds: Set<string>,
  isLaterSourceDuplicate: boolean,
  allowLongTracks: boolean,
): YoutubePlaylistImportBlockReason | undefined {
  if (!item.available) return 'unavailable'
  if (
    typeof item.durationSeconds !== 'number'
    || !Number.isFinite(item.durationSeconds)
    || item.durationSeconds <= 0
  ) {
    return 'missing-duration'
  }
  if (!allowLongTracks && item.durationSeconds > YOTO_MYO_MAX_TRACK_SECONDS) {
    return 'over-track-duration'
  }
  if (existingYoutubeIds.has(item.videoId)) return 'duplicate-existing'
  if (isLaterSourceDuplicate) return 'duplicate-source'
  return undefined
}

/**
 * Evaluates a requested import selection in source order. If the request is
 * over capacity, earlier playlist entries win and later entries are disabled.
 */
export function evaluateYoutubePlaylistImport(
  items: YoutubePlaylistImportItem[],
  existingPlaylist: PlaylistTrack[],
  requestedSelectedKeys: ReadonlySet<string>,
  allowLongTracks: boolean,
): YoutubePlaylistImportEvaluation {
  const existingYoutubeIds = new Set(
    existingPlaylist
      .map(track => track.youtubeId)
      .filter((id): id is string => Boolean(id)),
  )
  const firstSourceItemByVideoId = new Map<string, string>()
  for (const item of items) {
    if (!firstSourceItemByVideoId.has(item.videoId)) {
      firstSourceItemByVideoId.set(item.videoId, item.playlistItemId)
    }
  }

  let trackCount = existingPlaylist.length
  let durationSeconds = existingPlaylist.reduce(
    (sum, track) => sum + (trackDurationSeconds(track) ?? 0),
    0,
  )
  const selectedKeys = new Set<string>()
  const result: YoutubePlaylistImportEvaluation['items'] = []

  for (const item of items) {
    const isLaterDuplicate
      = firstSourceItemByVideoId.get(item.videoId) !== item.playlistItemId
    const baseReason = baseBlockReason(
      item,
      existingYoutubeIds,
      isLaterDuplicate,
      allowLongTracks,
    )

    if (baseReason) {
      result.push({ item, selected: false, blockReason: baseReason })
      continue
    }

    const duration = item.durationSeconds!
    const overTrackCapacity = trackCount + 1 > YOTO_MYO_MAX_TRACKS
    const overDurationCapacity = durationSeconds + duration > YOTO_MYO_MAX_CARD_SECONDS
    const capacityReason: YoutubePlaylistImportBlockReason | undefined
      = overTrackCapacity
        ? 'track-capacity'
        : overDurationCapacity
          ? 'duration-capacity'
          : undefined

    if (requestedSelectedKeys.has(item.playlistItemId) && !capacityReason) {
      selectedKeys.add(item.playlistItemId)
      trackCount += 1
      durationSeconds += duration
      result.push({ item, selected: true })
      continue
    }

    result.push({
      item,
      selected: false,
      blockReason: capacityReason,
    })
  }

  const existingDurationSeconds = existingPlaylist.reduce(
    (sum, track) => sum + (trackDurationSeconds(track) ?? 0),
    0,
  )

  return {
    items: result,
    selectedKeys,
    selectedCount: selectedKeys.size,
    selectedDurationSeconds: durationSeconds - existingDurationSeconds,
  }
}

export function preselectYoutubePlaylistImport(
  items: YoutubePlaylistImportItem[],
  existingPlaylist: PlaylistTrack[],
  allowLongTracks: boolean,
): YoutubePlaylistImportEvaluation {
  return evaluateYoutubePlaylistImport(
    items,
    existingPlaylist,
    new Set(items.map(item => item.playlistItemId)),
    allowLongTracks,
  )
}

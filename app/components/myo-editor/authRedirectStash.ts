import type { PlaylistTrack } from '~/components/playlist/types'
import type { StagedTrackIconAssignment } from '#shared/myo-editor/trackIconAssignment'
import type { StagedTrackRemoval, StagedTrackRename } from '#shared/myo-editor/rawTrackManagement'
import type { SaveAsSourceReference, SaveAsSourceSnapshot } from '#shared/myo-editor/types'
import type { CardMutation } from '#shared/yoto/cardMutation'
import type { YotoCardDetail } from './types'

/**
 * Connecting to Yoto is a full-page redirect (Louis → Yoto → back), which
 * wipes all client state. This stash carries the in-progress editor across
 * that round trip so a playlist arranged before OAuth survives it.
 */
const STORAGE_KEY = 'yoto-cards:auth-redirect-editor'

/** OAuth round trips take seconds; anything older is a stale leftover. */
const STASH_MAX_AGE_MS = 30 * 60 * 1000

export interface AuthRedirectEditorStash {
  savedAt: number
  selectedCardId: string | null
  isNewPlaylist: boolean
  isSaveAsDraft: boolean
  cardTitle: string
  baselineCardTitle: string
  cardRevision: string
  isPodcast: boolean
  playlist: PlaylistTrack[]
  baselinePlaylist: PlaylistTrack[]
  trackIconAssignments: StagedTrackIconAssignment[]
  trackTitleAssignments: StagedTrackRename[]
  trackRemovalAssignments: StagedTrackRemoval[]
  originalCardDetail: YotoCardDetail | null
  saveAsSourceSnapshot: SaveAsSourceSnapshot | null
  saveAsSourceReference: SaveAsSourceReference | null
  saveAsMutations: CardMutation[]
}

function isValidStash(value: unknown): value is AuthRedirectEditorStash {
  if (!value || typeof value !== 'object') return false
  const stash = value as Partial<AuthRedirectEditorStash>
  return typeof stash.savedAt === 'number'
    && typeof stash.isNewPlaylist === 'boolean'
    && typeof stash.isSaveAsDraft === 'boolean'
    && typeof stash.cardTitle === 'string'
    && typeof stash.baselineCardTitle === 'string'
    && typeof stash.cardRevision === 'string'
    && typeof stash.isPodcast === 'boolean'
    && (stash.selectedCardId === null || typeof stash.selectedCardId === 'string')
    && Array.isArray(stash.playlist)
    && Array.isArray(stash.baselinePlaylist)
    && Array.isArray(stash.trackIconAssignments)
    && Array.isArray(stash.trackTitleAssignments)
    && Array.isArray(stash.trackRemovalAssignments)
    && Array.isArray(stash.saveAsMutations)
}

export function writeAuthRedirectStash(stash: AuthRedirectEditorStash): void {
  if (typeof sessionStorage === 'undefined') return

  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stash))
  }
  catch {
    // Best effort — worst case the user re-arranges the playlist.
  }
}

/** Reads and removes the stash. Returns null if absent, malformed, or stale. */
export function takeAuthRedirectStash(): AuthRedirectEditorStash | null {
  if (typeof sessionStorage === 'undefined') return null

  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    sessionStorage.removeItem(STORAGE_KEY)

    const parsed: unknown = JSON.parse(raw)
    if (!isValidStash(parsed)) return null
    if (Date.now() - parsed.savedAt > STASH_MAX_AGE_MS) return null
    return parsed
  }
  catch {
    return null
  }
}

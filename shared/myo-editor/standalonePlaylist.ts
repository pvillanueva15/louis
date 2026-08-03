import type {
  PlaylistTrack,
  SaveAsSourceReference,
  SaveAsSourceSnapshot,
  SaveJobPhase,
  SaveOperation,
} from './types'
import type { CardMutation } from '../yoto/cardMutation.ts'
import { getCardTitleValidationError } from '../yoto/cardMutation.ts'

export const NEW_PLAYLIST_SAVE_KEY = 'new-playlist-draft'
export const UNCERTAIN_CREATE_START_MESSAGE
  = 'Could not confirm whether Louis started creating this playlist. Check My Cards before trying again.'

export type ClientSaveTarget =
  | { operation: 'create' }
  | { operation: 'update'; cardId: string }

export interface CardSaveSnapshot {
  playlist: PlaylistTrack[]
  baseline: PlaylistTrack[]
  cardTitle: string
  baselineCardTitle: string
  cardRevision: string
  saveAsSource?: SaveAsSourceSnapshot
  saveAsSourceReference?: SaveAsSourceReference
  saveAsMutations?: CardMutation[]
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function cloneCardSaveSnapshot(snapshot: CardSaveSnapshot): CardSaveSnapshot {
  return {
    playlist: snapshot.playlist.map(track => ({ ...track })),
    baseline: snapshot.baseline.map(track => ({ ...track })),
    cardTitle: snapshot.cardTitle,
    baselineCardTitle: snapshot.baselineCardTitle,
    cardRevision: snapshot.cardRevision,
    ...(snapshot.saveAsSource
      ? { saveAsSource: cloneJson(snapshot.saveAsSource) }
      : {}),
    ...(snapshot.saveAsSourceReference
      ? { saveAsSourceReference: { ...snapshot.saveAsSourceReference } }
      : {}),
    ...(snapshot.saveAsMutations
      ? { saveAsMutations: cloneJson(snapshot.saveAsMutations) }
      : {}),
  }
}

export type ClientSaveIdentity =
  | {
    operation: 'create'
    saveKey: typeof NEW_PLAYLIST_SAVE_KEY
    endpoint: '/api/yoto/content/save'
  }
  | {
    operation: 'update'
    saveKey: string
    cardId: string
    endpoint: string
  }

interface FetchErrorLike {
  statusCode?: number
  statusMessage?: string
  data?: { statusMessage?: string }
  message?: string
}

export function isPlaylistEditorActive(
  selectedCardId: string | null,
  isNewPlaylist: boolean,
): boolean {
  return isNewPlaylist || Boolean(selectedCardId)
}

export function shouldConfirmEditorNavigation(
  isEditing: boolean,
  isDirty: boolean,
  saveActive: boolean,
): boolean {
  return isEditing && isDirty && !saveActive
}

export function resetEditorTitle(
  isNewPlaylist: boolean,
  isSaveAsDraft: boolean,
  baselineTitle: string,
): string {
  return isSaveAsDraft
    ? baselineTitle
    : resetCardTitle(isNewPlaylist, baselineTitle)
}

export function resolveClientSaveTarget(target: ClientSaveTarget): ClientSaveIdentity {
  if (target.operation === 'create') {
    return {
      operation: 'create',
      saveKey: NEW_PLAYLIST_SAVE_KEY,
      endpoint: '/api/yoto/content/save',
    }
  }

  const cardId = target.cardId.trim()
  if (!cardId) throw new Error('Existing card ID is required for an update.')

  return {
    operation: 'update',
    saveKey: cardId,
    cardId,
    endpoint: `/api/yoto/content/${cardId}/save`,
  }
}

export function isSupportedYoutubeTrack(track: PlaylistTrack): boolean {
  if (!track || typeof track !== 'object') return false
  if (track.source !== 'app-youtube' && track.source !== 'youtube-url') return false
  const youtubeId = typeof track.youtubeId === 'string' ? track.youtubeId.trim() : ''
  const appYoutubeId = track.source === 'app-youtube' && typeof track.id === 'string'
    ? track.id.trim()
    : ''
  return Boolean(youtubeId || appYoutubeId)
}

export function getStandalonePlaylistValidationError(
  title: string,
  playlist: PlaylistTrack[],
  options?: {
    isSaveAsDraft?: boolean
  },
): string | null {
  const titleError = getCardTitleValidationError(title)
  if (titleError) return titleError
  if (playlist.length === 0) {
    if (options?.isSaveAsDraft) {
      return 'A copied playlist must keep at least one track before creating it.'
    }
    return 'Add at least one YouTube track before creating this playlist.'
  }
  if (
    !options?.isSaveAsDraft
    && playlist.some(track => !isSupportedYoutubeTrack(track))
  ) {
    return 'New playlists can only include supported YouTube tracks.'
  }
  return null
}

export function resolveSavedCardId(
  operation: SaveOperation,
  existingCardId: string | null,
  returnedCardId?: string,
): string {
  if (operation === 'update') {
    const cardId = existingCardId?.trim()
    if (!cardId) throw new Error('Existing card ID is required for an update.')
    return cardId
  }

  const cardId = returnedCardId?.trim()
  if (!cardId) {
    throw new Error(
      'Yoto did not return an ID for the created playlist. Check My Cards before trying again.',
    )
  }
  return cardId
}

export function notifyConfirmedPlaylistCreated(
  operation: SaveOperation,
  cardId: string,
  notify?: (cardId: string) => void,
): void {
  if (operation === 'create') notify?.(cardId)
}

export async function notifyConfirmedCardUpdated(
  operation: SaveOperation,
  status: SaveJobPhase,
  cardId: string,
  notify?: (cardId: string) => void | Promise<void>,
): Promise<void> {
  if (operation === 'update' && status === 'complete') {
    await notify?.(cardId)
  }
}

export function classifyCreateStartFailure(error: unknown): {
  message: string
  outcomeUncertain: boolean
} {
  const fetchError = error as FetchErrorLike
  const message = fetchError.data?.statusMessage
    ?? fetchError.statusMessage
    ?? fetchError.message
    ?? 'Failed to create playlist'

  if (
    fetchError.statusCode === 400
    || fetchError.statusCode === 401
    || fetchError.statusCode === 403
  ) {
    return { message, outcomeUncertain: false }
  }

  return {
    message: UNCERTAIN_CREATE_START_MESSAGE,
    outcomeUncertain: true,
  }
}

export interface EditorOperationLocks {
  backgroundSaveActive: boolean
  cardMutationActive: boolean
}

export function shouldBlockEditorNavigation(
  isNewPlaylist: boolean,
  locks: EditorOperationLocks,
): boolean {
  return locks.cardMutationActive
    || (isNewPlaylist && locks.backgroundSaveActive)
}

export function shouldWarnBeforeUnload(
  isDirty: boolean,
  locks: EditorOperationLocks,
): boolean {
  return isDirty && !locks.backgroundSaveActive
}

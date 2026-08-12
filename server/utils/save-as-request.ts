import type {
  PlaylistTrack,
  SaveAsSourceReference,
} from '../../shared/myo-editor/types.ts'
import {
  parseMutateCardRequest,
  type CardMutation,
} from '../../shared/yoto/cardMutation.ts'
import { parseDraftTrackIconPlaylist } from '../../shared/myo-editor/draftTrackIconAssignment.ts'

type RawRecord = Record<string, unknown>

export interface ParsedCreateSaveRequest {
  playlist: PlaylistTrack[]
  cardTitle: string
  saveAsSourceReference?: SaveAsSourceReference
  saveAsMutations: CardMutation[]
  acknowledgeCapacityRisk: boolean
}

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseSourceReference(value: unknown): SaveAsSourceReference | undefined {
  if (value === undefined) return undefined
  if (
    !isRecord(value)
    || typeof value.cardId !== 'string'
    || !value.cardId.trim()
    || typeof value.expectedRevision !== 'string'
    || !value.expectedRevision.trim()
  ) {
    throw new Error('The Save As source reference is malformed. Reload the card and try again.')
  }
  return {
    cardId: value.cardId.trim(),
    expectedRevision: value.expectedRevision.trim(),
  }
}

function sanitizeClientDraftTrack(value: unknown, saveAsDraft: boolean): PlaylistTrack {
  if (!isRecord(value)) return value as PlaylistTrack
  const sanitized = { ...value }
  delete sanitized.yotoReuse
  if (!saveAsDraft) {
    delete sanitized.chapterKey
    delete sanitized.trackKey
    delete sanitized.rawIconState
    delete sanitized.chapterRawIconState
    delete sanitized.chapterTrackCount
    delete sanitized.chapterDisplay
    delete sanitized.display
  }
  return sanitized as unknown as PlaylistTrack
}

export function parseCreateSaveRequest(value: unknown): ParsedCreateSaveRequest {
  const body = isRecord(value) ? value : {}
  if (Object.hasOwn(body, 'saveAsSource')) {
    throw new Error('Raw Save As source documents are not accepted.')
  }

  const saveAsSourceReference = parseSourceReference(body.saveAsSourceReference)
  let saveAsMutations: CardMutation[] = []
  if (body.saveAsMutations !== undefined) {
    if (!saveAsSourceReference) {
      throw new Error('Save As mutations require a source reference.')
    }
    if (!Array.isArray(body.saveAsMutations)) {
      throw new Error('The Save As mutations are malformed.')
    }
    if (body.saveAsMutations.length > 0) {
      saveAsMutations = parseMutateCardRequest({
        expectedRevision: saveAsSourceReference.expectedRevision,
        mutations: body.saveAsMutations,
      }).mutations
    }
  }

  const rawPlaylist = Array.isArray(body.playlist) ? body.playlist : []
  const saveAsDraft = Boolean(saveAsSourceReference)
  const playlist = parseDraftTrackIconPlaylist(
    rawPlaylist.map(value => sanitizeClientDraftTrack(value, saveAsDraft)),
    { saveAsDraft },
  )
  return {
    playlist,
    cardTitle: typeof body.cardTitle === 'string' ? body.cardTitle.trim() : '',
    ...(saveAsSourceReference ? { saveAsSourceReference } : {}),
    saveAsMutations,
    acknowledgeCapacityRisk: body.acknowledgeCapacityRisk === true,
  }
}

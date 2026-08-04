import {
  parseDeleteCardRequest,
  type DeleteCardRequest,
} from '../../shared/yoto/cardDeletion.ts'
import {
  deriveRawCardRevision,
  unwrapRawYotoCard,
  type RawYotoCard,
} from './yoto-card-raw-contract.ts'

export type CardDeletionErrorKind = 'invalid' | 'not-found' | 'conflict' | 'upstream'

export class CardDeletionError extends Error {
  readonly kind: CardDeletionErrorKind
  readonly outcomeUncertain: boolean

  constructor(kind: CardDeletionErrorKind, message: string, outcomeUncertain = false) {
    super(message)
    this.name = 'CardDeletionError'
    this.kind = kind
    this.outcomeUncertain = outcomeUncertain
  }
}

export interface CardDeletionDependencies {
  fetchOwnedCards: (accessToken: string) => Promise<unknown>
  fetchCard: (cardId: string, accessToken: string) => Promise<unknown>
  deleteCard: (cardId: string, accessToken: string) => Promise<unknown>
}

const defaultDependencies: CardDeletionDependencies = {
  async fetchOwnedCards(accessToken) {
    const { fetchYotoApi } = await import('./yoto')
    return fetchYotoApi<unknown>('/content/mine', accessToken)
  },
  async fetchCard(cardId, accessToken) {
    const { fetchYotoApi } = await import('./yoto')
    return fetchYotoApi<unknown>(`/content/${encodeURIComponent(cardId)}`, accessToken)
  },
  async deleteCard(cardId, accessToken) {
    const { fetchYotoApi } = await import('./yoto')
    return fetchYotoApi<unknown>(`/content/${encodeURIComponent(cardId)}`, accessToken, { method: 'DELETE' })
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function statusCodeOf(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode
}

async function fetchPreflight(
  operation: () => Promise<unknown>,
  notFoundIsMissing = false,
): Promise<unknown> {
  try {
    return await operation()
  }
  catch (error) {
    const statusCode = statusCodeOf(error)
    if (statusCode === 401 || statusCode === 403) throw error
    if (notFoundIsMissing && statusCode === 404) {
      throw new CardDeletionError('not-found', 'Playlist not found.')
    }
    throw new CardDeletionError('upstream', 'Yoto could not verify this playlist.')
  }
}

function requireExactOwnedCard(value: unknown, cardId: string) {
  if (!isRecord(value) || !Array.isArray(value.cards)) {
    throw new CardDeletionError('upstream', 'Yoto returned a malformed card list.')
  }

  const activeMatches: Record<string, unknown>[] = []
  let deletedMatch = false
  for (const candidate of value.cards) {
    if (
      !isRecord(candidate)
      || typeof candidate.cardId !== 'string'
      || (candidate.deleted !== undefined && typeof candidate.deleted !== 'boolean')
    ) {
      throw new CardDeletionError('upstream', 'Yoto returned a malformed card identity.')
    }
    if (candidate.cardId !== cardId) continue
    if (candidate.deleted === true) deletedMatch = true
    else activeMatches.push(candidate)
  }

  if (activeMatches.length === 0) {
    void deletedMatch
    throw new CardDeletionError('not-found', 'Playlist not found.')
  }
  if (activeMatches.length !== 1) {
    throw new CardDeletionError('upstream', 'Yoto returned a malformed card identity.')
  }
}

function requireDeletionDetail(
  value: unknown,
  cardId: string,
  request: DeleteCardRequest,
): RawYotoCard {
  let rawCard: RawYotoCard
  try {
    rawCard = unwrapRawYotoCard(value)
  }
  catch {
    throw new CardDeletionError('upstream', 'Yoto returned a malformed card.')
  }

  if (typeof rawCard.cardId !== 'string' || rawCard.cardId !== cardId) {
    throw new CardDeletionError('upstream', 'Yoto returned the wrong card identity.')
  }
  if (rawCard.deleted !== undefined && typeof rawCard.deleted !== 'boolean') {
    throw new CardDeletionError('upstream', 'Yoto returned a malformed deletion state.')
  }
  if (rawCard.deleted === true) {
    throw new CardDeletionError('not-found', 'Playlist not found.')
  }
  if (typeof rawCard.title !== 'string') {
    throw new CardDeletionError('upstream', 'Yoto returned a malformed card title.')
  }
  if (rawCard.title !== request.expectedTitle) {
    throw new CardDeletionError('conflict', 'The playlist title changed after it was loaded.')
  }
  let revision: string
  try {
    revision = deriveRawCardRevision(rawCard)
  }
  catch {
    throw new CardDeletionError('upstream', 'Yoto returned a malformed card.')
  }
  if (revision !== request.expectedRevision) {
    throw new CardDeletionError('conflict', 'The playlist changed after it was loaded.')
  }

  if (rawCard.metadata !== undefined && !isRecord(rawCard.metadata)) {
    throw new CardDeletionError('upstream', 'Yoto returned malformed card metadata.')
  }
  const feedUrl = (rawCard.metadata as Record<string, unknown> | undefined)?.feedUrl
  if (feedUrl !== undefined && feedUrl !== null && typeof feedUrl !== 'string') {
    throw new CardDeletionError('upstream', 'Yoto returned malformed podcast metadata.')
  }
  if (typeof feedUrl === 'string' && feedUrl.trim()) {
    throw new CardDeletionError('invalid', 'Podcast cards cannot be deleted.')
  }
  return rawCard
}

export function cardDeletionStatusCode(error: CardDeletionError): 400 | 404 | 409 | 502 {
  if (error.kind === 'invalid') return 400
  if (error.kind === 'not-found') return 404
  if (error.kind === 'conflict') return 409
  return 502
}

export function validateDeletionCardId(cardId: unknown): string {
  if (typeof cardId !== 'string' || !cardId || cardId.trim() !== cardId) {
    throw new CardDeletionError('invalid', 'cardId is malformed.')
  }
  return cardId
}

export async function deleteYotoCard(
  cardIdValue: unknown,
  requestValue: unknown,
  accessToken: string,
  dependencies: CardDeletionDependencies = defaultDependencies,
): Promise<{ status: 'ok'; cardId: string }> {
  const cardId = validateDeletionCardId(cardIdValue)
  let request: DeleteCardRequest
  try {
    request = parseDeleteCardRequest(requestValue)
  }
  catch (error) {
    throw new CardDeletionError(
      'invalid',
      error instanceof Error ? error.message : 'The deletion request is malformed.',
    )
  }

  const owned = await fetchPreflight(() => dependencies.fetchOwnedCards(accessToken))
  requireExactOwnedCard(owned, cardId)

  const detail = await fetchPreflight(
    () => dependencies.fetchCard(cardId, accessToken),
    true,
  )
  requireDeletionDetail(detail, cardId, request)

  let response: unknown
  try {
    response = await dependencies.deleteCard(cardId, accessToken)
  }
  catch {
    throw new CardDeletionError(
      'upstream',
      'Yoto did not confirm playlist deletion.',
      true,
    )
  }
  if (!isRecord(response) || response.status !== 'ok') {
    throw new CardDeletionError(
      'upstream',
      'Yoto did not confirm playlist deletion.',
      true,
    )
  }

  return { status: 'ok', cardId }
}

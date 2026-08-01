export const MAX_CARD_TITLE_LENGTH = 140

export type RenameCardMutation = {
  kind: 'rename-card'
  expectedTitle: string
  title: string
}

export interface MutateCardRequest {
  expectedRevision: string
  mutations: [RenameCardMutation]
}

export type ExistingCardChanges = {
  titleDirty: boolean
  playlistDirty: boolean
  isDirty: boolean
  titleOnly: boolean
}

export type CardMutationErrorKind = 'invalid' | 'conflict' | 'unsupported'

export class CardMutationError extends Error {
  readonly kind: CardMutationErrorKind

  constructor(
    kind: CardMutationErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'CardMutationError'
    this.kind = kind
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeCardTitle(title: string): string {
  return title.trim()
}

export function getCardTitleValidationError(title: string): string | null {
  const normalized = normalizeCardTitle(title)
  if (!normalized) return 'Give this playlist a title.'
  if (normalized.length > MAX_CARD_TITLE_LENGTH) {
    return `Playlist titles must be ${MAX_CARD_TITLE_LENGTH} characters or fewer.`
  }
  return null
}

export function classifyExistingCardChanges(
  title: string,
  baselineTitle: string,
  playlistDirty: boolean,
): ExistingCardChanges {
  const titleDirty = normalizeCardTitle(title) !== baselineTitle
  return {
    titleDirty,
    playlistDirty,
    isDirty: titleDirty || playlistDirty,
    titleOnly: titleDirty && !playlistDirty,
  }
}

export function resetCardTitle(isNewPlaylist: boolean, baselineTitle: string): string {
  return isNewPlaylist ? '' : baselineTitle
}

export function cardMutationStatusCode(error: CardMutationError): 400 | 409 {
  return error.kind === 'conflict' ? 409 : 400
}

export function parseMutateCardRequest(value: unknown): MutateCardRequest {
  if (!isRecord(value) || typeof value.expectedRevision !== 'string' || !value.expectedRevision) {
    throw new CardMutationError('invalid', 'expectedRevision is required.')
  }
  if (!Array.isArray(value.mutations) || value.mutations.length !== 1) {
    throw new CardMutationError('invalid', 'Exactly one rename-card mutation is required.')
  }

  const mutation = value.mutations[0]
  if (
    !isRecord(mutation)
    || mutation.kind !== 'rename-card'
    || typeof mutation.expectedTitle !== 'string'
    || typeof mutation.title !== 'string'
  ) {
    throw new CardMutationError('invalid', 'The rename-card mutation is malformed.')
  }

  const titleError = getCardTitleValidationError(mutation.title)
  if (titleError) throw new CardMutationError('invalid', titleError)

  return {
    expectedRevision: value.expectedRevision,
    mutations: [{
      kind: 'rename-card',
      expectedTitle: mutation.expectedTitle,
      title: normalizeCardTitle(mutation.title),
    }],
  }
}

export function applyRenameCardMutation(
  rawCard: Record<string, unknown>,
  mutation: RenameCardMutation,
): Record<string, unknown> {
  if (typeof rawCard.title !== 'string') {
    throw new CardMutationError('invalid', 'The Yoto card is missing its title.')
  }
  if (rawCard.metadata !== undefined && !isRecord(rawCard.metadata)) {
    throw new CardMutationError('invalid', 'The Yoto card metadata is malformed.')
  }

  const metadata = rawCard.metadata as Record<string, unknown> | undefined
  if (metadata?.title !== undefined && typeof metadata.title !== 'string') {
    throw new CardMutationError('invalid', 'The Yoto card metadata.title is malformed.')
  }
  if (
    rawCard.title !== mutation.expectedTitle
    || (typeof metadata?.title === 'string' && metadata.title !== mutation.expectedTitle)
  ) {
    throw new CardMutationError('conflict', 'The card title changed after it was loaded.')
  }
  if (typeof metadata?.feedUrl === 'string' && metadata.feedUrl.trim()) {
    throw new CardMutationError('unsupported', 'Podcast cards cannot be edited yet.')
  }

  const titleError = getCardTitleValidationError(mutation.title)
  if (titleError) throw new CardMutationError('invalid', titleError)

  const renamed = {
    ...rawCard,
    title: normalizeCardTitle(mutation.title),
  }

  if (typeof metadata?.title !== 'string') return renamed

  return {
    ...renamed,
    metadata: {
      ...metadata,
      title: normalizeCardTitle(mutation.title),
    },
  }
}

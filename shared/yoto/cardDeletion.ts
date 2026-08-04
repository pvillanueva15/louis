export const UNCERTAIN_CARD_DELETION_MESSAGE
  = 'Could not confirm whether Yoto deleted this playlist. Check My Cards before trying again.'

const RAW_CARD_REVISION_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/

export interface DeleteCardRequest {
  expectedRevision: string
  expectedTitle: string
}

export interface CardDeletionTarget {
  readonly cardId: string
  readonly baselineTitle: string
  readonly revision: string
}

export interface CardDeletionAvailability {
  selectedCardId: string | null
  isNewPlaylist: boolean
  isPodcast: boolean
  baselineTitle: string
  revision: string
  isDirty: boolean
  loading: boolean
  saveJobActive: boolean
  mutationActive: boolean
  deletionActive: boolean
  pollingOrHydrating: boolean
  persistedSaveActive: boolean
  outcomeUncertain: boolean
}

export interface CardDeletionFailure {
  message: string
  outcomeUncertain: boolean
}

export interface CardDeletionClientHandlers {
  onValidatedSuccess: (target: CardDeletionTarget) => void
  onFailure: (failure: CardDeletionFailure) => void
}

export interface CardDeletionFocusTarget {
  readonly isConnected: boolean
  readonly tabIndex: number
  matches: (selector: string) => boolean
  focus: () => void
}

interface FetchErrorLike {
  statusCode?: number
  statusMessage?: string
  message?: string
  data?: {
    statusMessage?: string
    outcomeUncertain?: boolean
    data?: { outcomeUncertain?: boolean }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function parseDeleteCardRequest(value: unknown): DeleteCardRequest {
  if (!isRecord(value)) throw new Error('The deletion request is malformed.')
  if (Object.keys(value).some(key => key !== 'expectedRevision' && key !== 'expectedTitle')) {
    throw new Error('The deletion request is malformed.')
  }
  if (
    typeof value.expectedRevision !== 'string'
    || !RAW_CARD_REVISION_PATTERN.test(value.expectedRevision)
  ) {
    throw new Error('expectedRevision is malformed.')
  }
  if (typeof value.expectedTitle !== 'string') {
    throw new Error('expectedTitle is required.')
  }
  return {
    expectedRevision: value.expectedRevision,
    expectedTitle: value.expectedTitle,
  }
}

export function isCardDeletionAvailable(state: CardDeletionAvailability): boolean {
  return Boolean(
    state.selectedCardId
    && !state.isNewPlaylist
    && !state.isPodcast
    && state.baselineTitle
    && RAW_CARD_REVISION_PATTERN.test(state.revision)
    && !state.isDirty
    && !state.loading
    && !state.saveJobActive
    && !state.mutationActive
    && !state.deletionActive
    && !state.pollingOrHydrating
    && !state.persistedSaveActive
    && !state.outcomeUncertain,
  )
}

export function captureCardDeletionTarget(
  state: CardDeletionAvailability,
): Readonly<CardDeletionTarget> | null {
  if (!isCardDeletionAvailable(state) || !state.selectedCardId) return null
  return Object.freeze({
    cardId: state.selectedCardId,
    baselineTitle: state.baselineTitle,
    revision: state.revision,
  })
}

export function isCardDeletionTargetCurrent(
  target: CardDeletionTarget,
  state: CardDeletionAvailability,
): boolean {
  return isCardDeletionAvailable(state)
    && state.selectedCardId === target.cardId
    && state.baselineTitle === target.baselineTitle
    && state.revision === target.revision
}

export function isExactCardTitleConfirmation(
  enteredTitle: string,
  target: CardDeletionTarget,
): boolean {
  return enteredTitle === target.baselineTitle
}

export function classifyCardDeletionFailure(error: unknown): CardDeletionFailure {
  const fetchError = error as FetchErrorLike
  const explicitUncertain = fetchError.data?.outcomeUncertain
    ?? fetchError.data?.data?.outcomeUncertain
  const statusCode = fetchError.statusCode
  const safeStatus = statusCode === 400
    || statusCode === 401
    || statusCode === 403
    || statusCode === 404
    || statusCode === 409
  const outcomeUncertain = explicitUncertain ?? !safeStatus

  if (outcomeUncertain) {
    return { message: UNCERTAIN_CARD_DELETION_MESSAGE, outcomeUncertain: true }
  }

  return {
    message: fetchError.data?.statusMessage
      ?? fetchError.statusMessage
      ?? fetchError.message
      ?? 'Failed to delete the playlist.',
    outcomeUncertain: false,
  }
}

export async function runCardDeletionClientAttempt(
  target: CardDeletionTarget,
  request: () => Promise<unknown>,
  handlers: CardDeletionClientHandlers,
): Promise<boolean> {
  let response: unknown
  try {
    response = await request()
    if (
      !isRecord(response)
      || response.status !== 'ok'
      || response.cardId !== target.cardId
    ) {
      throw Object.assign(new Error('Unexpected deletion response.'), { statusCode: 502 })
    }
  }
  catch (error) {
    handlers.onFailure(classifyCardDeletionFailure(error))
    return false
  }

  handlers.onValidatedSuccess(target)
  return true
}

export function resolveCardDeletionTabTarget<T>(
  dialog: T,
  focusable: readonly T[],
  activeElement: unknown,
  shiftKey: boolean,
): T | null {
  if (focusable.length === 0) return dialog
  const first = focusable[0]!
  const last = focusable.at(-1)!
  if (!focusable.includes(activeElement as T)) return shiftKey ? last : first
  if (shiftKey && activeElement === first) return last
  if (!shiftKey && activeElement === last) return first
  return null
}

export function tryRestoreCardDeletionFocus(
  target: CardDeletionFocusTarget | null,
  activeElement: () => unknown,
  allowProgrammaticTarget = false,
): boolean {
  if (
    !target?.isConnected
    || (!allowProgrammaticTarget && target.tabIndex < 0)
    || target.matches(':disabled, [aria-disabled="true"], [hidden], [inert], [inert] *')
  ) return false

  target.focus()
  return activeElement() === target
}

export function restoreCardDeletionFocus(
  primary: CardDeletionFocusTarget | null,
  fallback: CardDeletionFocusTarget | null,
  activeElement: () => unknown,
): boolean {
  return tryRestoreCardDeletionFocus(primary, activeElement)
    || tryRestoreCardDeletionFocus(fallback, activeElement, true)
}

export function removeDeletedCard<T extends { cardId: string }>(cards: T[], cardId: string): T[] {
  return cards.filter(card => card.cardId !== cardId)
}

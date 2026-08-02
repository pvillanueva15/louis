import { PERSONAL_ICON_MEDIA_ID_PATTERN } from './iconContract.ts'

export const MAX_CARD_TITLE_LENGTH = 140
export const MAX_TRACK_ICON_MUTATIONS = 100

export type RenameCardMutation = {
  kind: 'rename-card'
  expectedTitle: string
  title: string
}

export type RawIconState =
  | { kind: 'absent' }
  | { kind: 'present'; value: string | null }

export function mapRawIconState(
  display: { icon16x16?: string | null } | undefined,
): RawIconState {
  if (!display || !Object.hasOwn(display, 'icon16x16')) return { kind: 'absent' }
  return { kind: 'present', value: display.icon16x16 ?? null }
}

export type SetTrackIconMutation = {
  kind: 'set-track-icon'
  chapterKey: string
  trackKey: string
  expectedChapterIcon: RawIconState
  expectedTrackIcon: RawIconState
} & (
  | { mode: 'icon'; mediaId: string }
  | { mode: 'inherit' }
)

export type CardMutation = RenameCardMutation | SetTrackIconMutation

export interface MutateCardRequest {
  expectedRevision: string
  mutations: CardMutation[]
}

export type ExistingCardChanges = {
  titleDirty: boolean
  playlistDirty: boolean
  iconDirty: boolean
  isDirty: boolean
  rawMutationOnly: boolean
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

function requireOpaqueKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CardMutationError('invalid', `${field} is required.`)
  }
  return value
}

function parseRawIconState(value: unknown, field: string): RawIconState {
  if (!isRecord(value)) {
    throw new CardMutationError('invalid', `${field} is malformed.`)
  }
  if (value.kind === 'absent') return { kind: 'absent' }
  if (value.kind === 'present' && (value.value === null || typeof value.value === 'string')) {
    return { kind: 'present', value: value.value as string | null }
  }
  throw new CardMutationError('invalid', `${field} is malformed.`)
}

function parseRenameCardMutation(value: Record<string, unknown>): RenameCardMutation {
  if (typeof value.expectedTitle !== 'string' || typeof value.title !== 'string') {
    throw new CardMutationError('invalid', 'The rename-card mutation is malformed.')
  }

  const titleError = getCardTitleValidationError(value.title)
  if (titleError) throw new CardMutationError('invalid', titleError)

  return {
    kind: 'rename-card',
    expectedTitle: value.expectedTitle,
    title: normalizeCardTitle(value.title),
  }
}

function parseSetTrackIconMutation(value: Record<string, unknown>): SetTrackIconMutation {
  const base = {
    kind: 'set-track-icon' as const,
    chapterKey: requireOpaqueKey(value.chapterKey, 'chapterKey'),
    trackKey: requireOpaqueKey(value.trackKey, 'trackKey'),
    expectedChapterIcon: parseRawIconState(value.expectedChapterIcon, 'expectedChapterIcon'),
    expectedTrackIcon: parseRawIconState(value.expectedTrackIcon, 'expectedTrackIcon'),
  }

  if (value.mode === 'inherit') return { ...base, mode: 'inherit' }
  if (
    value.mode === 'icon'
    && typeof value.mediaId === 'string'
    && PERSONAL_ICON_MEDIA_ID_PATTERN.test(value.mediaId)
  ) {
    return { ...base, mode: 'icon', mediaId: value.mediaId }
  }

  throw new CardMutationError('invalid', 'The set-track-icon mutation is malformed.')
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
  iconDirty = false,
): ExistingCardChanges {
  const titleDirty = normalizeCardTitle(title) !== baselineTitle
  const rawMutationOnly = (titleDirty || iconDirty) && !playlistDirty
  return {
    titleDirty,
    playlistDirty,
    iconDirty,
    isDirty: titleDirty || playlistDirty || iconDirty,
    rawMutationOnly,
    titleOnly: titleDirty && !playlistDirty && !iconDirty,
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
  if (!Array.isArray(value.mutations) || value.mutations.length === 0) {
    throw new CardMutationError('invalid', 'At least one card mutation is required.')
  }

  const mutations: CardMutation[] = []
  const targets = new Set<string>()
  let renameCount = 0
  let iconCount = 0

  for (const candidate of value.mutations) {
    if (!isRecord(candidate)) {
      throw new CardMutationError('invalid', 'The card mutation is malformed.')
    }
    if (candidate.kind === 'rename-card') {
      renameCount += 1
      if (renameCount > 1) {
        throw new CardMutationError('invalid', 'Only one rename-card mutation is allowed.')
      }
      mutations.push(parseRenameCardMutation(candidate))
      continue
    }
    if (candidate.kind === 'set-track-icon') {
      iconCount += 1
      if (iconCount > MAX_TRACK_ICON_MUTATIONS) {
        throw new CardMutationError(
          'invalid',
          `No more than ${MAX_TRACK_ICON_MUTATIONS} track icons can be changed at once.`,
        )
      }
      const mutation = parseSetTrackIconMutation(candidate)
      const target = JSON.stringify([mutation.chapterKey, mutation.trackKey])
      if (targets.has(target)) {
        throw new CardMutationError('invalid', 'Track icon targets must be unique.')
      }
      targets.add(target)
      mutations.push(mutation)
      continue
    }
    throw new CardMutationError('invalid', 'The card mutation kind is unsupported.')
  }

  return { expectedRevision: value.expectedRevision, mutations }
}

function validateCardEnvelope(rawCard: Record<string, unknown>) {
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
  if (typeof metadata?.feedUrl === 'string' && metadata.feedUrl.trim()) {
    throw new CardMutationError('unsupported', 'Podcast cards cannot be edited yet.')
  }
  return metadata
}

export function applyRenameCardMutation(
  rawCard: Record<string, unknown>,
  mutation: RenameCardMutation,
): Record<string, unknown> {
  const metadata = validateCardEnvelope(rawCard)
  if (
    rawCard.title !== mutation.expectedTitle
    || (typeof metadata?.title === 'string' && metadata.title !== mutation.expectedTitle)
  ) {
    throw new CardMutationError('conflict', 'The card title changed after it was loaded.')
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

function readRawIconState(owner: Record<string, unknown>, label: string): RawIconState {
  if (!Object.hasOwn(owner, 'display')) return { kind: 'absent' }
  if (!isRecord(owner.display)) {
    throw new CardMutationError('invalid', `The ${label} display is malformed.`)
  }
  if (!Object.hasOwn(owner.display, 'icon16x16')) return { kind: 'absent' }
  const value = owner.display.icon16x16
  if (value !== null && typeof value !== 'string') {
    throw new CardMutationError('invalid', `The ${label} icon is malformed.`)
  }
  return { kind: 'present', value: value as string | null }
}

function iconStatesEqual(actual: RawIconState, expected: RawIconState): boolean {
  if (actual.kind !== expected.kind) return false
  if (actual.kind === 'absent' || expected.kind === 'absent') return true
  return actual.value === expected.value
}

function replaceIcon(
  owner: Record<string, unknown>,
  icon: string,
  label: string,
): Record<string, unknown> {
  if (owner.display !== undefined && !isRecord(owner.display)) {
    throw new CardMutationError('invalid', `The ${label} display is malformed.`)
  }
  return {
    ...owner,
    display: {
      ...(owner.display as Record<string, unknown> | undefined),
      icon16x16: icon,
    },
  }
}

function removeIcon(
  owner: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  if (!Object.hasOwn(owner, 'display')) return owner
  if (!isRecord(owner.display)) {
    throw new CardMutationError('invalid', `The ${label} display is malformed.`)
  }
  if (!Object.hasOwn(owner.display, 'icon16x16')) return owner

  const display = { ...owner.display }
  delete display.icon16x16
  return { ...owner, display }
}

export function applySetTrackIconMutation(
  rawCard: Record<string, unknown>,
  mutation: SetTrackIconMutation,
): Record<string, unknown> {
  validateCardEnvelope(rawCard)
  if (!isRecord(rawCard.content) || !Array.isArray(rawCard.content.chapters)) {
    throw new CardMutationError('invalid', 'The Yoto card chapters are malformed.')
  }

  const chapterMatches = rawCard.content.chapters
    .map((chapter, index) => ({ chapter, index }))
    .filter(({ chapter }) => isRecord(chapter) && chapter.key === mutation.chapterKey)
  if (chapterMatches.length !== 1) {
    throw new CardMutationError(
      chapterMatches.length === 0 ? 'invalid' : 'conflict',
      chapterMatches.length === 0
        ? 'The selected chapter no longer exists.'
        : 'The selected chapter target is ambiguous.',
    )
  }

  const { chapter: chapterValue, index: chapterIndex } = chapterMatches[0]!
  const chapter = chapterValue as Record<string, unknown>
  if (!Array.isArray(chapter.tracks)) {
    throw new CardMutationError('invalid', 'The selected chapter tracks are malformed.')
  }
  const trackMatches = chapter.tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => isRecord(track) && track.key === mutation.trackKey)
  if (trackMatches.length !== 1) {
    throw new CardMutationError(
      trackMatches.length === 0 ? 'invalid' : 'conflict',
      trackMatches.length === 0
        ? 'The selected track no longer exists.'
        : 'The selected track target is ambiguous.',
    )
  }

  const { track: trackValue, index: trackIndex } = trackMatches[0]!
  const track = trackValue as Record<string, unknown>
  if (!iconStatesEqual(readRawIconState(track, 'track'), mutation.expectedTrackIcon)) {
    throw new CardMutationError('conflict', 'The track icon changed after it was loaded.')
  }

  const oneTrackChapter = chapter.tracks.length === 1
  if (!iconStatesEqual(readRawIconState(chapter, 'chapter'), mutation.expectedChapterIcon)) {
    throw new CardMutationError('conflict', 'The chapter icon changed after it was loaded.')
  }

  const icon = mutation.mode === 'icon' ? `yoto:#${mutation.mediaId}` : null
  const nextTrack = icon === null
    ? removeIcon(track, 'track')
    : replaceIcon(track, icon, 'track')
  const nextTracks = [...chapter.tracks]
  nextTracks[trackIndex] = nextTrack

  const nextChapter = oneTrackChapter && icon !== null
    ? replaceIcon({ ...chapter, tracks: nextTracks }, icon, 'chapter')
    : { ...chapter, tracks: nextTracks }
  const nextChapters = [...rawCard.content.chapters]
  nextChapters[chapterIndex] = nextChapter

  return {
    ...rawCard,
    content: {
      ...rawCard.content,
      chapters: nextChapters,
    },
  }
}

export function applyCardMutations(
  rawCard: Record<string, unknown>,
  mutations: CardMutation[],
): Record<string, unknown> {
  validateCardEnvelope(rawCard)
  return mutations.reduce(
    (card, mutation) => mutation.kind === 'rename-card'
      ? applyRenameCardMutation(card, mutation)
      : applySetTrackIconMutation(card, mutation),
    rawCard,
  )
}

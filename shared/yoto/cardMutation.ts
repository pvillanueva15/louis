import { PERSONAL_ICON_MEDIA_ID_PATTERN } from './iconContract.ts'

export const MAX_CARD_TITLE_LENGTH = 140
export const MAX_TRACK_TITLE_LENGTH = 100
export const MAX_TRACK_MUTATION_TARGETS = 100
export const MAX_TRACK_ICON_MUTATIONS = MAX_TRACK_MUTATION_TARGETS

export type RenameCardMutation = {
  kind: 'rename-card'
  expectedTitle: string
  title: string
}

export type RenameTrackMutation = {
  kind: 'rename-track'
  chapterKey: string
  trackKey: string
  expectedTitle: string
  title: string
}

export type RemoveTrackMutation = {
  kind: 'remove-track'
  chapterKey: string
  trackKey: string
  expectedTitle: string
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

export type CardMutation =
  | RenameCardMutation
  | RenameTrackMutation
  | SetTrackIconMutation
  | RemoveTrackMutation

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

function parseTrackTarget(value: Record<string, unknown>) {
  return {
    chapterKey: requireOpaqueKey(value.chapterKey, 'chapterKey'),
    trackKey: requireOpaqueKey(value.trackKey, 'trackKey'),
  }
}

export function normalizeTrackTitle(title: string): string {
  return title.trim()
}

export function getTrackTitleValidationError(title: string): string | null {
  const normalized = normalizeTrackTitle(title)
  if (!normalized) return 'Give this track a title.'
  if (normalized.length > MAX_TRACK_TITLE_LENGTH) {
    return `Track titles must be ${MAX_TRACK_TITLE_LENGTH} characters or fewer.`
  }
  return null
}

function parseRenameTrackMutation(value: Record<string, unknown>): RenameTrackMutation {
  if (typeof value.expectedTitle !== 'string' || typeof value.title !== 'string') {
    throw new CardMutationError('invalid', 'The rename-track mutation is malformed.')
  }
  const titleError = getTrackTitleValidationError(value.title)
  if (titleError) throw new CardMutationError('invalid', titleError)
  return {
    kind: 'rename-track',
    ...parseTrackTarget(value),
    expectedTitle: value.expectedTitle,
    title: normalizeTrackTitle(value.title),
  }
}

function parseRemoveTrackMutation(value: Record<string, unknown>): RemoveTrackMutation {
  if (typeof value.expectedTitle !== 'string') {
    throw new CardMutationError('invalid', 'The remove-track mutation is malformed.')
  }
  return {
    kind: 'remove-track',
    ...parseTrackTarget(value),
    expectedTitle: value.expectedTitle,
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
  trackTitleDirty = false,
  trackRemovalDirty = false,
): ExistingCardChanges {
  const titleDirty = normalizeCardTitle(title) !== baselineTitle
  const rawTrackDirty = trackTitleDirty || trackRemovalDirty
  const rawMutationOnly = (titleDirty || iconDirty || rawTrackDirty) && !playlistDirty
  return {
    titleDirty,
    playlistDirty,
    iconDirty,
    isDirty: titleDirty || playlistDirty || iconDirty || rawTrackDirty,
    rawMutationOnly,
    titleOnly: titleDirty && !playlistDirty && !iconDirty && !rawTrackDirty,
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
  const targetKinds = new Map<string, Set<CardMutation['kind']>>()
  let renameCount = 0

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
    const mutation = candidate.kind === 'rename-track'
      ? parseRenameTrackMutation(candidate)
      : candidate.kind === 'set-track-icon'
        ? parseSetTrackIconMutation(candidate)
        : candidate.kind === 'remove-track'
          ? parseRemoveTrackMutation(candidate)
          : null
    if (!mutation) {
      throw new CardMutationError('invalid', 'The card mutation kind is unsupported.')
    }

    const target = JSON.stringify([mutation.chapterKey, mutation.trackKey])
    const kinds = targetKinds.get(target) ?? new Set<CardMutation['kind']>()
    if (kinds.has(mutation.kind)) {
      const label = mutation.kind === 'set-track-icon' ? 'Track icon' : 'Track'
      throw new CardMutationError('invalid', `${label} targets must be unique.`)
    }
    if (
      mutation.kind === 'remove-track'
        ? kinds.size > 0
        : kinds.has('remove-track')
    ) {
      throw new CardMutationError(
        'invalid',
        'A removed track cannot also be renamed or assigned an icon.',
      )
    }
    kinds.add(mutation.kind)
    targetKinds.set(target, kinds)
    if (targetKinds.size > MAX_TRACK_MUTATION_TARGETS) {
      throw new CardMutationError(
        'invalid',
        `No more than ${MAX_TRACK_MUTATION_TARGETS} tracks can be changed at once.`,
      )
    }
    mutations.push(mutation)
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
      'conflict',
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
      'conflict',
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
  const parsed = parseMutateCardRequest({
    expectedRevision: 'preflight',
    mutations,
  }).mutations
  const metadata = validateCardEnvelope(rawCard)
  if (!isRecord(rawCard.content) || !Array.isArray(rawCard.content.chapters)) {
    throw new CardMutationError('invalid', 'The Yoto card chapters are malformed.')
  }

  type RawTrack = Record<string, unknown>
  type RawChapter = Record<string, unknown> & { tracks: RawTrack[] }
  type ResolvedTrackMutation = {
    mutation: Exclude<CardMutation, RenameCardMutation>
    chapter: RawChapter
    track: RawTrack
    chapterIndex: number
    trackIndex: number
  }

  const chapters = rawCard.content.chapters.map((chapterValue) => {
    if (!isRecord(chapterValue) || typeof chapterValue.key !== 'string') {
      throw new CardMutationError('invalid', 'A Yoto card chapter is malformed.')
    }
    if (typeof chapterValue.title !== 'string' || !Array.isArray(chapterValue.tracks)) {
      throw new CardMutationError('invalid', 'A Yoto card chapter is malformed.')
    }
    const tracks = chapterValue.tracks.map((trackValue) => {
      if (
        !isRecord(trackValue)
        || typeof trackValue.key !== 'string'
        || typeof trackValue.title !== 'string'
      ) {
        throw new CardMutationError('invalid', 'A Yoto card track is malformed.')
      }
      return trackValue
    })
    return { ...chapterValue, tracks } as RawChapter
  })

  const renameCard = parsed.find(
    (mutation): mutation is RenameCardMutation => mutation.kind === 'rename-card',
  )
  if (renameCard && (
    rawCard.title !== renameCard.expectedTitle
    || (typeof metadata?.title === 'string' && metadata.title !== renameCard.expectedTitle)
  )) {
    throw new CardMutationError('conflict', 'The card title changed after it was loaded.')
  }

  const resolved: ResolvedTrackMutation[] = []
  for (const mutation of parsed) {
    if (mutation.kind === 'rename-card') continue
    const chapterMatches = chapters
      .map((chapter, chapterIndex) => ({ chapter, chapterIndex }))
      .filter(({ chapter }) => chapter.key === mutation.chapterKey)
    if (chapterMatches.length !== 1) {
      throw new CardMutationError(
        'conflict',
        chapterMatches.length === 0
          ? 'The selected chapter no longer exists.'
          : 'The selected chapter target is ambiguous.',
      )
    }
    const { chapter, chapterIndex } = chapterMatches[0]!
    const trackMatches = chapter.tracks
      .map((track, trackIndex) => ({ track, trackIndex }))
      .filter(({ track }) => track.key === mutation.trackKey)
    if (trackMatches.length !== 1) {
      throw new CardMutationError(
        'conflict',
        trackMatches.length === 0
          ? 'The selected track no longer exists.'
          : 'The selected track target is ambiguous.',
      )
    }
    const target = { mutation, chapter, chapterIndex, ...trackMatches[0]! }
    if (
      (mutation.kind === 'rename-track' || mutation.kind === 'remove-track')
      && target.track.title !== mutation.expectedTitle
    ) {
      throw new CardMutationError('conflict', 'The track title changed after it was loaded.')
    }
    if (mutation.kind === 'set-track-icon') {
      if (!iconStatesEqual(readRawIconState(target.track, 'track'), mutation.expectedTrackIcon)) {
        throw new CardMutationError('conflict', 'The track icon changed after it was loaded.')
      }
      if (!iconStatesEqual(readRawIconState(target.chapter, 'chapter'), mutation.expectedChapterIcon)) {
        throw new CardMutationError('conflict', 'The chapter icon changed after it was loaded.')
      }
    }
    resolved.push(target)
  }

  const removals = resolved.filter(
    (target): target is ResolvedTrackMutation & { mutation: RemoveTrackMutation } =>
      target.mutation.kind === 'remove-track',
  )
  const totalTracks = chapters.reduce((total, chapter) => total + chapter.tracks.length, 0)
  if (totalTracks - removals.length < 1) {
    throw new CardMutationError('invalid', 'A card must keep at least one track.')
  }

  let next = renameCard ? applyRenameCardMutation(rawCard, renameCard) : rawCard

  const replaceChapter = (
    card: Record<string, unknown>,
    chapterIndex: number,
    chapter: RawChapter,
  ): Record<string, unknown> => {
    const content = card.content as Record<string, unknown> & { chapters: unknown[] }
    const nextChapters = [...content.chapters]
    nextChapters[chapterIndex] = chapter
    return { ...card, content: { ...content, chapters: nextChapters } }
  }

  for (const target of resolved) {
    if (target.mutation.kind !== 'rename-track') continue
    const content = next.content as Record<string, unknown> & { chapters: RawChapter[] }
    const currentChapter = content.chapters[target.chapterIndex]!
    const currentTracks = [...currentChapter.tracks]
    currentTracks[target.trackIndex] = {
      ...currentTracks[target.trackIndex],
      title: target.mutation.title,
    }
    const followsTrackTitle = target.chapter.tracks.length === 1
      && target.chapter.title === target.track.title
    next = replaceChapter(next, target.chapterIndex, {
      ...currentChapter,
      ...(followsTrackTitle ? { title: target.mutation.title } : {}),
      tracks: currentTracks,
    })
  }

  for (const target of resolved) {
    if (target.mutation.kind !== 'set-track-icon') continue
    next = applySetTrackIconMutation(next, target.mutation)
  }

  const removalsByChapter = new Map<number, number[]>()
  for (const target of removals) {
    const indexes = removalsByChapter.get(target.chapterIndex) ?? []
    indexes.push(target.trackIndex)
    removalsByChapter.set(target.chapterIndex, indexes)
  }
  if (removalsByChapter.size > 0) {
    const content = next.content as Record<string, unknown> & { chapters: RawChapter[] }
    const nextChapters = [...content.chapters]
    for (const [chapterIndex, trackIndexes] of [...removalsByChapter.entries()]
      .sort(([left], [right]) => right - left)) {
      const chapter = nextChapters[chapterIndex]!
      const tracks = [...chapter.tracks]
      for (const trackIndex of trackIndexes.sort((left, right) => right - left)) {
        tracks.splice(trackIndex, 1)
      }
      if (tracks.length === 0) nextChapters.splice(chapterIndex, 1)
      else nextChapters[chapterIndex] = { ...chapter, tracks }
    }
    next = { ...next, content: { ...content, chapters: nextChapters } }
  }

  return next
}

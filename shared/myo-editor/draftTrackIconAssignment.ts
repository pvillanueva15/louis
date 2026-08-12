import type { PersonalIcon } from '../yoto/iconContract.ts'
import { PERSONAL_ICON_MEDIA_ID_PATTERN } from '../yoto/iconContract.ts'
import type { RawIconState } from '../yoto/cardMutation.ts'
import type { EffectiveTrackIcon } from './trackIconAssignment.ts'
import type { DraftTrackIconChoice, PlaylistTrack } from './types.ts'

const DRAFT_TRACK_ID_PATTERN
  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export interface RapidDraftTrackIconAdvance {
  target: string
  completed: boolean
}

export interface RapidDraftTrackIconSelectionGate {
  loading: boolean
  locked: boolean
  yotoBlocked: boolean
  manageable: boolean
}

export interface IconAssignmentModalLockInput {
  operationBusy: boolean
  selectionUnavailable: boolean
  recoveryRequired: boolean
}

export function resolveIconAssignmentModalLocks(
  input: IconAssignmentModalLockInput,
): { dismissalBlocked: boolean; selectionBlocked: boolean } {
  return {
    dismissalBlocked: input.operationBusy,
    selectionBlocked: input.operationBusy
      || input.selectionUnavailable
      || input.recoveryRequired,
  }
}

function stateString(state: RawIconState | undefined): string | null {
  return state?.kind === 'present' && typeof state.value === 'string'
    ? state.value
    : null
}

function hasPresentNull(state: RawIconState | undefined): boolean {
  return state?.kind === 'present' && state.value === null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}

export function createDraftTrackId(): string {
  return crypto.randomUUID()
}

export function isDraftTrackId(value: unknown): value is string {
  return typeof value === 'string' && DRAFT_TRACK_ID_PATTERN.test(value)
}

export function assignFreshDraftTrackIds(playlist: PlaylistTrack[]): PlaylistTrack[] {
  return playlist.map(track => ({
    ...structuredClone(track),
    draftTrackId: createDraftTrackId(),
    draftIcon: undefined,
  }))
}

export function parseDraftTrackIconChoice(value: unknown): DraftTrackIconChoice | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('A draft track icon choice is malformed.')

  if (value.mode === 'icon') {
    if (
      !hasExactKeys(value, ['mediaId', 'mode'])
      || typeof value.mediaId !== 'string'
      || !PERSONAL_ICON_MEDIA_ID_PATTERN.test(value.mediaId)
    ) throw new Error('A draft track icon choice is malformed.')
    return { mode: 'icon', mediaId: value.mediaId }
  }
  if (value.mode === 'none' && hasExactKeys(value, ['mode'])) return { mode: 'none' }
  if (value.mode === 'chapter' && hasExactKeys(value, ['mode'])) return { mode: 'chapter' }
  throw new Error('A draft track icon choice is malformed.')
}

export function parseDraftTrackIconPlaylist(
  playlist: unknown[],
  options: { saveAsDraft: boolean },
): PlaylistTrack[] {
  const seen = new Set<string>()
  return playlist.map((value) => {
    if (!isRecord(value)) throw new Error('A draft track is missing its local identity.')
    const track = value as unknown as PlaylistTrack
    if (!isDraftTrackId(track.draftTrackId)) {
      throw new Error('A draft track is missing its local identity.')
    }
    if (seen.has(track.draftTrackId)) {
      throw new Error('The draft contains duplicate local track identities.')
    }
    seen.add(track.draftTrackId)

    const draftIcon = parseDraftTrackIconChoice(track.draftIcon)
    if (
      draftIcon?.mode === 'chapter'
      && (
        !options.saveAsDraft
        || typeof track.chapterKey !== 'string'
        || !track.chapterKey
        || typeof track.trackKey !== 'string'
        || !track.trackKey
      )
    ) {
      throw new Error('Use chapter icon is only available for retained Save As tracks.')
    }

    return {
      ...track,
      draftTrackId: track.draftTrackId,
      ...(draftIcon ? { draftIcon } : { draftIcon: undefined }),
    }
  })
}

export function eligibleDraftTrackIconTargets(playlist: PlaylistTrack[]): string[] {
  return playlist.flatMap(track => isDraftTrackId(track.draftTrackId) ? [track.draftTrackId] : [])
}

export function draftTrackIconTargetIndex(targets: string[], target: string | null): number {
  return target ? targets.indexOf(target) : -1
}

export function resolveDraftTrackIconTarget(
  playlist: PlaylistTrack[],
  target: string | null,
): PlaylistTrack | null {
  if (!target) return null
  return playlist.find(track => track.draftTrackId === target) ?? null
}

export function rehomeDraftTrackIconTarget(targets: string[], target: string | null): string | null {
  const index = draftTrackIconTargetIndex(targets, target)
  return index >= 0 ? targets[index]! : targets[0] ?? null
}

export function moveDraftTrackIconTarget(
  targets: string[],
  target: string | null,
  offset: -1 | 1,
): string | null {
  const index = draftTrackIconTargetIndex(targets, target)
  if (index < 0) return targets[0] ?? null
  return targets[Math.max(0, Math.min(targets.length - 1, index + offset))] ?? null
}

export function advanceRapidDraftTrackIconAssignment(
  targets: string[],
  target: string | null,
): RapidDraftTrackIconAdvance | null {
  const index = draftTrackIconTargetIndex(targets, target)
  if (index < 0) return null
  if (index === targets.length - 1) return { target: targets[index]!, completed: true }
  return { target: targets[index + 1]!, completed: false }
}

export function canStageRapidDraftTrackIconSelection(
  targets: string[],
  target: string | null,
  track: PlaylistTrack | null,
  gate: RapidDraftTrackIconSelectionGate,
): boolean {
  return !gate.loading
    && !gate.locked
    && !gate.yotoBlocked
    && gate.manageable
    && Boolean(target && track?.draftTrackId === target && targets.includes(target))
}

export function retainedDraftChapterTrackCount(
  playlist: PlaylistTrack[],
  track: PlaylistTrack,
): number {
  if (!track.chapterKey || !track.trackKey) return 1
  return playlist.filter(item => item.chapterKey === track.chapterKey && item.trackKey).length
}

export function draftIconSecondaryAction(
  playlist: PlaylistTrack[],
  track: PlaylistTrack,
): 'none' | 'chapter' {
  return track.chapterKey && track.trackKey && retainedDraftChapterTrackCount(playlist, track) > 1
    ? 'chapter'
    : 'none'
}

function choiceMatchesBaseline(
  baseline: PlaylistTrack | undefined,
  choice: DraftTrackIconChoice,
  outputTrackCount: number,
): boolean {
  if (!baseline) return choice.mode === 'none'
  const retained = Boolean(baseline.chapterKey && baseline.trackKey)

  if (choice.mode === 'chapter') {
    return retained && baseline.rawIconState?.kind === 'absent'
  }
  if (choice.mode === 'none') {
    return outputTrackCount === 1 && (
      !retained
      || (hasPresentNull(baseline.rawIconState) && hasPresentNull(baseline.chapterRawIconState))
    )
  }

  const reference = `yoto:#${choice.mediaId}`
  if (stateString(baseline.rawIconState) !== reference) return false
  return outputTrackCount > 1 || stateString(baseline.chapterRawIconState) === reference
}

export function stageDraftTrackIconChoice(
  playlist: PlaylistTrack[],
  baseline: PlaylistTrack[],
  draftTrackId: string,
  choice: DraftTrackIconChoice,
): PlaylistTrack[] {
  const target = playlist.find(track => track.draftTrackId === draftTrackId)
  if (!target || !isDraftTrackId(draftTrackId)) return playlist
  if (choice.mode === 'chapter' && (!target.chapterKey || !target.trackKey)) return playlist
  if (choice.mode === 'none' && retainedDraftChapterTrackCount(playlist, target) > 1) return playlist

  const baselineTrack = baseline.find(track => track.draftTrackId === draftTrackId)
  const draftIcon = choiceMatchesBaseline(
    baselineTrack,
    choice,
    retainedDraftChapterTrackCount(playlist, target),
  ) ? undefined : structuredClone(choice)

  return playlist.map(track => track.draftTrackId === draftTrackId
    ? { ...track, draftIcon }
    : track)
}

export function effectiveDraftTrackIcon(track: PlaylistTrack): EffectiveTrackIcon {
  if (track.draftIcon?.mode === 'icon') {
    return {
      reference: `yoto:#${track.draftIcon.mediaId}`,
      source: 'track',
      previewUrl: null,
    }
  }
  if (track.draftIcon?.mode === 'none') {
    return { reference: null, source: 'none', previewUrl: null }
  }

  const trackIcon = track.draftIcon?.mode === 'chapter'
    ? null
    : stateString(track.rawIconState) ?? track.yotoReuse?.display?.icon16x16 ?? null
  if (trackIcon) return { reference: trackIcon, source: 'track', previewUrl: null }

  const chapterIcon = stateString(track.chapterRawIconState)
    ?? track.chapterDisplay?.icon16x16
    ?? null
  if (chapterIcon) return { reference: chapterIcon, source: 'chapter', previewUrl: null }
  return { reference: null, source: 'none', previewUrl: null }
}

export function resolveDraftTrackIconPreview(
  effective: EffectiveTrackIcon,
  personalIcons: PersonalIcon[],
): EffectiveTrackIcon {
  if (effective.previewUrl || !effective.reference) return effective
  if (effective.reference.startsWith('https://')) {
    return { ...effective, previewUrl: effective.reference }
  }
  if (!effective.reference.startsWith('yoto:#')) return effective
  const mediaId = effective.reference.slice('yoto:#'.length)
  const icon = personalIcons.find(item => item.mediaId === mediaId)
  return icon?.url ? { ...effective, previewUrl: icon.url } : effective
}

import type { PlaylistTrack } from './types.ts'
import type { PersonalIcon } from '../yoto/iconContract.ts'
import type {
  RawIconState,
  SetTrackIconMutation,
} from '../yoto/cardMutation.ts'

export const STRUCTURAL_ICON_MIX_MESSAGE =
  'Reset either the track icon changes or the added, removed, or reordered tracks before updating. Louis cannot safely save both together yet.'

export type TrackIconSelection =
  | { mode: 'icon'; mediaId: string; previewUrl?: string | null }
  | { mode: 'inherit' }

export interface StagedTrackIconAssignment {
  mutation: SetTrackIconMutation
  previewUrl: string | null
}

export interface EffectiveTrackIcon {
  reference: string | null
  source: 'track' | 'chapter' | 'none'
  previewUrl: string | null
}

export type PersonalIconLibraryStatus = 'idle' | 'loading' | 'error' | 'ready'

export interface TrackIconPreviewLoadState {
  cardId: string | null
  isPodcast: boolean
  yotoConnected: boolean
  yotoStatus: string
  libraryStatus: PersonalIconLibraryStatus
}

export interface TrackIconTarget {
  chapterKey: string
  trackKey: string
}

export interface RapidTrackIconAdvance {
  target: TrackIconTarget
  completed: boolean
}

export interface RapidTrackIconSelectionGate {
  loading: boolean
  locked: boolean
  yotoBlocked: boolean
  manageable: boolean
}

export function trackIconTargetKey(chapterKey: string, trackKey: string): string {
  return JSON.stringify([chapterKey, trackKey])
}

function stateString(state: RawIconState | undefined): string | null {
  return state?.kind === 'present' && typeof state.value === 'string'
    ? state.value
    : null
}

export function canAssignTrackIcon(track: PlaylistTrack): boolean {
  return Boolean(
    track.chapterKey
    && track.trackKey
    && track.rawIconState
    && track.chapterRawIconState
    && track.chapterTrackCount
    && track.chapterTrackCount > 0,
  )
}

export function eligibleTrackIconTargets(
  playlist: PlaylistTrack[],
): TrackIconTarget[] {
  return playlist
    .filter(canAssignTrackIcon)
    .map(track => ({
      chapterKey: track.chapterKey!,
      trackKey: track.trackKey!,
    }))
}

export function trackIconTargetIndex(
  targets: TrackIconTarget[],
  target: TrackIconTarget | null,
): number {
  if (!target) return -1
  const key = trackIconTargetKey(target.chapterKey, target.trackKey)
  return targets.findIndex(item =>
    trackIconTargetKey(item.chapterKey, item.trackKey) === key,
  )
}

export function rehomeTrackIconTarget(
  targets: TrackIconTarget[],
  target: TrackIconTarget | null,
): TrackIconTarget | null {
  const index = trackIconTargetIndex(targets, target)
  return index >= 0 ? targets[index]! : targets[0] ?? null
}

export function canStageRapidTrackIconSelection(
  targets: TrackIconTarget[],
  target: TrackIconTarget | null,
  track: PlaylistTrack | null,
  gate: RapidTrackIconSelectionGate,
): boolean {
  if (
    gate.loading
    || gate.locked
    || gate.yotoBlocked
    || !gate.manageable
    || !target
    || !track
    || !canAssignTrackIcon(track)
    || trackIconTargetIndex(targets, target) < 0
  ) return false

  return track.chapterKey === target.chapterKey && track.trackKey === target.trackKey
}

export function resolveTrackIconTarget(
  playlist: PlaylistTrack[],
  target: TrackIconTarget | null,
): PlaylistTrack | null {
  if (!target) return null
  return playlist.find(track =>
    track.chapterKey === target.chapterKey && track.trackKey === target.trackKey,
  ) ?? null
}

export function moveTrackIconTarget(
  targets: TrackIconTarget[],
  target: TrackIconTarget | null,
  offset: -1 | 1,
): TrackIconTarget | null {
  const index = trackIconTargetIndex(targets, target)
  if (index < 0) return targets[0] ?? null
  return targets[Math.max(0, Math.min(targets.length - 1, index + offset))] ?? null
}

export function advanceRapidTrackIconAssignment(
  targets: TrackIconTarget[],
  target: TrackIconTarget | null,
): RapidTrackIconAdvance | null {
  const index = trackIconTargetIndex(targets, target)
  if (index < 0) return null
  if (index === targets.length - 1) return { target: targets[index]!, completed: true }
  return { target: targets[index + 1]!, completed: false }
}

function assignmentMatchesBaseline(
  track: PlaylistTrack,
  selection: TrackIconSelection,
): boolean {
  if (selection.mode === 'inherit') return track.rawIconState?.kind === 'absent'

  const reference = `yoto:#${selection.mediaId}`
  if (stateString(track.rawIconState) !== reference) return false
  if (track.chapterTrackCount !== 1) return true
  return stateString(track.chapterRawIconState) === reference
}

export function stageTrackIconAssignment(
  assignments: StagedTrackIconAssignment[],
  track: PlaylistTrack,
  selection: TrackIconSelection,
): StagedTrackIconAssignment[] {
  if (!canAssignTrackIcon(track)) return assignments

  const chapterKey = track.chapterKey!
  const trackKey = track.trackKey!
  const target = trackIconTargetKey(chapterKey, trackKey)
  const withoutTarget = assignments.filter(({ mutation }) =>
    trackIconTargetKey(mutation.chapterKey, mutation.trackKey) !== target,
  )
  if (assignmentMatchesBaseline(track, selection)) return withoutTarget

  const expected = {
    kind: 'set-track-icon' as const,
    chapterKey,
    trackKey,
    expectedChapterIcon: track.chapterRawIconState!,
    expectedTrackIcon: track.rawIconState!,
  }
  const mutation: SetTrackIconMutation = selection.mode === 'icon'
    ? { ...expected, mode: 'icon', mediaId: selection.mediaId }
    : { ...expected, mode: 'inherit' }

  return [
    ...withoutTarget,
    {
      mutation,
      previewUrl: selection.mode === 'icon' ? selection.previewUrl ?? null : null,
    },
  ]
}

export function effectiveTrackIcon(
  track: PlaylistTrack,
  assignments: StagedTrackIconAssignment[],
): EffectiveTrackIcon {
  const staged = track.chapterKey && track.trackKey
    ? assignments.find(({ mutation }) =>
        mutation.chapterKey === track.chapterKey && mutation.trackKey === track.trackKey,
      )
    : undefined

  if (staged?.mutation.mode === 'icon') {
    return {
      reference: `yoto:#${staged.mutation.mediaId}`,
      source: 'track',
      previewUrl: staged.previewUrl,
    }
  }

  const trackIcon = staged?.mutation.mode === 'inherit'
    ? null
    : stateString(track.rawIconState)
      ?? track.yotoReuse?.display?.icon16x16
      ?? null
  if (trackIcon) return { reference: trackIcon, source: 'track', previewUrl: null }

  const chapterIcon = stateString(track.chapterRawIconState)
    ?? track.chapterDisplay?.icon16x16
    ?? null
  if (chapterIcon) return { reference: chapterIcon, source: 'chapter', previewUrl: null }
  return { reference: null, source: 'none', previewUrl: null }
}

export function resolveTrackIconPreview(
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

export function shouldLoadTrackIconPreviews(
  state: TrackIconPreviewLoadState,
): boolean {
  if (
    !state.cardId
    || state.isPodcast
    || !state.yotoConnected
    || state.yotoStatus !== 'idle'
    || state.libraryStatus === 'loading'
  ) return false

  return state.libraryStatus === 'idle' || state.libraryStatus === 'error'
}

export function shouldInvalidatePersonalIconCache(
  connected: boolean,
  previouslyConnected: boolean | undefined,
): boolean {
  return previouslyConnected === true && !connected
}

export function toTrackIconMutations(
  assignments: StagedTrackIconAssignment[],
): SetTrackIconMutation[] {
  return assignments.map(({ mutation }) => mutation)
}

export function resetTrackIconAssignments(): StagedTrackIconAssignment[] {
  return []
}

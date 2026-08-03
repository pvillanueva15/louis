import type { PlaylistTrack } from './types.ts'
import type { StagedTrackIconAssignment } from './trackIconAssignment.ts'
import {
  getTrackTitleValidationError,
  normalizeTrackTitle,
  type RemoveTrackMutation,
  type RenameTrackMutation,
} from '../yoto/cardMutation.ts'

export const RAW_STRUCTURAL_MIX_MESSAGE
  = 'Use Reset, then make either raw card changes or added/reordered track changes—not both.'
export const RAW_REMOVAL_STRUCTURAL_MESSAGE
  = 'Undo or Reset the staged track removals before adding or reordering tracks.'

export interface StagedTrackRename {
  mutation: RenameTrackMutation
}

export interface StagedTrackRemoval {
  mutation: RemoveTrackMutation
}

export interface RawTrackUndoToken {
  track: PlaylistTrack
  visibleIndex: number
  rename: StagedTrackRename | null
  icon: StagedTrackIconAssignment | null
}

export interface RemoveRawTrackResult {
  playlist: PlaylistTrack[]
  renames: StagedTrackRename[]
  removals: StagedTrackRemoval[]
  icons: StagedTrackIconAssignment[]
  undo: RawTrackUndoToken
}

export interface UndoRawTrackResult {
  playlist: PlaylistTrack[]
  renames: StagedTrackRename[]
  removals: StagedTrackRemoval[]
  icons: StagedTrackIconAssignment[]
}

export function rawTrackTargetKey(chapterKey: string, trackKey: string): string {
  return JSON.stringify([chapterKey, trackKey])
}

export function hasStableRawTrackIdentity(
  track: Pick<PlaylistTrack, 'chapterKey' | 'trackKey'>,
): boolean {
  return Boolean(
    typeof track.chapterKey === 'string'
    && track.chapterKey.trim()
    && typeof track.trackKey === 'string'
    && track.trackKey.trim(),
  )
}

export function hasUniqueStableRawTrackIdentities(tracks: PlaylistTrack[]): boolean {
  const targets = new Set<string>()
  for (const track of tracks) {
    if (!hasStableRawTrackIdentity(track)) return false
    const target = rawTrackTargetKey(track.chapterKey!, track.trackKey!)
    if (targets.has(target)) return false
    targets.add(target)
  }
  return true
}

export function matchesRawTrackTarget(
  track: Pick<PlaylistTrack, 'chapterKey' | 'trackKey'>,
  chapterKey: string,
  trackKey: string,
): boolean {
  return track.chapterKey === chapterKey && track.trackKey === trackKey
}

function matchesMutationTarget(
  mutation: { chapterKey: string; trackKey: string },
  track: Pick<PlaylistTrack, 'chapterKey' | 'trackKey'>,
): boolean {
  return matchesRawTrackTarget(track, mutation.chapterKey, mutation.trackKey)
}

export function findRawTrackTargetIndex(
  playlist: PlaylistTrack[],
  target: Pick<PlaylistTrack, 'chapterKey' | 'trackKey'>,
): number {
  if (!hasStableRawTrackIdentity(target)) return -1
  return playlist.findIndex(track =>
    matchesRawTrackTarget(track, target.chapterKey!, target.trackKey!),
  )
}

export function replaceRawTrackTitle(
  playlist: PlaylistTrack[],
  target: Pick<PlaylistTrack, 'chapterKey' | 'trackKey'>,
  title: string,
): PlaylistTrack[] {
  return playlist.map(track =>
    matchesRawTrackTarget(track, target.chapterKey!, target.trackKey!)
      ? { ...track, title }
      : track,
  )
}

export function hasRawTrackMutationStages(
  iconDirty: boolean,
  trackTitleDirty: boolean,
  trackRemovalDirty: boolean,
): boolean {
  return iconDirty || trackTitleDirty || trackRemovalDirty
}

export function stageRawTrackTitle(
  renames: StagedTrackRename[],
  track: PlaylistTrack,
  baselineTitle: string,
  title: string,
): { renames: StagedTrackRename[]; title: string; error: string | null } {
  if (!hasStableRawTrackIdentity(track)) {
    return { renames, title: track.title, error: 'Reload this card before editing track titles.' }
  }
  const titleError = getTrackTitleValidationError(title)
  if (titleError) return { renames, title: track.title, error: titleError }

  const normalized = normalizeTrackTitle(title)
  const withoutTarget = renames.filter(({ mutation }) =>
    !matchesMutationTarget(mutation, track),
  )
  if (normalized === baselineTitle) {
    return { renames: withoutTarget, title: baselineTitle, error: null }
  }
  return {
    renames: [
      ...withoutTarget,
      {
        mutation: {
          kind: 'rename-track',
          chapterKey: track.chapterKey!,
          trackKey: track.trackKey!,
          expectedTitle: baselineTitle,
          title: normalized,
        },
      },
    ],
    title: normalized,
    error: null,
  }
}

export function removeRawTrack(
  playlist: PlaylistTrack[],
  visibleIndex: number,
  baselineTitle: string,
  renames: StagedTrackRename[],
  removals: StagedTrackRemoval[],
  icons: StagedTrackIconAssignment[],
): RemoveRawTrackResult | null {
  const track = playlist[visibleIndex]
  if (!track || !hasStableRawTrackIdentity(track) || playlist.length <= 1) return null

  const rename = renames.find(({ mutation }) => matchesMutationTarget(mutation, track)) ?? null
  const icon = icons.find(({ mutation }) => matchesMutationTarget(mutation, track)) ?? null
  const nextPlaylist = [...playlist]
  nextPlaylist.splice(visibleIndex, 1)

  return {
    playlist: nextPlaylist,
    renames: renames.filter(({ mutation }) => !matchesMutationTarget(mutation, track)),
    removals: [
      ...removals.filter(({ mutation }) => !matchesMutationTarget(mutation, track)),
      {
        mutation: {
          kind: 'remove-track',
          chapterKey: track.chapterKey!,
          trackKey: track.trackKey!,
          expectedTitle: baselineTitle,
        },
      },
    ],
    icons: icons.filter(({ mutation }) => !matchesMutationTarget(mutation, track)),
    undo: {
      track: { ...track },
      visibleIndex,
      rename,
      icon,
    },
  }
}

export function undoRawTrackRemoval(
  playlist: PlaylistTrack[],
  renames: StagedTrackRename[],
  removals: StagedTrackRemoval[],
  icons: StagedTrackIconAssignment[],
  undo: RawTrackUndoToken,
): UndoRawTrackResult {
  const restored = [...playlist]
  restored.splice(Math.min(undo.visibleIndex, restored.length), 0, { ...undo.track })
  const withoutRemoval = removals.filter(({ mutation }) =>
    !matchesMutationTarget(mutation, undo.track),
  )
  return {
    playlist: restored,
    renames: undo.rename ? [...renames, undo.rename] : renames,
    removals: withoutRemoval,
    icons: undo.icon ? [...icons, undo.icon] : icons,
  }
}

export function playlistHasLegacyStructuralChanges(
  playlist: PlaylistTrack[],
  baseline: PlaylistTrack[],
  removals: StagedTrackRemoval[],
): boolean {
  const removed = new Set(removals.map(({ mutation }) =>
    rawTrackTargetKey(mutation.chapterKey, mutation.trackKey),
  ))
  const expectedVisible = baseline.filter(track =>
    !removed.has(rawTrackTargetKey(track.chapterKey ?? '', track.trackKey ?? '')),
  )
  if (playlist.length !== expectedVisible.length) return true
  return playlist.some((track, index) => track.id !== expectedVisible[index]?.id)
}

export function loadedTrackTitle(rawTitle: string, _hydratedTitle?: string): string {
  return rawTitle
}

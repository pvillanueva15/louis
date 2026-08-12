import type {
  PlaylistTrack,
  SaveAsSourceReference,
  SaveAsSourceSnapshot,
} from './types.ts'
import {
  applyCardMutations,
  mapRawIconState,
  type CardMutation,
} from '../yoto/cardMutation.ts'
import { assignFreshDraftTrackIds } from './draftTrackIconAssignment.ts'
import { cloneStructuredSnapshot } from './standalonePlaylist.ts'

export interface PreparedSaveAsDraft {
  title: string
  playlist: PlaylistTrack[]
  baseline: PlaylistTrack[]
  source: SaveAsSourceSnapshot
  sourceReference: SaveAsSourceReference
  mutations: CardMutation[]
}

function clonePlaylist(playlist: PlaylistTrack[]): PlaylistTrack[] {
  return cloneStructuredSnapshot(playlist)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function projectedPlaylist(
  playlist: PlaylistTrack[],
  source: SaveAsSourceSnapshot,
): PlaylistTrack[] {
  const chapters = Array.isArray(source.content.chapters) ? source.content.chapters : []
  return playlist.map((track) => {
    if (!track.chapterKey || !track.trackKey) return track
    const chapter = chapters.find(value => isRecord(value) && value.key === track.chapterKey)
    if (!isRecord(chapter) || !Array.isArray(chapter.tracks)) return track
    const sourceTrack = chapter.tracks.find(value => isRecord(value) && value.key === track.trackKey)
    if (!isRecord(sourceTrack)) return track
    const chapterDisplay = isRecord(chapter.display) ? chapter.display : undefined
    const trackDisplay = isRecord(sourceTrack.display) ? sourceTrack.display : undefined
    return {
      ...track,
      rawIconState: mapRawIconState(trackDisplay),
      chapterRawIconState: mapRawIconState(chapterDisplay),
      chapterDisplay: chapterDisplay && Object.hasOwn(chapterDisplay, 'icon16x16')
        ? { icon16x16: typeof chapterDisplay.icon16x16 === 'string' ? chapterDisplay.icon16x16 : null }
        : undefined,
      ...(track.yotoReuse
        ? {
            yotoReuse: {
              ...track.yotoReuse,
              display: trackDisplay && Object.hasOwn(trackDisplay, 'icon16x16')
                ? { icon16x16: typeof trackDisplay.icon16x16 === 'string' ? trackDisplay.icon16x16 : null }
                : undefined,
            },
          }
        : {}),
    }
  })
}

export function copyOfTitle(title: string): string {
  return `Copy of ${title.trim()}`
}

export function prepareSaveAsDraft(input: {
  source: SaveAsSourceSnapshot
  sourceReference: SaveAsSourceReference
  title: string
  playlist: PlaylistTrack[]
  mutations: CardMutation[]
}): PreparedSaveAsDraft {
  const source = cloneStructuredSnapshot(input.source)
  const materialized = input.mutations.length > 0
    ? applyCardMutations(source, input.mutations)
    : source
  const detachedSource: SaveAsSourceSnapshot = {
    title: materialized.title as string,
    content: materialized.content as Record<string, unknown>,
    ...(materialized.metadata && typeof materialized.metadata === 'object'
      ? { metadata: materialized.metadata as SaveAsSourceSnapshot['metadata'] }
      : {}),
  }
  const playlist = assignFreshDraftTrackIds(projectedPlaylist(clonePlaylist(input.playlist), detachedSource))

  return {
    title: copyOfTitle(input.title),
    playlist,
    baseline: clonePlaylist(playlist),
    source: detachedSource,
    sourceReference: { ...input.sourceReference },
    mutations: cloneStructuredSnapshot(input.mutations),
  }
}

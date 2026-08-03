import type {
  PlaylistTrack,
  SaveAsSourceReference,
  SaveAsSourceSnapshot,
} from './types.ts'
import {
  applyCardMutations,
  type CardMutation,
} from '../yoto/cardMutation.ts'

export interface PreparedSaveAsDraft {
  title: string
  playlist: PlaylistTrack[]
  baseline: PlaylistTrack[]
  source: SaveAsSourceSnapshot
  sourceReference: SaveAsSourceReference
  mutations: CardMutation[]
}

function clonePlaylist(playlist: PlaylistTrack[]): PlaylistTrack[] {
  return cloneJson(playlist)
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
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
  const source = cloneJson(input.source)
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
  const playlist = clonePlaylist(input.playlist)

  return {
    title: copyOfTitle(input.title),
    playlist,
    baseline: clonePlaylist(playlist),
    source: detachedSource,
    sourceReference: { ...input.sourceReference },
    mutations: structuredClone(input.mutations),
  }
}

import type { ProvenanceTrackEntry, YotoCardsManifest } from './types.ts'
import { YOTO_CARDS_CONTENT_VERSION } from './types.ts'
import { rawTrackTargetKey } from './rawTrackManagement.ts'

interface NotePayload {
  yotoCards?: {
    version?: unknown
    tracks?: unknown
  }
}

export function parseProvenance(
  note: string | null | undefined,
  contentVersion: string | null | undefined,
): YotoCardsManifest | null {
  if (!note?.trim()) return null

  let parsed: NotePayload
  try {
    parsed = JSON.parse(note) as NotePayload
  }
  catch {
    return null
  }

  const yotoCards = parsed?.yotoCards
  if (!yotoCards || typeof yotoCards.version !== 'number') {
    return null
  }

  if (contentVersion && contentVersion !== YOTO_CARDS_CONTENT_VERSION) {
    // Still accept manifest if note is valid; version is advisory
  }

  if (yotoCards.tracks !== undefined && !Array.isArray(yotoCards.tracks)) {
    return null
  }

  const tracks = Array.isArray(yotoCards.tracks)
    ? yotoCards.tracks.filter(isValidProvenanceEntry)
    : []

  if (!hasUniqueProvenanceTargets(tracks)) {
    return null
  }

  if (tracks.length === 0 && yotoCards.version !== 1) {
    return null
  }

  return {
    version: yotoCards.version,
    tracks,
  }
}

function isValidProvenanceEntry(entry: unknown): entry is ProvenanceTrackEntry {
  if (!entry || typeof entry !== 'object') return false
  const e = entry as ProvenanceTrackEntry
  return typeof e.chapterKey === 'string'
    && Boolean(e.chapterKey)
    && typeof e.trackKey === 'string'
    && Boolean(e.trackKey)
    && typeof e.youtubeId === 'string'
    && Boolean(e.youtubeId)
    && typeof e.title === 'string'
    && Boolean(e.title)
}

function hasUniqueProvenanceTargets(tracks: ProvenanceTrackEntry[]): boolean {
  const targets = new Set<string>()
  for (const track of tracks) {
    const target = rawTrackTargetKey(track.chapterKey, track.trackKey)
    if (targets.has(target)) return false
    targets.add(target)
  }
  return true
}

export function isWritableProvenance(
  note: string | null | undefined,
): boolean {
  if (!note?.trim()) return false
  try {
    const parsed = JSON.parse(note) as NotePayload
    const yotoCards = parsed?.yotoCards
    if (!yotoCards || yotoCards.version !== 1) return false
    if (yotoCards.tracks === undefined) return true
    if (!Array.isArray(yotoCards.tracks)) return false
    if (!yotoCards.tracks.every(isValidProvenanceEntry)) return false
    return hasUniqueProvenanceTargets(yotoCards.tracks)
  }
  catch {
    return false
  }
}

export function manifestLookupKey(chapterKey: string, trackKey: string): string {
  return rawTrackTargetKey(chapterKey, trackKey)
}

export function buildManifestLookup(
  manifest: YotoCardsManifest | null,
): Map<string, ProvenanceTrackEntry> {
  const map = new Map<string, ProvenanceTrackEntry>()
  if (!manifest) return map

  for (const entry of manifest.tracks) {
    map.set(manifestLookupKey(entry.chapterKey, entry.trackKey), entry)
  }
  return map
}

export function buildProvenance(
  tracks: Array<{ chapterKey: string; trackKey: string; title: string; youtubeId: string }>,
): { note: string; contentVersion: string } {
  const payload = {
    yotoCards: {
      version: 1,
      tracks: tracks.map(track => ({
        chapterKey: track.chapterKey,
        trackKey: track.trackKey,
        youtubeId: track.youtubeId,
        title: track.title,
      })),
    },
  }

  return {
    note: JSON.stringify(payload),
    contentVersion: YOTO_CARDS_CONTENT_VERSION,
  }
}

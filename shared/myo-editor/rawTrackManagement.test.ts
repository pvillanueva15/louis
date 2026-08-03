import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PlaylistTrack } from './types.ts'
import type { StagedTrackIconAssignment } from './trackIconAssignment.ts'
import { playlistRowId } from './playlistRowId.ts'
import {
  findRawTrackTargetIndex,
  hasRawTrackMutationStages,
  hasUniqueStableRawTrackIdentities,
  loadedTrackTitle,
  playlistHasLegacyStructuralChanges,
  replaceRawTrackTitle,
  removeRawTrack,
  stageRawTrackTitle,
  undoRawTrackRemoval,
} from './rawTrackManagement.ts'
import { classifyExistingCardChanges } from '../yoto/cardMutation.ts'

function track(id: string, title = id): PlaylistTrack {
  return {
    id,
    title,
    subtitle: 'YouTube',
    thumbnailUrl: '',
    source: 'app-youtube',
    youtubeId: `youtube-${id}`,
    chapterKey: `chapter-${id}`,
    trackKey: `track-${id}`,
    rawIconState: { kind: 'absent' },
    chapterRawIconState: { kind: 'absent' },
    chapterTrackCount: 1,
  }
}

describe('raw track management staging', () => {
  it('requires complete unique stable identities', () => {
    assert.equal(hasUniqueStableRawTrackIdentities([track('a'), track('b')]), true)
    assert.equal(hasUniqueStableRawTrackIdentities([{ ...track('a'), trackKey: undefined }]), false)
    assert.equal(hasUniqueStableRawTrackIdentities([track('a'), { ...track('b'), chapterKey: 'chapter-a', trackKey: 'track-a' }]), false)
  })

  it('stages trimmed titles and clears a rename when returned to baseline', () => {
    const original = track('a', 'Raw title')
    const edited = stageRawTrackTitle([], original, 'Raw title', '  New title  ')
    assert.equal(edited.error, null)
    assert.equal(edited.title, 'New title')
    assert.deepEqual(edited.renames[0]?.mutation, {
      kind: 'rename-track',
      chapterKey: 'chapter-a',
      trackKey: 'track-a',
      expectedTitle: 'Raw title',
      title: 'New title',
    })

    const reset = stageRawTrackTitle(
      edited.renames,
      { ...original, title: 'New title' },
      'Raw title',
      ' Raw title ',
    )
    assert.deepEqual(reset, { renames: [], title: 'Raw title', error: null })
  })

  it('enforces the 1 and 100 character title boundary without replacing the row', () => {
    const original = track('a', 'Raw title')
    assert.match(stageRawTrackTitle([], original, 'Raw title', ' ').error ?? '', /title/)
    assert.equal(stageRawTrackTitle([], original, 'Raw title', 'x'.repeat(100)).error, null)
    assert.match(stageRawTrackTitle([], original, 'Raw title', 'x'.repeat(101)).error ?? '', /100/)
  })

  it('uses tuple identity for delimiter-bearing keys when renaming and removing', () => {
    const first = {
      ...track('first', 'First raw'),
      chapterKey: 'a:b',
      trackKey: 'c',
    }
    first.id = playlistRowId(first)
    const selected = {
      ...track('selected', 'Selected raw'),
      chapterKey: 'a',
      trackKey: 'b:c',
    }
    selected.id = playlistRowId(selected)
    const playlist = [first, selected]

    assert.notEqual(first.id, selected.id)
    const staged = stageRawTrackTitle([], selected, 'Selected raw', 'Selected edited')
    const renamed = replaceRawTrackTitle(playlist, selected, staged.title)
    assert.deepEqual(renamed.map(item => item.title), ['First raw', 'Selected edited'])
    assert.deepEqual(staged.renames[0]?.mutation, {
      kind: 'rename-track',
      chapterKey: 'a',
      trackKey: 'b:c',
      expectedTitle: 'Selected raw',
      title: 'Selected edited',
    })

    const selectedIndex = findRawTrackTargetIndex(renamed, selected)
    assert.equal(selectedIndex, 1)
    const removed = removeRawTrack(renamed, selectedIndex, 'Selected raw', staged.renames, [], [])!
    assert.deepEqual(removed.playlist.map(item => [item.chapterKey, item.trackKey]), [['a:b', 'c']])
    assert.deepEqual(removed.removals[0]?.mutation, {
      kind: 'remove-track',
      chapterKey: 'a',
      trackKey: 'b:c',
      expectedTitle: 'Selected raw',
    })
  })

  it('removes at an exact visible position and undo restores displaced title and icon staging', () => {
    const playlist = [track('a'), track('b', 'B raw'), track('c')]
    const rename = stageRawTrackTitle([], playlist[1]!, 'B raw', 'B edited').renames
    const icon: StagedTrackIconAssignment = {
      mutation: {
        kind: 'set-track-icon',
        chapterKey: 'chapter-b',
        trackKey: 'track-b',
        expectedChapterIcon: { kind: 'absent' },
        expectedTrackIcon: { kind: 'absent' },
        mode: 'inherit',
      },
      previewUrl: null,
    }
    const removed = removeRawTrack(playlist, 1, 'B raw', rename, [], [icon])!
    assert.deepEqual(removed.playlist.map(item => item.id), ['a', 'c'])
    assert.deepEqual(removed.renames, [])
    assert.deepEqual(removed.icons, [])
    assert.equal(removed.removals[0]?.mutation.expectedTitle, 'B raw')

    const restored = undoRawTrackRemoval(
      removed.playlist,
      removed.renames,
      removed.removals,
      removed.icons,
      removed.undo,
    )
    assert.deepEqual(restored.playlist.map(item => item.id), ['a', 'b', 'c'])
    assert.deepEqual(restored.renames, rename)
    assert.deepEqual(restored.icons, [icon])
    assert.deepEqual(restored.removals, [])
  })

  it('keeps older removals staged while the newest one-step undo token replaces the prior token', () => {
    const first = removeRawTrack([track('a'), track('b'), track('c'), track('d')], 1, 'b', [], [], [])!
    const second = removeRawTrack(first.playlist, 2, 'd', [], first.removals, [])!
    const restored = undoRawTrackRemoval(
      second.playlist,
      second.renames,
      second.removals,
      second.icons,
      second.undo,
    )
    assert.deepEqual(restored.playlist.map(item => item.id), ['a', 'c', 'd'])
    assert.deepEqual(restored.removals.map(item => item.mutation.trackKey), ['track-b'])
  })

  it('rejects removing the final visible card track', () => {
    assert.equal(removeRawTrack([track('a')], 0, 'a', [], [], []), null)
  })

  it('distinguishes staged raw removals from legacy add and reorder changes', () => {
    const baseline = [track('a'), track('b'), track('c')]
    const removed = removeRawTrack(baseline, 1, 'b', [], [], [])!
    assert.equal(playlistHasLegacyStructuralChanges(removed.playlist, baseline, removed.removals), false)
    assert.equal(playlistHasLegacyStructuralChanges([...removed.playlist].reverse(), baseline, removed.removals), true)
    assert.equal(playlistHasLegacyStructuralChanges([...removed.playlist, track('new')], baseline, removed.removals), true)
  })

  it('keeps card title plus structural edits compatible while raw track stages stay blocked', () => {
    const titleAndStructural = classifyExistingCardChanges('Renamed card', 'Original card', true)
    assert.equal(titleAndStructural.rawMutationOnly, false)
    assert.equal(
      titleAndStructural.playlistDirty
      && hasRawTrackMutationStages(
        titleAndStructural.iconDirty,
        false,
        false,
      ),
      false,
    )
    assert.equal(hasRawTrackMutationStages(true, false, false), true)
    assert.equal(hasRawTrackMutationStages(false, true, false), true)
    assert.equal(hasRawTrackMutationStages(false, false, true), true)
  })

  it('keeps the raw Yoto title canonical over provenance or hydration titles', () => {
    assert.equal(loadedTrackTitle('Edited raw title', 'Old YouTube title'), 'Edited raw title')
  })
})

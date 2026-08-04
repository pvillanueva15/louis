import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PlaylistTrack } from './types.ts'
import {
  advanceRapidTrackIconAssignment,
  canStageRapidTrackIconSelection,
  canAssignTrackIcon,
  eligibleTrackIconTargets,
  effectiveTrackIcon,
  moveTrackIconTarget,
  rehomeTrackIconTarget,
  resetTrackIconAssignments,
  resolveTrackIconTarget,
  resolveTrackIconPreview,
  shouldInvalidatePersonalIconCache,
  shouldLoadTrackIconPreviews,
  stageTrackIconAssignment,
  STRUCTURAL_ICON_MIX_MESSAGE,
  toTrackIconMutations,
  trackIconTargetIndex,
} from './trackIconAssignment.ts'

const MEDIA_ID = 'a'.repeat(43)

function track(overrides: Partial<PlaylistTrack> = {}): PlaylistTrack {
  return {
    id: 'row-1',
    title: 'Track',
    subtitle: 'Yoto upload',
    thumbnailUrl: '',
    source: 'yoto-upload',
    chapterKey: 'chapter-1',
    trackKey: 'track-1',
    rawIconState: { kind: 'absent' },
    chapterRawIconState: { kind: 'present', value: 'yoto:#chapter' },
    chapterTrackCount: 2,
    chapterDisplay: { icon16x16: 'yoto:#chapter' },
    yotoReuse: {
      trackUrl: 'yoto:#audio',
      type: 'audio',
      format: 'aac',
      duration: 30,
      fileSize: 100,
      display: { icon16x16: null },
    },
    ...overrides,
  }
}

describe('track icon staging', () => {
  it('resolves explicit track icons before inherited chapter icons', () => {
    assert.deepEqual(effectiveTrackIcon(track(), []), {
      reference: 'yoto:#chapter',
      source: 'chapter',
      previewUrl: null,
    })
    assert.deepEqual(effectiveTrackIcon(track({
      rawIconState: { kind: 'present', value: 'yoto:#track' },
      yotoReuse: { ...track().yotoReuse!, display: { icon16x16: 'yoto:#track' } },
    }), []), {
      reference: 'yoto:#track',
      source: 'track',
      previewUrl: null,
    })
  })

  it('stages assignments without modifying the playlist track snapshot', () => {
    const original = track()
    const frozen = structuredClone(original)
    const assignments = stageTrackIconAssignment([], original, {
      mode: 'icon',
      mediaId: MEDIA_ID,
      previewUrl: 'https://example.com/icon.png',
    })

    assert.deepEqual(original, frozen)
    assert.equal(assignments.length, 1)
    assert.deepEqual(effectiveTrackIcon(original, assignments), {
      reference: `yoto:#${MEDIA_ID}`,
      source: 'track',
      previewUrl: 'https://example.com/icon.png',
    })
    assert.deepEqual(toTrackIconMutations(assignments), [assignments[0]!.mutation])
  })

  it('replaces a staged target and removes it when restored to the exact baseline', () => {
    const original = track({
      rawIconState: { kind: 'present', value: `yoto:#${MEDIA_ID}` },
      yotoReuse: { ...track().yotoReuse!, display: { icon16x16: `yoto:#${MEDIA_ID}` } },
    })
    let assignments = stageTrackIconAssignment([], original, { mode: 'inherit' })
    assert.equal(assignments.length, 1)
    assignments = stageTrackIconAssignment(assignments, original, {
      mode: 'icon',
      mediaId: MEDIA_ID,
    })
    assert.deepEqual(assignments, [])
  })

  it('treats present null as distinct from absent when staging inherit', () => {
    assert.deepEqual(stageTrackIconAssignment([], track(), { mode: 'inherit' }), [])
    assert.equal(stageTrackIconAssignment([], track({
      rawIconState: { kind: 'present', value: null },
    }), { mode: 'inherit' }).length, 1)
  })

  it('requires stable keys and complete loaded raw icon state', () => {
    assert.equal(canAssignTrackIcon(track()), true)
    assert.equal(canAssignTrackIcon(track({ trackKey: undefined })), false)
    assert.equal(canAssignTrackIcon(track({ rawIconState: undefined })), false)
  })

  it('keeps eligible targets in playlist order and excludes incomplete tracks', () => {
    const playlist = [
      track({ id: 'first', chapterKey: 'chapter-a', trackKey: 'track-a' }),
      track({ id: 'unavailable', chapterKey: undefined, trackKey: undefined }),
      track({ id: 'second', chapterKey: 'chapter-b', trackKey: 'track-b' }),
      track({ id: 'incomplete', chapterKey: 'chapter-c', trackKey: 'track-c', rawIconState: undefined }),
    ]

    assert.deepEqual(eligibleTrackIconTargets(playlist), [
      { chapterKey: 'chapter-a', trackKey: 'track-a' },
      { chapterKey: 'chapter-b', trackKey: 'track-b' },
    ])
  })

  it('opens on the first eligible target and keeps navigation within bounds', () => {
    const targets = eligibleTrackIconTargets([
      track({ chapterKey: 'chapter-a', trackKey: 'track-a' }),
      track({ chapterKey: 'chapter-b', trackKey: 'track-b' }),
    ])

    assert.deepEqual(targets[0], { chapterKey: 'chapter-a', trackKey: 'track-a' })
    assert.deepEqual(moveTrackIconTarget(targets, targets[0]!, -1), targets[0])
    assert.deepEqual(moveTrackIconTarget(targets, targets[0]!, 1), targets[1])
    assert.deepEqual(moveTrackIconTarget(targets, targets[1]!, 1), targets[1])
  })

  it('advances after a selection and completes without leaving the final target', () => {
    const first = track({ chapterKey: 'chapter-a', trackKey: 'track-a' })
    const second = track({
      chapterKey: 'chapter-b',
      trackKey: 'track-b',
      rawIconState: { kind: 'present', value: null },
    })
    const targets = eligibleTrackIconTargets([first, second])

    let assignments = stageTrackIconAssignment([], first, {
      mode: 'icon',
      mediaId: MEDIA_ID,
    })

    assert.deepEqual(advanceRapidTrackIconAssignment(targets, targets[0]!), {
      target: targets[1],
      completed: false,
    })
    assignments = stageTrackIconAssignment(assignments, second, { mode: 'inherit' })
    assert.deepEqual(advanceRapidTrackIconAssignment(targets, targets[1]!), {
      target: targets[1],
      completed: true,
    })
    assert.equal(assignments.length, 2)
  })

  it('does not accept or advance a rapid selection after editor availability changes', () => {
    const first = track({ chapterKey: 'chapter-a', trackKey: 'track-a' })
    const second = track({ chapterKey: 'chapter-b', trackKey: 'track-b' })
    const targets = eligibleTrackIconTargets([first, second])
    const ready = {
      loading: false,
      locked: false,
      yotoBlocked: false,
      manageable: true,
    }

    for (const unavailable of [
      { ...ready, loading: true },
      { ...ready, locked: true },
      { ...ready, yotoBlocked: true },
      { ...ready, manageable: false },
    ]) {
      const accepted = canStageRapidTrackIconSelection(
        targets,
        targets[0]!,
        first,
        unavailable,
      )
      const next = accepted
        ? advanceRapidTrackIconAssignment(targets, targets[0]!)?.target
        : targets[0]
      assert.equal(accepted, false)
      assert.deepEqual(next, { chapterKey: 'chapter-a', trackKey: 'track-a' })
    }

    assert.equal(canStageRapidTrackIconSelection(targets, targets[0]!, first, ready), true)
  })

  it('re-homes a removed or ineligible current target to a surviving stable target', () => {
    const removed = { chapterKey: 'chapter-a', trackKey: 'track-a' }
    const surviving = track({ chapterKey: 'chapter-b', trackKey: 'track-b' })
    const targetsAfterRemoval = eligibleTrackIconTargets([surviving])
    const targetsAfterIneligibility = eligibleTrackIconTargets([
      track({ chapterKey: 'chapter-a', trackKey: 'track-a', rawIconState: undefined }),
      surviving,
    ])

    assert.deepEqual(rehomeTrackIconTarget(targetsAfterRemoval, removed), targetsAfterRemoval[0])
    assert.deepEqual(rehomeTrackIconTarget(targetsAfterIneligibility, removed), targetsAfterIneligibility[0])
    assert.equal(rehomeTrackIconTarget([], removed), null)
  })

  it('resolves the current target by stable raw keys after playlist order changes', () => {
    const first = track({ id: 'shared-row', title: 'First', chapterKey: 'chapter-a', trackKey: 'track-a' })
    const second = track({ id: 'shared-row', title: 'Second', chapterKey: 'chapter-b', trackKey: 'track-b' })
    const targets = eligibleTrackIconTargets([first, second])

    assert.equal(trackIconTargetIndex(targets, targets[1]!), 1)
    assert.equal(resolveTrackIconTarget([second, first], targets[1]!)?.title, 'Second')
  })

  it('full Reset is represented by clearing all staged assignments', () => {
    const first = stageTrackIconAssignment([], track(), {
      mode: 'icon',
      mediaId: MEDIA_ID,
    })
    const second = stageTrackIconAssignment(first, track({ trackKey: 'track-2' }), {
      mode: 'inherit',
    })
    assert.equal(second.length, 1)
    assert.deepEqual(resetTrackIconAssignments(), [])
    assert.match(STRUCTURAL_ICON_MIX_MESSAGE, /Reset either/)
  })

  it('resolves a saved icon preview from the shared personal library after reload', () => {
    const reloaded = effectiveTrackIcon(track({
      rawIconState: { kind: 'present', value: `yoto:#${MEDIA_ID}` },
      yotoReuse: { ...track().yotoReuse!, display: { icon16x16: `yoto:#${MEDIA_ID}` } },
    }), [])

    assert.equal(resolveTrackIconPreview(reloaded, []).previewUrl, null)
    assert.equal(resolveTrackIconPreview(reloaded, [{
      mediaId: MEDIA_ID,
      displayIconId: 'personal-icon-1',
      url: 'https://example.com/icon.png',
      createdAt: null,
    }]).previewUrl, 'https://example.com/icon.png')
  })

  it('loads after reconnect only once a card is selected and does not reload ready cache', () => {
    const connectedAfterError = {
      cardId: 'card-1',
      isPodcast: false,
      yotoConnected: true,
      yotoStatus: 'idle',
      libraryStatus: 'error' as const,
    }

    assert.equal(shouldLoadTrackIconPreviews(connectedAfterError), true)
    assert.equal(shouldLoadTrackIconPreviews({
      ...connectedAfterError,
      cardId: null,
      libraryStatus: 'idle',
    }), false)
    assert.equal(shouldLoadTrackIconPreviews({
      ...connectedAfterError,
      libraryStatus: 'idle',
    }), true)
    assert.equal(shouldLoadTrackIconPreviews({
      ...connectedAfterError,
      libraryStatus: 'ready',
    }), false)
  })

  it('invalidates only on actual account loss, not an ordinary status refresh', () => {
    assert.equal(shouldInvalidatePersonalIconCache(false, true), true)
    assert.equal(shouldInvalidatePersonalIconCache(true, true), false)
    assert.equal(shouldInvalidatePersonalIconCache(true, false), false)
    assert.equal(shouldInvalidatePersonalIconCache(false, undefined), false)
  })
})

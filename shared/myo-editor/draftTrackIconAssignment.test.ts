import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PlaylistTrack } from './types.ts'
import {
  advanceRapidDraftTrackIconAssignment,
  assignFreshDraftTrackIds,
  canStageRapidDraftTrackIconSelection,
  draftIconSecondaryAction,
  draftTrackIconTargetIndex,
  effectiveDraftTrackIcon,
  eligibleDraftTrackIconTargets,
  moveDraftTrackIconTarget,
  parseDraftTrackIconPlaylist,
  rehomeDraftTrackIconTarget,
  resolveIconAssignmentModalLocks,
  resolveDraftTrackIconPreview,
  stageDraftTrackIconChoice,
} from './draftTrackIconAssignment.ts'

const MEDIA_A = 'A'.repeat(43)
const MEDIA_B = 'B'.repeat(43)

function row(id: string, overrides: Partial<PlaylistTrack> = {}): PlaylistTrack {
  return {
    id,
    title: id,
    subtitle: '',
    thumbnailUrl: '',
    source: 'app-youtube',
    youtubeId: id,
    ...overrides,
  }
}

describe('draft track icon assignment', () => {
  it('assigns opaque UUID identities independently of every existing identity', () => {
    const assigned = assignFreshDraftTrackIds([
      row('same', { youtubeId: 'same', chapterKey: 'same', trackKey: 'same' }),
      row('same', { youtubeId: 'same', chapterKey: 'same', trackKey: 'same' }),
    ])
    assert.match(assigned[0]!.draftTrackId!, /^[0-9a-f-]{36}$/)
    assert.notEqual(assigned[0]!.draftTrackId, assigned[1]!.draftTrackId)
    assert.notEqual(assigned[0]!.draftTrackId, assigned[0]!.id)
    assert.equal(assigned[0]!.draftIcon, undefined)
  })

  it('rejects missing, duplicate, and malformed draft identities', () => {
    assert.throws(() => parseDraftTrackIconPlaylist([row('missing')], { saveAsDraft: false }), /missing/)
    const assigned = assignFreshDraftTrackIds([row('a'), row('b')])
    assigned[1]!.draftTrackId = assigned[0]!.draftTrackId
    assert.throws(() => parseDraftTrackIconPlaylist(assigned, { saveAsDraft: false }), /duplicate/)
    assigned[1]!.draftTrackId = 'not-a-uuid'
    assert.throws(() => parseDraftTrackIconPlaylist(assigned, { saveAsDraft: false }), /missing/)
  })

  it('validates choices, media IDs, and retained-source chapter provenance', () => {
    const [standalone] = assignFreshDraftTrackIds([row('a')])
    standalone!.draftIcon = { mode: 'icon', mediaId: MEDIA_A }
    assert.deepEqual(
      parseDraftTrackIconPlaylist([standalone!], { saveAsDraft: false })[0]!.draftIcon,
      { mode: 'icon', mediaId: MEDIA_A },
    )
    standalone!.draftIcon = { mode: 'icon', mediaId: 'bad' }
    assert.throws(() => parseDraftTrackIconPlaylist([standalone!], { saveAsDraft: false }), /malformed/)
    standalone!.draftIcon = { mode: 'chapter' }
    assert.throws(() => parseDraftTrackIconPlaylist([standalone!], { saveAsDraft: true }), /retained/)
    const [retained] = assignFreshDraftTrackIds([row('r', { chapterKey: 'c', trackKey: 't' })])
    retained!.draftIcon = { mode: 'chapter' }
    assert.equal(parseDraftTrackIconPlaylist([retained!], { saveAsDraft: true })[0]!.draftIcon?.mode, 'chapter')
  })

  it('stages replacement and removes choices that match the detached baseline', () => {
    const [baseline] = assignFreshDraftTrackIds([row('a', {
      rawIconState: { kind: 'present', value: `yoto:#${MEDIA_A}` },
      chapterRawIconState: { kind: 'present', value: `yoto:#${MEDIA_A}` },
    })])
    let playlist = structuredClone([baseline!])
    playlist = stageDraftTrackIconChoice(playlist, [baseline!], baseline!.draftTrackId!, {
      mode: 'icon', mediaId: MEDIA_B,
    })
    assert.deepEqual(playlist[0]!.draftIcon, { mode: 'icon', mediaId: MEDIA_B })
    playlist = stageDraftTrackIconChoice(playlist, [baseline!], baseline!.draftTrackId!, {
      mode: 'icon', mediaId: MEDIA_A,
    })
    assert.equal(playlist[0]!.draftIcon, undefined)
  })

  it('does not store preview URLs and resolves previews from the account cache', () => {
    const [track] = assignFreshDraftTrackIds([row('a')])
    const playlist = stageDraftTrackIconChoice([track!], [], track!.draftTrackId!, {
      mode: 'icon', mediaId: MEDIA_A,
    })
    assert.deepEqual(playlist[0]!.draftIcon, { mode: 'icon', mediaId: MEDIA_A })
    assert.equal(
      resolveDraftTrackIconPreview(effectiveDraftTrackIcon(playlist[0]!), [{
        mediaId: MEDIA_A,
        displayIconId: 'icon-a',
        url: 'https://example.test/icon.png',
        createdAt: null,
      }]).previewUrl,
      'https://example.test/icon.png',
    )
  })

  it('uses draft IDs for rapid navigation across reorder and removal', () => {
    const playlist = assignFreshDraftTrackIds([row('a'), row('b'), row('c')])
    const targets = eligibleDraftTrackIconTargets(playlist)
    const current = targets[1]!
    const reordered = [targets[2]!, targets[1]!, targets[0]!]
    assert.equal(draftTrackIconTargetIndex(reordered, current), 1)
    assert.equal(moveDraftTrackIconTarget(reordered, current, 1), targets[0])
    assert.deepEqual(advanceRapidDraftTrackIconAssignment(reordered, targets[0]!), {
      target: targets[0], completed: true,
    })
    assert.equal(rehomeDraftTrackIconTarget([targets[0]!, targets[2]!], current), targets[0])
    assert.equal(rehomeDraftTrackIconTarget([], current), null)
  })

  it('revalidates the current draft target before accepting and advancing', () => {
    const [track] = assignFreshDraftTrackIds([row('a')])
    const targets = eligibleDraftTrackIconTargets([track!])
    assert.equal(canStageRapidDraftTrackIconSelection(targets, targets[0]!, track!, {
      loading: false, locked: false, yotoBlocked: false, manageable: true,
    }), true)
    assert.equal(canStageRapidDraftTrackIconSelection(targets, targets[0]!, track!, {
      loading: true, locked: false, yotoBlocked: false, manageable: true,
    }), false)
    assert.equal(canStageRapidDraftTrackIconSelection([], targets[0]!, track!, {
      loading: false, locked: false, yotoBlocked: false, manageable: true,
    }), false)
  })

  it('blocks unavailable selections without trapping modal dismissal', () => {
    assert.deepEqual(
      resolveIconAssignmentModalLocks({
        operationBusy: false,
        selectionUnavailable: true,
        recoveryRequired: false,
      }),
      { dismissalBlocked: false, selectionBlocked: true },
    )
    assert.deepEqual(
      resolveIconAssignmentModalLocks({
        operationBusy: true,
        selectionUnavailable: false,
        recoveryRequired: false,
      }),
      { dismissalBlocked: true, selectionBlocked: true },
    )
  })

  it('chooses the correct secondary action and preserves explicit none semantics', () => {
    const retained = assignFreshDraftTrackIds([
      row('a', { chapterKey: 'c', trackKey: 'a' }),
      row('b', { chapterKey: 'c', trackKey: 'b' }),
    ])
    assert.equal(draftIconSecondaryAction(retained, retained[0]!), 'chapter')
    assert.equal(draftIconSecondaryAction([retained[0]!], retained[0]!), 'none')
    const cleared = stageDraftTrackIconChoice([retained[0]!], [retained[0]!], retained[0]!.draftTrackId!, { mode: 'none' })
    assert.equal(cleared[0]!.draftIcon?.mode, 'none')
    assert.deepEqual(effectiveDraftTrackIcon(cleared[0]!), {
      reference: null, source: 'none', previewUrl: null,
    })
  })
})

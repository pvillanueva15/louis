import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PlaylistTrack } from './types.ts'
import { resetCardTitle } from '../yoto/cardMutation.ts'
import {
  classifyCreateStartFailure,
  cloneCardSaveSnapshot,
  getStandalonePlaylistValidationError,
  isPlaylistEditorActive,
  notifyConfirmedCardUpdated,
  notifyConfirmedPlaylistCreated,
  resolveClientSaveTarget,
  resolveSavedCardId,
  shouldBlockEditorNavigation,
  shouldWarnBeforeUnload,
} from './standalonePlaylist.ts'

function youtubeTrack(id = 'video-1'): PlaylistTrack {
  return {
    id,
    title: 'Track',
    subtitle: 'Channel',
    thumbnailUrl: '',
    source: 'app-youtube',
    youtubeId: id,
  }
}

describe('standalone playlist drafts', () => {
  it('keeps a local draft editable without a remote card ID', () => {
    assert.equal(isPlaylistEditorActive(null, true), true)
    assert.equal(isPlaylistEditorActive(null, false), false)
    assert.equal(isPlaylistEditorActive('existing-card', false), true)
  })

  it('resolves create and update from one discriminated client target', () => {
    assert.deepEqual(
      resolveClientSaveTarget({ operation: 'create' }),
      {
        operation: 'create',
        saveKey: 'new-playlist-draft',
        endpoint: '/api/yoto/content/save',
      },
    )
    assert.deepEqual(
      resolveClientSaveTarget({ operation: 'update', cardId: 'existing-card' }),
      {
        operation: 'update',
        saveKey: 'existing-card',
        cardId: 'existing-card',
        endpoint: '/api/yoto/content/existing-card/save',
      },
    )
    assert.throws(
      () => resolveClientSaveTarget({ operation: 'update', cardId: '  ' }),
      /Existing card ID is required/,
    )
  })

  it('requires a title and supported YouTube tracks before create', () => {
    assert.equal(
      getStandalonePlaylistValidationError('   ', [youtubeTrack()]),
      'Give this playlist a title.',
    )
    assert.match(
      getStandalonePlaylistValidationError('x'.repeat(141), [youtubeTrack()]) ?? '',
      /140/,
    )
    assert.equal(
      getStandalonePlaylistValidationError('Bedtime', []),
      'Add at least one YouTube track before creating this playlist.',
    )
    assert.equal(getStandalonePlaylistValidationError('Bedtime', [youtubeTrack()]), null)
  })

  it('rejects non-YouTube tracks from a new playlist', () => {
    assert.equal(
      getStandalonePlaylistValidationError('Bedtime', [{
        ...youtubeTrack(),
        source: 'yoto-upload',
      }]),
      'New playlists can only include supported YouTube tracks.',
    )
  })

  it('promotes a create using the returned ID and leaves update identity unchanged', () => {
    assert.equal(resolveSavedCardId('create', null, 'created-card'), 'created-card')
    assert.equal(resolveSavedCardId('update', 'existing-card', 'ignored-card'), 'existing-card')
    assert.throws(
      () => resolveSavedCardId('create', null),
      /Check My Cards before trying again/,
    )
  })

  it('notifies only after a confirmed create', () => {
    const notified: string[] = []
    const notify = (cardId: string) => notified.push(cardId)

    notifyConfirmedPlaylistCreated('update', 'existing-card', notify)
    notifyConfirmedPlaylistCreated('create', 'created-card', notify)

    assert.deepEqual(notified, ['created-card'])
  })

  it('notifies confirmed mixed updates whether selected or navigated away', async () => {
    const notified: string[] = []
    const notify = (cardId: string) => notified.push(cardId)

    await notifyConfirmedCardUpdated('update', 'complete', 'selected-card', notify)
    await notifyConfirmedCardUpdated('update', 'complete', 'background-card', notify)
    await notifyConfirmedCardUpdated('update', 'posting', 'pending-card', notify)
    await notifyConfirmedCardUpdated('update', 'failed', 'failed-card', notify)
    await notifyConfirmedCardUpdated('create', 'complete', 'created-card', notify)

    assert.deepEqual(notified, ['selected-card', 'background-card'])
  })

  it('restores the source card identity after a background save revisit and failure', () => {
    const sourceSnapshot = cloneCardSaveSnapshot({
      playlist: [youtubeTrack('edited-a')],
      baseline: [youtubeTrack('baseline-a')],
      cardTitle: 'Edited A',
      baselineCardTitle: 'Original A',
      cardRevision: 'revision-a',
    })

    let editorIdentity = {
      baselineCardTitle: 'Original B',
      cardRevision: 'revision-b',
    }
    const restoredAfterViewingCardB = cloneCardSaveSnapshot(sourceSnapshot)
    editorIdentity = restoredAfterViewingCardB

    assert.equal(editorIdentity.baselineCardTitle, 'Original A')
    assert.equal(editorIdentity.cardRevision, 'revision-a')
    assert.equal(
      resetCardTitle(false, editorIdentity.baselineCardTitle),
      'Original A',
    )
    assert.equal(editorIdentity.cardRevision, 'revision-a')
  })

  it('keeps confirmed pre-job create failures retryable', () => {
    assert.deepEqual(
      classifyCreateStartFailure({
        statusCode: 400,
        data: { statusMessage: 'Give this playlist a title.' },
      }),
      {
        message: 'Give this playlist a title.',
        outcomeUncertain: false,
      },
    )
    assert.equal(
      classifyCreateStartFailure({
        statusCode: 403,
        statusMessage: 'Reconnect to Yoto.',
      }).outcomeUncertain,
      false,
    )
  })

  it('blocks another create when the startup response is lost or ambiguous', () => {
    const failure = classifyCreateStartFailure(new TypeError('Failed to fetch'))

    assert.equal(failure.outcomeUncertain, true)
    assert.match(failure.message, /Check My Cards before trying again/)
  })

  it('allows existing background saves to continue through navigation', () => {
    assert.equal(
      shouldBlockEditorNavigation(false, {
        backgroundSaveActive: false,
        titleMutationActive: false,
      }),
      false,
    )
    assert.equal(
      shouldBlockEditorNavigation(false, {
        backgroundSaveActive: true,
        titleMutationActive: false,
      }),
      false,
    )
    assert.equal(
      shouldBlockEditorNavigation(true, {
        backgroundSaveActive: true,
        titleMutationActive: false,
      }),
      true,
    )
    assert.equal(
      shouldBlockEditorNavigation(false, {
        backgroundSaveActive: false,
        titleMutationActive: true,
      }),
      true,
    )
  })

  it('retains unload protection throughout a foreground title mutation', () => {
    const beforeRename = {
      backgroundSaveActive: false,
      titleMutationActive: false,
    }
    const duringRename = {
      backgroundSaveActive: false,
      titleMutationActive: true,
    }

    assert.equal(shouldWarnBeforeUnload(true, beforeRename), true)
    assert.equal(shouldWarnBeforeUnload(true, duringRename), true)
  })

  it('updates unload protection after title mutation success or failure', () => {
    const renameFinished = {
      backgroundSaveActive: false,
      titleMutationActive: false,
    }

    assert.equal(shouldWarnBeforeUnload(false, renameFinished), false)
    assert.equal(shouldWarnBeforeUnload(true, renameFinished), true)
  })

  it('suppresses unload protection for resumable background saves', () => {
    assert.equal(
      shouldWarnBeforeUnload(true, {
        backgroundSaveActive: true,
        titleMutationActive: false,
      }),
      false,
    )
  })
})

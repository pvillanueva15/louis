import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PlaylistTrack } from './types.ts'
import {
  classifyCreateStartFailure,
  getStandalonePlaylistValidationError,
  isPlaylistEditorActive,
  notifyConfirmedPlaylistCreated,
  resolveClientSaveTarget,
  resolveSavedCardId,
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
      'Give this playlist a title before creating it.',
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

  it('warns before unload only for dirty, unlocked editor state', () => {
    assert.equal(shouldWarnBeforeUnload(true, false), true)
    assert.equal(shouldWarnBeforeUnload(false, false), false)
    assert.equal(shouldWarnBeforeUnload(true, true), false)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isReactive, reactive, toRaw } from 'vue'
import type { PlaylistTrack } from './types.ts'
import { resetCardTitle } from '../yoto/cardMutation.ts'
import {
  classifyCreateStartFailure,
  cloneCardSaveSnapshot,
  getStandalonePlaylistValidationError,
  isPlaylistEditorActive,
  notifyConfirmedCardUpdated,
  notifyConfirmedPlaylistCreated,
  resolveCreateOutcomeUncertainAfterReset,
  resetEditorTitle,
  resolveClientSaveTarget,
  resolveSavedCardId,
  shouldBlockEditorNavigation,
  shouldConfirmEditorNavigation,
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

  it('allows detached source tracks only for a Save As create draft', () => {
    const yotoTrack = {
      ...youtubeTrack(),
      source: 'yoto-upload' as const,
    }
    assert.match(
      getStandalonePlaylistValidationError('Copy', [yotoTrack]) ?? '',
      /only include supported YouTube tracks/,
    )
    assert.equal(
      getStandalonePlaylistValidationError('Copy', [yotoTrack], {
        isSaveAsDraft: true,
      }),
      null,
    )
    assert.match(
      getStandalonePlaylistValidationError('Copy', [], {
        isSaveAsDraft: true,
      }) ?? '',
      /must keep at least one track/,
    )
  })

  it('keeps the local raw draft separate from the server source reference and commands', () => {
    const snapshot = {
      playlist: [youtubeTrack()],
      baseline: [youtubeTrack()],
      cardTitle: 'Copy of Source',
      baselineCardTitle: 'Copy of Source',
      cardRevision: '',
      saveAsSource: {
        title: 'Source',
        content: { chapters: [] },
      },
      saveAsSourceReference: {
        cardId: 'source-card',
        expectedRevision: 'revision-1',
      },
      saveAsMutations: [{
        kind: 'rename-card' as const,
        expectedTitle: 'Source',
        title: 'Renamed source',
      }],
    }
    const cloned = cloneCardSaveSnapshot(snapshot)
    cloned.saveAsSource!.content.chapters = ['local-only']
    cloned.saveAsSourceReference!.cardId = 'changed-clone'
    const clonedMutation = cloned.saveAsMutations![0]!
    assert.equal(clonedMutation.kind, 'rename-card')
    if (clonedMutation.kind === 'rename-card') clonedMutation.title = 'Changed clone'

    assert.deepEqual(snapshot.saveAsSource.content.chapters, [])
    assert.equal(snapshot.saveAsSourceReference.cardId, 'source-card')
    assert.equal(snapshot.saveAsMutations[0]!.title, 'Renamed source')
  })

  it('deep-clones draft identities and icon choices in both playlist snapshots', () => {
    const snapshot = {
      playlist: [{
        ...youtubeTrack(),
        draftTrackId: '11111111-1111-4111-8111-111111111111',
        draftIcon: { mode: 'icon' as const, mediaId: 'M'.repeat(43) },
      }],
      baseline: [{
        ...youtubeTrack(),
        draftTrackId: '11111111-1111-4111-8111-111111111111',
        draftIcon: { mode: 'chapter' as const },
      }],
      cardTitle: 'Draft',
      baselineCardTitle: 'Draft',
      cardRevision: '',
    }
    const cloned = cloneCardSaveSnapshot(snapshot)
    cloned.playlist[0]!.draftIcon = { mode: 'none' }
    cloned.baseline[0]!.draftTrackId = '22222222-2222-4222-8222-222222222222'
    assert.deepEqual(snapshot.playlist[0]!.draftIcon, { mode: 'icon', mediaId: 'M'.repeat(43) })
    assert.equal(snapshot.baseline[0]!.draftTrackId, '11111111-1111-4111-8111-111111111111')
  })

  it('losslessly snapshots nested Vue-reactive playlist state', () => {
    const reactiveTrack = reactive({
      ...youtubeTrack(),
      draftTrackId: '11111111-1111-4111-8111-111111111111',
      draftIcon: reactive({ mode: 'icon' as const, mediaId: 'M'.repeat(43) }),
      chapterDisplay: reactive({ icon16x16: 'yoto:#chapter' }),
      yotoReuse: reactive({
        trackUrl: 'yoto:#audio',
        type: 'audio' as const,
        format: 'aac',
        duration: 10,
        fileSize: 20,
        display: reactive({ icon16x16: 'yoto:#track' }),
      }),
      directlyCarriedUnknown: reactive({
        keepUndefined: undefined as string | undefined,
        nested: reactive([{ keep: true }]),
      }),
    })
    const snapshot = reactive({
      playlist: [reactiveTrack],
      baseline: [reactiveTrack],
      cardTitle: 'Reactive draft',
      baselineCardTitle: 'Reactive draft',
      cardRevision: '',
      saveAsSource: reactive({
        title: 'Source',
        content: reactive({
          chapters: [],
          directlyCarriedUnknown: reactive({ keepUndefined: undefined }),
        }),
      }),
      saveAsSourceReference: reactive({
        cardId: 'source-card',
        expectedRevision: 'revision-1',
      }),
      saveAsMutations: reactive([{
        kind: 'rename-card' as const,
        expectedTitle: 'Source',
        title: 'Renamed source',
      }]),
    })

    assert.throws(
      () => structuredClone(snapshot.playlist),
      (error: unknown) => error instanceof DOMException && error.name === 'DataCloneError',
    )
    const cloned = cloneCardSaveSnapshot(snapshot, toRaw)
    const clonedTrack = cloned.playlist[0]! as PlaylistTrack & {
      directlyCarriedUnknown: {
        keepUndefined?: string
        nested: Array<{ keep: boolean }>
      }
    }

    assert.equal(isReactive(cloned), false)
    assert.equal(isReactive(clonedTrack), false)
    assert.equal(isReactive(clonedTrack.draftIcon), false)
    assert.equal(isReactive(clonedTrack.yotoReuse?.display), false)
    assert.equal(isReactive(clonedTrack.directlyCarriedUnknown.nested), false)
    assert.equal(isReactive(cloned.saveAsSource?.content), false)
    assert.equal(isReactive(cloned.saveAsMutations), false)
    assert.equal(
      Object.hasOwn(clonedTrack.directlyCarriedUnknown, 'keepUndefined'),
      true,
    )
    assert.deepEqual(clonedTrack.draftIcon, {
      mode: 'icon', mediaId: 'M'.repeat(43),
    })
    assert.deepEqual(clonedTrack.chapterDisplay, { icon16x16: 'yoto:#chapter' })
    assert.deepEqual(clonedTrack.yotoReuse?.display, { icon16x16: 'yoto:#track' })
    assert.deepEqual(clonedTrack.directlyCarriedUnknown.nested, [{ keep: true }])
    assert.equal(
      Object.hasOwn(
        (cloned.saveAsSource!.content.directlyCarriedUnknown as Record<string, unknown>),
        'keepUndefined',
      ),
      true,
    )
    assert.deepEqual(cloned.saveAsMutations, [{
      kind: 'rename-card',
      expectedTitle: 'Source',
      title: 'Renamed source',
    }])
    assert.notEqual(cloned.playlist, snapshot.playlist)
    assert.notEqual(clonedTrack.draftIcon, reactiveTrack.draftIcon)
  })

  it('preserves sparse reactive arrays and their enumerable properties', () => {
    type SparseUnknown = Array<{ keep: boolean } | undefined> & {
      extra?: { shared: { keep: boolean } }
      self?: SparseUnknown
    }
    const shared = reactive({ keep: true })
    const sparse: SparseUnknown = []
    sparse.length = 4
    sparse[2] = shared
    Object.defineProperties(sparse, {
      extra: {
        value: { shared },
        enumerable: true,
        configurable: true,
        writable: true,
      },
      self: {
        value: sparse,
        enumerable: true,
        configurable: true,
        writable: true,
      },
    })
    const snapshot = reactive({
      playlist: [{
        ...youtubeTrack(),
        sparseUnknown: reactive(sparse),
      }],
      baseline: [],
      cardTitle: 'Reactive edge cases',
      baselineCardTitle: '',
      cardRevision: '',
    })

    const cloned = cloneCardSaveSnapshot(snapshot, toRaw)
    const clonedTrack = cloned.playlist[0]! as PlaylistTrack & {
      sparseUnknown: SparseUnknown
    }
    const clonedSparse = clonedTrack.sparseUnknown

    assert.equal(clonedSparse.length, 4)
    assert.equal(0 in clonedSparse, false)
    assert.equal(1 in clonedSparse, false)
    assert.equal(2 in clonedSparse, true)
    assert.equal(3 in clonedSparse, false)
    assert.deepEqual(Object.keys(clonedSparse), ['2', 'extra', 'self'])
    assert.equal(clonedSparse.self, clonedSparse)
    assert.equal(clonedSparse.extra?.shared, clonedSparse[2])
  })

  it('preserves a reactive own __proto__ data property without changing prototypes', () => {
    const ownProtoValue = reactive({ keep: true })
    const ownProtoRecord: Record<string, unknown> = { label: 'safe' }
    Object.defineProperty(ownProtoRecord, '__proto__', {
      value: ownProtoValue,
      enumerable: true,
      configurable: true,
      writable: true,
    })
    const objectPrototype = Object.getPrototypeOf({})
    const snapshot = reactive({
      playlist: [{
        ...youtubeTrack(),
        ownProtoRecord: reactive(ownProtoRecord),
      }],
      baseline: [],
      cardTitle: 'Reactive edge case',
      baselineCardTitle: '',
      cardRevision: '',
    })

    const cloned = cloneCardSaveSnapshot(snapshot, toRaw)
    const clonedProtoRecord = (cloned.playlist[0]! as PlaylistTrack & {
      ownProtoRecord: Record<string, unknown>
    }).ownProtoRecord

    assert.equal(Object.hasOwn(clonedProtoRecord, '__proto__'), true)
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(clonedProtoRecord, '__proto__')?.value,
      { keep: true },
    )
    assert.equal(Object.getPrototypeOf(clonedProtoRecord), objectPrototype)
    assert.equal(Object.getPrototypeOf(ownProtoRecord), objectPrototype)
    assert.equal(Object.getPrototypeOf({}), objectPrototype)
    assert.equal(Object.hasOwn(Object.prototype, 'keep'), false)
  })

  it('preserves a reactive null-prototype record with cycles and shared values', () => {
    const shared = reactive({ keep: true })
    const nullPrototypeRecord = Object.create(null) as Record<string, unknown>
    nullPrototypeRecord.label = 'safe'
    nullPrototypeRecord.first = shared
    nullPrototypeRecord.second = shared
    nullPrototypeRecord.self = nullPrototypeRecord
    const nestedNullPrototypeRecord = Object.create(null) as Record<string, unknown>
    nestedNullPrototypeRecord.parent = nullPrototypeRecord
    nullPrototypeRecord.map = new Map([['nested', nestedNullPrototypeRecord]])
    nullPrototypeRecord.set = new Set([nestedNullPrototypeRecord])
    const reactiveRecord = reactive(nullPrototypeRecord)
    assert.equal(Object.getPrototypeOf(toRaw(reactiveRecord)), null)
    const snapshot = reactive({
      playlist: [{
        ...youtubeTrack(),
        nullPrototypeRecord: reactiveRecord,
      }],
      baseline: [],
      cardTitle: 'Reactive null prototype',
      baselineCardTitle: '',
      cardRevision: '',
    })

    const cloned = cloneCardSaveSnapshot(snapshot, toRaw)
    const clonedRecord = (cloned.playlist[0]! as PlaylistTrack & {
      nullPrototypeRecord: Record<string, unknown>
    }).nullPrototypeRecord

    assert.equal(Object.getPrototypeOf(clonedRecord), null)
    assert.equal(clonedRecord.label, 'safe')
    assert.equal(clonedRecord.self, clonedRecord)
    assert.equal(clonedRecord.first, clonedRecord.second)
    assert.deepEqual(clonedRecord.first, { keep: true })
    const clonedMap = clonedRecord.map as Map<string, Record<string, unknown>>
    const clonedSet = clonedRecord.set as Set<Record<string, unknown>>
    const clonedNestedRecord = clonedMap.get('nested')!
    assert.equal(clonedMap instanceof Map, true)
    assert.equal(clonedSet instanceof Set, true)
    assert.equal(Object.getPrototypeOf(clonedNestedRecord), null)
    assert.equal(clonedNestedRecord.parent, clonedRecord)
    assert.equal(clonedSet.has(clonedNestedRecord), true)
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

  it('keeps an uncertain Save As create blocked after Reset', () => {
    const failure = classifyCreateStartFailure(new TypeError('Failed to fetch'))
    const afterReset = resolveCreateOutcomeUncertainAfterReset(failure.outcomeUncertain)

    assert.equal(afterReset, true)
    assert.equal(!afterReset, false)
  })

  it('allows existing background saves to continue through navigation', () => {
    assert.equal(
      shouldBlockEditorNavigation(false, {
        backgroundSaveActive: false,
        cardMutationActive: false,
      }),
      false,
    )
    assert.equal(
      shouldBlockEditorNavigation(false, {
        backgroundSaveActive: true,
        cardMutationActive: false,
      }),
      false,
    )
    assert.equal(
      shouldBlockEditorNavigation(true, {
        backgroundSaveActive: true,
        cardMutationActive: false,
      }),
      true,
    )
    assert.equal(
      shouldBlockEditorNavigation(false, {
        backgroundSaveActive: false,
        cardMutationActive: true,
      }),
      true,
    )
  })

  it('treats a Save As copy as an unsaved draft for Reset, navigation, and unload', () => {
    assert.equal(
      resetEditorTitle(true, true, 'Copy of Source title'),
      'Copy of Source title',
    )
    assert.equal(shouldConfirmEditorNavigation(true, true, false), true)
    assert.equal(
      shouldWarnBeforeUnload(true, {
        backgroundSaveActive: false,
        cardMutationActive: false,
      }),
      true,
    )
    assert.equal(
      shouldBlockEditorNavigation(true, {
        backgroundSaveActive: true,
        cardMutationActive: false,
      }),
      true,
    )
  })

  it('executes the ordinary Reset title path for existing cards and new drafts', () => {
    assert.equal(resetEditorTitle(false, false, 'Original title'), 'Original title')
    assert.equal(resetEditorTitle(true, false, 'Ignored baseline'), '')
  })

  it('retains unload protection throughout a foreground card mutation', () => {
    const beforeMutation = {
      backgroundSaveActive: false,
      cardMutationActive: false,
    }
    const duringMutation = {
      backgroundSaveActive: false,
      cardMutationActive: true,
    }

    assert.equal(shouldWarnBeforeUnload(true, beforeMutation), true)
    assert.equal(shouldWarnBeforeUnload(true, duringMutation), true)
  })

  it('updates unload protection after card mutation success or failure', () => {
    const mutationFinished = {
      backgroundSaveActive: false,
      cardMutationActive: false,
    }

    assert.equal(shouldWarnBeforeUnload(false, mutationFinished), false)
    assert.equal(shouldWarnBeforeUnload(true, mutationFinished), true)
  })

  it('suppresses unload protection for resumable background saves', () => {
    assert.equal(
      shouldWarnBeforeUnload(true, {
        backgroundSaveActive: true,
        cardMutationActive: false,
      }),
      false,
    )
  })

  it('locks navigation and unload while an irreversible deletion is unresolved', () => {
    const deletionLocks = {
      backgroundSaveActive: false,
      cardMutationActive: false,
      deletionActive: true,
    }
    assert.equal(shouldBlockEditorNavigation(false, deletionLocks), true)
    assert.equal(shouldWarnBeforeUnload(false, deletionLocks), true)
  })
})

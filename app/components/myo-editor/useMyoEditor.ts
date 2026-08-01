import type { InjectionKey } from 'vue'
import type { PlaylistTrack } from '~/components/playlist/types'
import { playlistRowId } from '#shared/myo-editor/playlistRowId'
import {
  classifyCreateStartFailure,
  cloneCardSaveSnapshot,
  type CardSaveSnapshot,
  type ClientSaveIdentity,
  type ClientSaveTarget,
  getStandalonePlaylistValidationError,
  isPlaylistEditorActive,
  NEW_PLAYLIST_SAVE_KEY,
  notifyConfirmedCardUpdated,
  notifyConfirmedPlaylistCreated,
  resolveClientSaveTarget,
  resolveSavedCardId,
  shouldBlockEditorNavigation,
  shouldWarnBeforeUnload,
} from '#shared/myo-editor/standalonePlaylist'
import type { SaveJobPhase } from '#shared/myo-editor/types'
import {
  classifyExistingCardChanges,
  getCardTitleValidationError,
  resetCardTitle,
  type MutateCardRequest,
} from '#shared/yoto/cardMutation'
import type { YotoMyoCard } from '~/components/yoto-myo/types'
import { cardToPlaylist } from './cardToPlaylist'
import {
  addPersistedSave,
  readPersistedSaves,
  removePersistedSave,
} from './saveJobPersistence'
import type { SaveJobState, YotoCardDetail } from './types'
import {
  getPlaylistPreflightLimitError,
  getTrackCountLimitError,
} from '#shared/myo-editor/yotoMyoLimits'

export interface SaveProgress {
  phase: SaveJobState['status']
  progress: number
  operationProgress: number
  error?: string
  tracks: SaveJobState['tracks']
}

export interface CardSaveState {
  saveKey: string
  /** Populated only when Yoto has supplied or Louis already has a real card ID. */
  cardId?: string
  jobId: string
  status: SaveJobPhase
  progress: number
  operationProgress: number
  tracks: SaveJobState['tracks']
  error?: string
  snapshot: CardSaveSnapshot
  startedAt: number
}

export interface MyoEditorContext {
  selectedCardId: Ref<string | null>
  isNewPlaylist: Ref<boolean>
  cardTitle: Ref<string>
  playlist: Ref<PlaylistTrack[]>
  isEditing: ComputedRef<boolean>
  isPodcast: Ref<boolean>
  loading: Ref<boolean>
  updating: ComputedRef<boolean>
  isPlaylistLocked: ComputedRef<boolean>
  isNavigationLocked: ComputedRef<boolean>
  saveProgress: ComputedRef<SaveProgress | null>
  errorMessage: Ref<string>
  createOutcomeUncertain: Ref<boolean>
  titleDirty: ComputedRef<boolean>
  playlistDirty: ComputedRef<boolean>
  isDirty: ComputedRef<boolean>
  isCardSaving: (cardId: string) => boolean
  startNewPlaylist: () => boolean
  selectCard: (card: YotoMyoCard) => Promise<void>
  clearSelection: (force?: boolean) => boolean
  resetChanges: () => void
  appendTracks: (tracks: PlaylistTrack[]) => { ok: true, added: number } | { ok: false, message: string }
  createPlaylist: (options?: { acknowledgeCapacityRisk?: boolean }) => Promise<void>
  updateCard: (options?: { acknowledgeCapacityRisk?: boolean }) => Promise<void>
}

export const MYO_EDITOR_KEY: InjectionKey<MyoEditorContext> = Symbol('myoEditor')

function playlistSnapshot(playlist: PlaylistTrack[]): string {
  return JSON.stringify(playlist.map(playlistRowId))
}

function clonePlaylist(playlist: PlaylistTrack[]): PlaylistTrack[] {
  return playlist.map(item => ({ ...item }))
}

function isTerminalStatus(status: SaveJobPhase): boolean {
  return status === 'complete' || status === 'failed'
}

function jobToSaveProgress(state: CardSaveState): SaveProgress {
  return {
    phase: state.status,
    progress: state.progress,
    operationProgress: state.operationProgress,
    error: state.error,
    tracks: state.tracks,
  }
}

function saveStateFromJob(
  saveKey: string,
  job: SaveJobState,
  snapshot: CardSaveSnapshot,
  startedAt: number,
): CardSaveState {
  return {
    saveKey,
    cardId: job.cardId,
    jobId: job.id,
    status: job.status,
    progress: monotonicOverallProgress(saveKey, job.progress),
    operationProgress: job.operationProgress ?? 0,
    error: job.error,
    tracks: job.tracks,
    snapshot,
    startedAt,
  }
}

const POLL_INTERVAL_MS = 1000
const POLL_TIMEOUT_MS = 30 * 60 * 1000
const MIN_COMPLETE_DISPLAY_MS = 450

const pollingJobIds = new Set<string>()
const maxOverallProgressBySaveKey = new Map<string, number>()

export interface UseMyoEditorOptions {
  onPlaylistCreated?: (cardId: string) => void
  onCardUpdated?: (cardId: string) => void | Promise<void>
}

function monotonicOverallProgress(saveKey: string, next: number): number {
  const prev = maxOverallProgressBySaveKey.get(saveKey) ?? 0
  const value = Math.max(prev, Math.min(100, Math.round(next)))
  maxOverallProgressBySaveKey.set(saveKey, value)
  return value
}

function clearProgressTracking(saveKey: string) {
  maxOverallProgressBySaveKey.delete(saveKey)
}

export function useMyoEditor(options: UseMyoEditorOptions = {}) {
  const { playEvent } = useUiSound()
  const selectedCardId = ref<string | null>(null)
  const isNewPlaylist = ref(false)
  const cardTitle = ref('')
  const baselineCardTitle = ref('')
  const cardRevision = ref('')
  const playlist = ref<PlaylistTrack[]>([])
  const baselinePlaylist = ref<PlaylistTrack[]>([])
  const originalCardDetail = ref<YotoCardDetail | null>(null)
  const isPodcast = ref(false)
  const loading = ref(false)
  const errorMessage = ref('')
  const createOutcomeUncertain = ref(false)
  const titleMutationCardId = ref<string | null>(null)
  const activeSaves = ref(new Map<string, CardSaveState>())

  function touchActiveSaves() {
    activeSaves.value = new Map(activeSaves.value)
  }

  function getSaveState(saveKey: string): CardSaveState | undefined {
    return activeSaves.value.get(saveKey)
  }

  function setSaveState(saveKey: string, state: CardSaveState) {
    activeSaves.value.set(saveKey, state)
    touchActiveSaves()
  }

  function deleteSaveState(saveKey: string) {
    if (!activeSaves.value.has(saveKey)) return
    activeSaves.value.delete(saveKey)
    clearProgressTracking(saveKey)
    touchActiveSaves()
  }

  function isSaveActive(saveKey: string): boolean {
    const state = getSaveState(saveKey)
    return Boolean(state && !isTerminalStatus(state.status))
  }

  function isCardSaving(cardId: string): boolean {
    return titleMutationCardId.value === cardId || isSaveActive(cardId)
  }

  const isEditing = computed(() =>
    isPlaylistEditorActive(selectedCardId.value, isNewPlaylist.value),
  )

  const playlistDirty = computed(
    () => playlistSnapshot(playlist.value) !== playlistSnapshot(baselinePlaylist.value),
  )

  const existingCardChanges = computed(() =>
    classifyExistingCardChanges(
      cardTitle.value,
      baselineCardTitle.value,
      playlistDirty.value,
    ),
  )

  const titleDirty = computed(
    () => !isNewPlaylist.value && existingCardChanges.value.titleDirty,
  )

  const isDirty = computed(() =>
    isNewPlaylist.value
      ? Boolean(cardTitle.value.trim() || playlist.value.length > 0)
      : existingCardChanges.value.isDirty,
  )

  const selectedSaveKey = computed(() =>
    isNewPlaylist.value ? NEW_PLAYLIST_SAVE_KEY : selectedCardId.value,
  )

  const selectedSaveState = computed(() => {
    const saveKey = selectedSaveKey.value
    if (!saveKey) return null
    return getSaveState(saveKey) ?? null
  })

  const backgroundSaveActive = computed(() => {
    const state = selectedSaveState.value
    return Boolean(state && !isTerminalStatus(state.status))
  })

  const titleMutationActive = computed(
    () => titleMutationCardId.value !== null
      && titleMutationCardId.value === selectedCardId.value,
  )

  const isPlaylistLocked = computed(
    () => titleMutationActive.value || backgroundSaveActive.value,
  )

  const isNavigationLocked = computed(() =>
    shouldBlockEditorNavigation(isNewPlaylist.value, {
      backgroundSaveActive: backgroundSaveActive.value,
      titleMutationActive: titleMutationActive.value,
    }),
  )

  const updating = computed(() => isPlaylistLocked.value)

  const saveProgress = computed<SaveProgress | null>(() => {
    const state = selectedSaveState.value
    if (!state || isTerminalStatus(state.status)) return null
    return jobToSaveProgress(state)
  })

  function restoreSnapshot(snapshot: CardSaveSnapshot) {
    const restored = cloneCardSaveSnapshot(snapshot)
    playlist.value = restored.playlist
    baselinePlaylist.value = restored.baseline
    cardTitle.value = restored.cardTitle
    baselineCardTitle.value = restored.baselineCardTitle
    cardRevision.value = restored.cardRevision
  }

  async function reloadCardFromApi(cardId: string, titleFallback?: string) {
    const detail = await $fetch<YotoCardDetail>(`/api/yoto/content/${cardId}`)
    originalCardDetail.value = detail
    const result = await cardToPlaylist(detail)
    isPodcast.value = result.isPodcast
    playlist.value = result.tracks
    baselinePlaylist.value = clonePlaylist(playlist.value)
    cardTitle.value = titleFallback || detail.title
    baselineCardTitle.value = cardTitle.value
    cardRevision.value = detail.revision
  }

  async function finalizeSaveSuccess(cardId: string, titleFallback?: string) {
    const isSelected = selectedCardId.value === cardId
    const displayStartedAt = Date.now()

    if (isSelected) {
      const existing = getSaveState(cardId)
      if (existing) {
        setSaveState(cardId, {
          ...existing,
          status: 'posting',
          progress: monotonicOverallProgress(cardId, 100),
          operationProgress: 100,
          tracks: existing.tracks.map(track => ({
            ...track,
            status: track.status === 'failed' ? 'failed' : 'ready',
          })),
        })
      }
      await nextTick()
    }

    if (isSelected) {
      try {
        await reloadCardFromApi(cardId, titleFallback)
        errorMessage.value = ''
        await nextTick()
      }
      catch (err: unknown) {
        const e = err as { statusMessage?: string; message?: string }
        errorMessage.value = e.statusMessage ?? e.message ?? 'Failed to reload card after save'
      }
    }

    if (isSelected) {
      const remaining = MIN_COMPLETE_DISPLAY_MS - (Date.now() - displayStartedAt)
      if (remaining > 0) {
        await new Promise(resolve => setTimeout(resolve, remaining))
      }
    }

    if (isSelected) {
      playEvent('saveComplete')
    }

    deleteSaveState(cardId)
    removePersistedSave(cardId)
  }

  function handleSaveFailed(
    saveKey: string,
    message: string,
    outcomeUncertain = false,
  ) {
    playEvent('saveError')
    const displayMessage = message.length > 240 ? `${message.slice(0, 237)}…` : message
    deleteSaveState(saveKey)
    removePersistedSave(saveKey)

    if (selectedSaveKey.value === saveKey) {
      if (saveKey === NEW_PLAYLIST_SAVE_KEY && outcomeUncertain) {
        createOutcomeUncertain.value = true
      }
      errorMessage.value = displayMessage
    }
  }

  function updateSaveStateFromJob(saveKey: string, job: SaveJobState) {
    const existing = getSaveState(saveKey)
    if (!existing) return

    const isComplete = job.status === 'complete'

    setSaveState(saveKey, {
      ...existing,
      status: isComplete ? 'posting' : job.status,
      progress: monotonicOverallProgress(
        saveKey,
        isComplete ? 100 : job.progress,
      ),
      operationProgress: isComplete ? 100 : (job.operationProgress ?? existing.operationProgress),
      error: job.error,
      tracks: job.tracks,
    })
  }

  function promoteCreatedPlaylist(saveKey: string, cardId: string) {
    const state = getSaveState(saveKey)
    if (state) {
      activeSaves.value.delete(saveKey)
      clearProgressTracking(saveKey)
      maxOverallProgressBySaveKey.set(cardId, state.progress)
      activeSaves.value.set(cardId, { ...state, saveKey: cardId, cardId })
      baselinePlaylist.value = clonePlaylist(state.snapshot.playlist)
      cardTitle.value = state.snapshot.cardTitle
      touchActiveSaves()
    }

    selectedCardId.value = cardId
    isNewPlaylist.value = false
    createOutcomeUncertain.value = false
  }

  async function pollSaveJob(
    saveKey: string,
    jobId: string,
    titleFallback: string,
    target: ClientSaveIdentity,
  ) {
    if (pollingJobIds.has(jobId)) return
    pollingJobIds.add(jobId)

    const existing = getSaveState(saveKey)
    const startedAt = existing?.startedAt ?? Date.now()

    try {
      let job = await $fetch<SaveJobState>(`/api/yoto/jobs/${jobId}`)
      updateSaveStateFromJob(saveKey, job)

      while (!isTerminalStatus(job.status)) {
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          handleSaveFailed(
            saveKey,
            target.operation === 'create'
              ? 'Create timed out. Check My Cards before trying again.'
              : 'Save timed out. Check your card in Yoto and try again.',
            target.operation === 'create',
          )
          return
        }

        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
        job = await $fetch<SaveJobState>(`/api/yoto/jobs/${jobId}`)
        updateSaveStateFromJob(saveKey, job)
      }

      if (job.status === 'failed') {
        handleSaveFailed(
          saveKey,
          job.error ?? 'Save failed',
          target.operation === 'create' && job.outcomeUncertain === true,
        )
        return
      }

      let savedCardId: string
      try {
        savedCardId = resolveSavedCardId(
          target.operation,
          target.operation === 'update' ? target.cardId : null,
          job.cardId,
        )
      }
      catch (err: unknown) {
        const e = err as { message?: string }
        handleSaveFailed(
          saveKey,
          e.message ?? 'Failed to resolve saved card ID',
          target.operation === 'create',
        )
        return
      }

      if (target.operation === 'create') {
        promoteCreatedPlaylist(saveKey, savedCardId)
      }
      await finalizeSaveSuccess(savedCardId, titleFallback)
      await notifyConfirmedCardUpdated(
        target.operation,
        job.status,
        savedCardId,
        options.onCardUpdated,
      )
      notifyConfirmedPlaylistCreated(target.operation, savedCardId, options.onPlaylistCreated)
    }
    catch (err: unknown) {
      const e = err as { statusCode?: number; statusMessage?: string; message?: string }
      if (e.statusCode === 404 && target.operation === 'update') {
        deleteSaveState(saveKey)
        removePersistedSave(saveKey)
        return
      }
      handleSaveFailed(
        saveKey,
        target.operation === 'create'
          ? 'Could not confirm whether Yoto created this playlist. Check My Cards before trying again.'
          : e.statusMessage ?? e.message ?? 'Failed to track save progress',
        target.operation === 'create',
      )
    }
    finally {
      pollingJobIds.delete(jobId)
    }
  }

  async function startSaveJob(
    target: ClientSaveTarget,
    snapshot: CardSaveSnapshot,
    options?: { acknowledgeCapacityRisk?: boolean },
  ) {
    const identity = resolveClientSaveTarget(target)
    const { jobId } = await $fetch<{ jobId: string }>(
      identity.endpoint,
      {
        method: 'POST',
        body: {
          playlist: snapshot.playlist,
          baselinePlaylist: snapshot.baseline,
          cardTitle: snapshot.cardTitle,
          acknowledgeCapacityRisk: options?.acknowledgeCapacityRisk === true,
        },
      },
    )

    const startedAt = Date.now()
    const initialState: CardSaveState = {
      saveKey: identity.saveKey,
      cardId: identity.operation === 'update' ? identity.cardId : undefined,
      jobId,
      status: 'planning',
      progress: 0,
      operationProgress: 0,
      tracks: [],
      snapshot: cloneCardSaveSnapshot(snapshot),
      startedAt,
    }
    maxOverallProgressBySaveKey.set(identity.saveKey, 0)
    setSaveState(identity.saveKey, initialState)
    if (identity.operation === 'update') {
      addPersistedSave(identity.cardId, jobId)
    }

    void pollSaveJob(identity.saveKey, jobId, snapshot.cardTitle, identity)
  }

  async function hydratePersistedSaves() {
    const persisted = readPersistedSaves()

    for (const [cardId, { jobId, startedAt }] of Object.entries(persisted)) {
      if (getSaveState(cardId)) continue

      try {
        const job = await $fetch<SaveJobState>(`/api/yoto/jobs/${jobId}`)

        if (isTerminalStatus(job.status)) {
          removePersistedSave(cardId)
          if (job.status === 'failed' && selectedCardId.value === cardId) {
            errorMessage.value = job.error ?? 'Save failed'
          }
          if (job.status === 'complete' && selectedCardId.value === cardId) {
            await finalizeSaveSuccess(cardId)
          }
          await notifyConfirmedCardUpdated(
            'update',
            job.status,
            cardId,
            options.onCardUpdated,
          )
          continue
        }

        const placeholderSnapshot: CardSaveSnapshot = {
          playlist: [],
          baseline: [],
          cardTitle: '',
          baselineCardTitle: '',
          cardRevision: '',
        }
        setSaveState(
          cardId,
          saveStateFromJob(cardId, job, placeholderSnapshot, startedAt),
        )

        if (selectedCardId.value === cardId) {
          errorMessage.value = ''
        }

        const target = resolveClientSaveTarget({ operation: 'update', cardId })
        void pollSaveJob(cardId, jobId, '', target)
      }
      catch (err: unknown) {
        const e = err as { statusCode?: number }
        if (e.statusCode === 404) {
          removePersistedSave(cardId)
        }
      }
    }
  }

  async function selectCard(card: YotoMyoCard) {
    if (loading.value || isNavigationLocked.value) return

    const currentSaveKey = selectedSaveKey.value
    const currentCardSaving = currentSaveKey ? isSaveActive(currentSaveKey) : false

    if (isNewPlaylist.value && currentCardSaving) return

    if (isEditing.value && isDirty.value && !currentCardSaving) {
      const confirmed = window.confirm(
        'You have unsaved playlist changes. Switch cards anyway?',
      )
      if (!confirmed) return
    }

    if (selectedCardId.value === card.cardId && !errorMessage.value) {
      return
    }

    loading.value = true
    errorMessage.value = ''
    createOutcomeUncertain.value = false
    isNewPlaylist.value = false
    selectedCardId.value = card.cardId
    cardTitle.value = card.title

    const inFlightSave = getSaveState(card.cardId)
    if (inFlightSave && !isTerminalStatus(inFlightSave.status)) {
      if (inFlightSave.snapshot.playlist.length > 0) {
        restoreSnapshot(inFlightSave.snapshot)
        isPodcast.value = false
        loading.value = false
        return
      }

      try {
        await reloadCardFromApi(card.cardId)
      }
      catch (err: unknown) {
        const e = err as { statusMessage?: string; message?: string }
        errorMessage.value = e.statusMessage ?? e.message ?? 'Failed to load card'
        isPodcast.value = false
        playlist.value = []
        baselinePlaylist.value = []
        baselineCardTitle.value = ''
        cardRevision.value = ''
        originalCardDetail.value = null
      }
      finally {
        loading.value = false
      }
      return
    }

    try {
      await reloadCardFromApi(card.cardId)
    }
    catch (err: unknown) {
      const e = err as { statusMessage?: string; message?: string }
      errorMessage.value = e.statusMessage ?? e.message ?? 'Failed to load card'
      isPodcast.value = false
      playlist.value = []
      baselinePlaylist.value = []
      baselineCardTitle.value = ''
      cardRevision.value = ''
      originalCardDetail.value = null
    }
    finally {
      loading.value = false
    }
  }

  function startNewPlaylist(): boolean {
    if (loading.value || isNavigationLocked.value) return false

    const currentSaveKey = selectedSaveKey.value
    const currentCardSaving = currentSaveKey ? isSaveActive(currentSaveKey) : false
    if (isEditing.value && isDirty.value && !currentCardSaving) {
      const confirmed = window.confirm(
        'You have unsaved playlist changes. Start a new playlist anyway?',
      )
      if (!confirmed) return false
    }

    selectedCardId.value = null
    isNewPlaylist.value = true
    cardTitle.value = ''
    baselineCardTitle.value = ''
    cardRevision.value = ''
    isPodcast.value = false
    playlist.value = []
    baselinePlaylist.value = []
    originalCardDetail.value = null
    errorMessage.value = ''
    createOutcomeUncertain.value = false
    return true
  }

  function clearSelection(force = false): boolean {
    if (isNavigationLocked.value) return false

    const currentSaveKey = selectedSaveKey.value
    const currentCardSaving = currentSaveKey ? isSaveActive(currentSaveKey) : false

    if (!force && isDirty.value && !currentCardSaving) {
      const confirmed = window.confirm(
        'You have unsaved playlist changes. Clear selection anyway?',
      )
      if (!confirmed) return false
    }

    selectedCardId.value = null
    isNewPlaylist.value = false
    cardTitle.value = ''
    baselineCardTitle.value = ''
    cardRevision.value = ''
    isPodcast.value = false
    playlist.value = []
    baselinePlaylist.value = []
    originalCardDetail.value = null
    errorMessage.value = ''
    createOutcomeUncertain.value = false
    return true
  }

  function resetChanges() {
    if (!isDirty.value || isPlaylistLocked.value) return
    playlist.value = clonePlaylist(baselinePlaylist.value)
    cardTitle.value = resetCardTitle(isNewPlaylist.value, baselineCardTitle.value)
    errorMessage.value = ''
    if (isNewPlaylist.value) createOutcomeUncertain.value = false
  }

  function appendTracks(
    tracks: PlaylistTrack[],
  ): { ok: true, added: number } | { ok: false, message: string } {
    if (!isEditing.value) {
      return {
        ok: false,
        message: 'Start a new playlist or select a MYO card before importing a playlist.',
      }
    }
    if (loading.value || isPlaylistLocked.value) {
      return { ok: false, message: 'Wait for the current card operation to finish.' }
    }

    const countError = getTrackCountLimitError(playlist.value.length + tracks.length)
    if (countError) return { ok: false, message: countError }

    const existingKeys = new Set(
      playlist.value.map(track => track.youtubeId ? `youtube:${track.youtubeId}` : `track:${track.id}`),
    )
    const incomingKeys = new Set<string>()
    for (const track of tracks) {
      const key = track.youtubeId ? `youtube:${track.youtubeId}` : `track:${track.id}`
      if (existingKeys.has(key) || incomingKeys.has(key)) {
        return {
          ok: false,
          message: 'The playlist changed while you were reviewing it. Review duplicate tracks and try again.',
        }
      }
      incomingKeys.add(key)
    }

    playlist.value = [...playlist.value, ...clonePlaylist(tracks)]
    errorMessage.value = ''
    return { ok: true, added: tracks.length }
  }

  async function createPlaylist(options?: { acknowledgeCapacityRisk?: boolean }) {
    if (
      !isNewPlaylist.value
      || loading.value
      || isPlaylistLocked.value
      || createOutcomeUncertain.value
    ) return

    const validationError = getStandalonePlaylistValidationError(cardTitle.value, playlist.value)
    if (validationError) {
      errorMessage.value = validationError
      playEvent('saveError')
      return
    }

    if (!options?.acknowledgeCapacityRisk) {
      const limitError = getPlaylistPreflightLimitError(playlist.value)
      if (limitError) {
        errorMessage.value = limitError
        playEvent('saveError')
        return
      }
    }

    errorMessage.value = ''
    const snapshot: CardSaveSnapshot = {
      playlist: clonePlaylist(playlist.value),
      baseline: [],
      cardTitle: cardTitle.value.trim(),
      baselineCardTitle: '',
      cardRevision: '',
    }

    try {
      await startSaveJob({ operation: 'create' }, snapshot, {
        acknowledgeCapacityRisk: options?.acknowledgeCapacityRisk === true,
      })
    }
    catch (err: unknown) {
      const failure = classifyCreateStartFailure(err)
      createOutcomeUncertain.value = failure.outcomeUncertain
      errorMessage.value = failure.message
      playEvent('saveError')
    }
  }

  async function updateCard(saveOptions?: { acknowledgeCapacityRisk?: boolean }) {
    const cardId = selectedCardId.value
    if (!cardId || !isDirty.value || loading.value || isPlaylistLocked.value) return

    if (isPodcast.value) {
      errorMessage.value = 'Podcast cards cannot be edited yet.'
      return
    }

    const titleError = getCardTitleValidationError(cardTitle.value)
    if (titleError) {
      errorMessage.value = titleError
      playEvent('saveError')
      return
    }

    if (existingCardChanges.value.titleOnly) {
      if (!cardRevision.value) {
        errorMessage.value = 'Reload this card before renaming it.'
        playEvent('saveError')
        return
      }

      const request: MutateCardRequest = {
        expectedRevision: cardRevision.value,
        mutations: [{
          kind: 'rename-card',
          expectedTitle: baselineCardTitle.value,
          title: cardTitle.value.trim(),
        }],
      }

      errorMessage.value = ''
      titleMutationCardId.value = cardId
      try {
        await $fetch(`/api/yoto/content/${cardId}/mutate`, {
          method: 'POST',
          body: request,
        })
        await reloadCardFromApi(cardId)
        await options.onCardUpdated?.(cardId)
        playEvent('saveComplete')
      }
      catch (err: unknown) {
        const e = err as {
          statusMessage?: string
          data?: { statusMessage?: string }
          message?: string
        }
        errorMessage.value = e.data?.statusMessage
          ?? e.statusMessage
          ?? e.message
          ?? 'Failed to rename card'
        playEvent('saveError')
      }
      finally {
        titleMutationCardId.value = null
      }
      return
    }

    if (playlistDirty.value && !saveOptions?.acknowledgeCapacityRisk) {
      const limitError = getPlaylistPreflightLimitError(playlist.value)
      if (limitError) {
        errorMessage.value = limitError
        playEvent('saveError')
        return
      }
    }

    errorMessage.value = ''

    const snapshot: CardSaveSnapshot = {
      playlist: clonePlaylist(playlist.value),
      baseline: clonePlaylist(baselinePlaylist.value),
      cardTitle: cardTitle.value.trim(),
      baselineCardTitle: baselineCardTitle.value,
      cardRevision: cardRevision.value,
    }

    try {
      await startSaveJob({ operation: 'update', cardId }, snapshot, {
        acknowledgeCapacityRisk: saveOptions?.acknowledgeCapacityRisk === true,
      })
    }
    catch (err: unknown) {
      const e = err as { statusMessage?: string; message?: string }
      errorMessage.value = e.statusMessage ?? e.message ?? 'Failed to update card'
    }
  }

  function onBeforeUnload(event: BeforeUnloadEvent) {
    event.preventDefault()
    event.returnValue = true
  }

  let stopBeforeUnloadWatch: (() => void) | null = null
  let beforeUnloadAttached = false

  onMounted(() => {
    stopBeforeUnloadWatch = watch(
      [isDirty, backgroundSaveActive, titleMutationActive],
      ([dirty, saveActive, mutationActive]) => {
        const shouldAttach = shouldWarnBeforeUnload(dirty, {
          backgroundSaveActive: saveActive,
          titleMutationActive: mutationActive,
        })
        if (shouldAttach === beforeUnloadAttached) return

        window[shouldAttach ? 'addEventListener' : 'removeEventListener'](
          'beforeunload',
          onBeforeUnload,
        )
        beforeUnloadAttached = shouldAttach
      },
      { immediate: true },
    )
    void hydratePersistedSaves()
  })

  onUnmounted(() => {
    stopBeforeUnloadWatch?.()
    if (beforeUnloadAttached) {
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  })

  return {
    selectedCardId,
    isNewPlaylist,
    cardTitle,
    playlist,
    isEditing,
    isPodcast,
    loading,
    updating,
    isPlaylistLocked,
    isNavigationLocked,
    saveProgress,
    errorMessage,
    createOutcomeUncertain,
    titleDirty,
    playlistDirty,
    isDirty,
    isCardSaving,
    startNewPlaylist,
    selectCard,
    clearSelection,
    resetChanges,
    appendTracks,
    createPlaylist,
    updateCard,
  }
}

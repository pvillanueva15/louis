<script setup lang="ts">
import { MYO_EDITOR_KEY } from '~/components/myo-editor/keys'
import { useSaveProgressTestMode } from '~/components/playlist/saveProgressTestFixture'
import PlaylistCapacityMeters from '~/components/playlist/PlaylistCapacityMeters.vue'
import {
  getPlaylistCapacitySnapshot,
  YOTO_MYO_TRACK_COUNT_MESSAGE,
} from '#shared/myo-editor/yotoMyoLimits'
import {
  getStandalonePlaylistValidationError,
  UNCERTAIN_CREATE_START_MESSAGE,
} from '#shared/myo-editor/standalonePlaylist'
import { getCardTitleValidationError } from '#shared/yoto/cardMutation'
import { RAW_STRUCTURAL_MIX_MESSAGE } from '#shared/myo-editor/rawTrackManagement'

const editor = inject(MYO_EDITOR_KEY, null)
const { playEvent } = useUiSound()

const saveProgressTestMode = useSaveProgressTestMode()

const isDirty = editor?.isDirty
const loading = editor?.loading
const isPlaylistLocked = editor?.isPlaylistLocked
const selectedCardId = editor?.selectedCardId
const isNewPlaylist = editor?.isNewPlaylist
const isSaveAsDraft = editor?.isSaveAsDraft
const cardTitle = editor?.cardTitle
const isPodcast = editor?.isPodcast
const errorMessage = editor?.errorMessage
const createOutcomeUncertain = editor?.createOutcomeUncertain
const playlist = editor?.playlist
const playlistDirty = editor?.playlistDirty
const hasRawStructuralConflict = editor?.hasRawStructuralConflict
const rawTrackUndo = editor?.rawTrackUndo
const structuralEditHint = editor?.structuralEditHint
const canDeleteCard = editor?.canDeleteCard

const showCapacityConfirm = ref(false)

const capacity = computed(() => getPlaylistCapacitySnapshot(playlist?.value ?? []))

/** Same threshold as capacity meter red: at or over 100%. */
const overCapacity = computed(() => {
  const { trackCount, trackMax, knownDurationSeconds, durationMax } = capacity.value
  const overTracks = trackMax > 0 && trackCount / trackMax >= 1
  const overTime = durationMax > 0 && knownDurationSeconds / durationMax >= 1
  return overTracks || overTime
})

const overTrackLimit = computed(
  () => capacity.value.trackCount > capacity.value.trackMax,
)

const createValidationError = computed(() =>
  isNewPlaylist?.value
    ? getStandalonePlaylistValidationError(cardTitle?.value ?? '', playlist?.value ?? [], {
        isSaveAsDraft: isSaveAsDraft?.value,
      })
    : null,
)

const updateTitleValidationError = computed(() =>
  !isNewPlaylist?.value && selectedCardId?.value
    ? getCardTitleValidationError(cardTitle?.value ?? '')
    : null,
)

const footerHint = computed(() => {
  if (isPodcast?.value) return 'Podcast cards cannot be edited yet.'
  if (hasRawStructuralConflict?.value) return RAW_STRUCTURAL_MIX_MESSAGE
  if (createOutcomeUncertain?.value) {
    return errorMessage?.value || UNCERTAIN_CREATE_START_MESSAGE
  }
  if (errorMessage?.value) return errorMessage.value
  if (createValidationError.value) return createValidationError.value
  if (updateTitleValidationError.value) return updateTitleValidationError.value
  if (overTrackLimit.value) return YOTO_MYO_TRACK_COUNT_MESSAGE
  return structuralEditHint?.value ?? ''
})

const canSave = computed(() => {
  const ready = Boolean(
    !loading?.value
    && !isPlaylistLocked?.value
    && !saveProgressTestMode.value
    && !isPodcast?.value
    && !hasRawStructuralConflict?.value,
  )
  if (!ready) return false
  if (isNewPlaylist?.value) {
    return !createValidationError.value && !createOutcomeUncertain?.value
  }
  return Boolean(
    selectedCardId?.value
    && isDirty?.value
    && !updateTitleValidationError.value,
  )
})

const actionLabel = computed(() => {
  if (isPlaylistLocked?.value || saveProgressTestMode.value) {
    return isNewPlaylist?.value ? 'Creating...' : 'Updating...'
  }
  if (isNewPlaylist?.value && createOutcomeUncertain?.value) return 'Check My Cards'
  return isNewPlaylist?.value ? 'Create' : 'Update'
})

const canReset = computed(
  () => Boolean(isDirty?.value && !loading?.value && !isPlaylistLocked?.value && !saveProgressTestMode.value),
)

const canSaveAs = computed(() => Boolean(
  selectedCardId?.value
  && !isNewPlaylist?.value
  && !isPodcast?.value
  && !loading?.value
  && !isPlaylistLocked?.value
  && !saveProgressTestMode.value,
))

function closeCapacityConfirm() {
  showCapacityConfirm.value = false
}

function savePlaylist(options?: { acknowledgeCapacityRisk?: boolean }) {
  if (isNewPlaylist?.value) {
    void editor?.createPlaylist(options)
    return
  }
  void editor?.updateCard(options)
}

function onSave() {
  if (!canSave.value) {
    playEvent('disabled')
    return
  }

  if (overCapacity.value && (isNewPlaylist?.value || playlistDirty?.value)) {
    playEvent('buttonPrimary')
    showCapacityConfirm.value = true
    return
  }

  playEvent('buttonPrimary')
  savePlaylist()
}

function onConfirmRiskySave() {
  if (!canSave.value) {
    playEvent('disabled')
    return
  }
  playEvent('buttonPrimary')
  closeCapacityConfirm()
  savePlaylist({ acknowledgeCapacityRisk: true })
}

function onCancelRiskySave() {
  playEvent('resetPlaylist')
  closeCapacityConfirm()
}

function onReset() {
  if (!canReset.value) {
    playEvent('disabled')
    return
  }
  closeCapacityConfirm()
  playEvent('resetPlaylist')
  editor?.resetChanges()
}

function onSaveAs() {
  if (!canSaveAs.value) {
    playEvent('disabled')
    return
  }
  playEvent('buttonPrimary')
  editor?.saveAsCard()
}

function onUndoRemoval() {
  if (!rawTrackUndo?.value || loading?.value || isPlaylistLocked?.value) {
    playEvent('disabled')
    return
  }
  playEvent('resetPlaylist')
  editor?.undoTrackRemoval()
}

function onDelete() {
  if (!canDeleteCard?.value || !editor?.beginCardDeletion()) {
    playEvent('disabled')
    return
  }
  playEvent('buttonPrimary')
}

watch(
  () => [
    overCapacity.value,
    canSave.value,
    isPlaylistLocked?.value,
    saveProgressTestMode.value,
  ],
  () => {
    if (!overCapacity.value || !canSave.value || isPlaylistLocked?.value || saveProgressTestMode.value) {
      closeCapacityConfirm()
    }
  },
)
</script>

<template>
  <div class="panel-footer-shell relative w-full min-w-0 flex-1 overflow-hidden">
    <div class="panel-footer-content flex flex-col gap-2 px-3 sm:px-4 py-[0.375rem] sm:py-[0.4375rem]">
      <p
        v-if="footerHint"
        class="w-full text-[1.25rem] sm:text-[1.45rem] font-maru-mono text-maru-black leading-tight text-pretty"
        role="alert"
      >
        {{ footerHint }}
      </p>
      <div class="w-full flex items-center gap-2 sm:gap-3 min-w-0">
        <PlaylistCapacityMeters />
        <div class="ml-auto flex items-center gap-2 sm:gap-3 shrink-0">
          <button
            v-if="selectedCardId && !isNewPlaylist"
            type="button"
            class="panel-footer-btn panel-footer-btn--short panel-footer-btn--secondary shrink-0 bg-maru-red-lighter"
            :disabled="!canDeleteCard"
            @click="onDelete"
          >
            <span class="panel-footer-btn__label">Delete</span>
          </button>
          <button
            v-if="selectedCardId && !isNewPlaylist"
            type="button"
            class="panel-footer-btn panel-footer-btn--short panel-footer-btn--secondary shrink-0"
            :aria-disabled="!canSaveAs"
            :tabindex="canSaveAs ? 0 : -1"
            @click="onSaveAs"
          >
            <span class="panel-footer-btn__label">Save As</span>
          </button>
          <button
            v-if="rawTrackUndo"
            type="button"
            class="panel-footer-btn panel-footer-btn--short panel-footer-btn--secondary shrink-0"
            :disabled="loading || isPlaylistLocked"
            @click="onUndoRemoval"
          >
            <span class="panel-footer-btn__label">Undo remove</span>
          </button>
          <button
            type="button"
            class="panel-footer-btn panel-footer-btn--short panel-footer-btn--secondary shrink-0"
            :aria-disabled="!canReset"
            :tabindex="canReset ? 0 : -1"
            @click="onReset"
          >
            <span class="panel-footer-btn__label">Reset</span>
          </button>
          <button
            type="button"
            class="panel-footer-btn panel-footer-btn--short panel-footer-btn--primary shrink-0"
            :aria-disabled="!canSave"
            :tabindex="canSave ? 0 : -1"
            @click="onSave"
          >
            <span class="panel-footer-btn__label">{{ actionLabel }}</span>
          </button>
        </div>
      </div>
    </div>

    <div
      class="footer-capacity-confirm"
      :class="{ 'footer-capacity-confirm--open': showCapacityConfirm }"
      role="dialog"
      aria-modal="true"
      aria-labelledby="footer-capacity-confirm-title"
      :aria-hidden="showCapacityConfirm ? undefined : 'true'"
      :inert="showCapacityConfirm ? undefined : true"
    >
      <p
        id="footer-capacity-confirm-title"
        class="footer-capacity-confirm__copy font-maru-mono text-pretty"
      >
        Over MYO limit — {{ isNewPlaylist ? 'create' : 'update' }} may fail.
      </p>
      <div class="footer-capacity-confirm__actions">
        <button
          type="button"
          class="panel-footer-btn panel-footer-btn--short panel-footer-btn--secondary shrink-0"
          @click="onCancelRiskySave"
        >
          <span class="panel-footer-btn__label">Cancel</span>
        </button>
        <button
          type="button"
          class="panel-footer-btn panel-footer-btn--short panel-footer-btn--primary shrink-0"
          @click="onConfirmRiskySave"
        >
          <span class="panel-footer-btn__label">{{ isNewPlaylist ? 'Create' : 'Update' }} anyway</span>
        </button>
      </div>
    </div>
  </div>
</template>

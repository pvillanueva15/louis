<script setup lang="ts">
import IconStaticEditor from './IconStaticEditor.vue'
import CommunityIconSearch from './CommunityIconSearch.vue'
import {
  shouldCloseIconLibraryAfterSelection,
  type PersonalIconEditorSource,
  useIconLibrary,
} from './useIconLibrary'
import { resolveIconAssignmentModalLocks } from '#shared/myo-editor/draftTrackIconAssignment'
import type { PersonalIcon, PersonalIconUploadResponse } from '#shared/yoto/iconContract'

const props = withDefaults(defineProps<{
  selectionMode?: boolean
  selectedMediaId?: string | null
  rapidAssignment?: boolean
  assignmentTargetTitle?: string
  assignmentTargetPosition?: number
  assignmentTargetCount?: number
  assignmentComplete?: boolean
  canPrevious?: boolean
  canNext?: boolean
  busy?: boolean
  selectionUnavailable?: boolean
  draftAssignment?: boolean
  secondaryAction?: 'chapter' | 'none'
}>(), {
  selectionMode: false,
  selectedMediaId: null,
  rapidAssignment: false,
  assignmentTargetTitle: '',
  assignmentTargetPosition: 0,
  assignmentTargetCount: 0,
  assignmentComplete: false,
  canPrevious: false,
  canNext: false,
  busy: false,
  selectionUnavailable: false,
  draftAssignment: false,
  secondaryAction: 'chapter',
})

const emit = defineEmits<{
  select: [icon: PersonalIcon]
  inherit: []
  previous: []
  next: []
}>()

const open = defineModel<boolean>('open', { default: false })

const {
  icons,
  status,
  uploadStatus,
  errorMessage,
  announcement,
  newestMediaId,
  recoveryRequired,
  sourceStatus,
  sourceError,
  sourceErrorCode,
  load,
  upload,
  uploadCopy,
  loadPersonalIconSource,
  cancelPersonalIconSource,
  acceptImportedIcon,
  openSession,
} = useIconLibrary()

const dialog = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
const makeIconButton = ref<HTMLButtonElement | null>(null)
const retryButton = ref<HTMLButtonElement | null>(null)
const editor = ref<{ focusInitial: () => void } | null>(null)
const communitySearch = ref<{ reset: () => void } | null>(null)
const editing = ref(false)
const editorMode = ref<'create' | 'copy'>('create')
const editorSource = ref<PersonalIconEditorSource | null>(null)
const sourceRetryIcon = ref<PersonalIcon | null>(null)
const activeTab = ref<'my' | 'community'>('my')
const communityBusy = ref(false)
const communityAcceptanceBusy = ref(false)
const headingId = 'icon-library-heading'
let restoreFocusTo: HTMLElement | null = null

const uploadBusy = computed(() => uploadStatus.value === 'uploading')
const sourceLoading = computed(() => sourceStatus.value === 'loading')
const modalBusy = computed(() =>
  props.busy || uploadBusy.value || communityBusy.value || communityAcceptanceBusy.value,
)
const interactionLocks = computed(() => resolveIconAssignmentModalLocks({
  operationBusy: modalBusy.value,
  selectionUnavailable: props.selectionUnavailable,
  recoveryRequired: recoveryRequired.value,
}))
const dismissalBlocked = computed(() => interactionLocks.value.dismissalBlocked)
const selectionBlocked = computed(() => interactionLocks.value.selectionBlocked)
const uploadBlocked = computed(() => selectionBlocked.value)
const rapidSelection = computed(() => props.selectionMode && props.rapidAssignment)
const assignmentAnnouncement = computed(() => {
  if (!rapidSelection.value || !props.assignmentTargetCount) return ''
  if (props.assignmentComplete) {
    return `All ${props.assignmentTargetCount} eligible tracks visited. Assignment remains staged until you ${props.draftAssignment ? 'Create' : 'update'} or Reset.`
  }
  return `Track ${props.assignmentTargetPosition} of ${props.assignmentTargetCount}: ${props.assignmentTargetTitle}`
})

async function showEditor() {
  if (uploadBlocked.value) return
  cancelSourceLoad()
  editorMode.value = 'create'
  editorSource.value = null
  editing.value = true
  await nextTick()
  editor.value?.focusInitial()
}

async function showLibrary() {
  cancelSourceLoad()
  editorMode.value = 'create'
  editorSource.value = null
  editing.value = false
  await nextTick()
  makeIconButton.value?.focus()
}

async function editAsCopy(icon: PersonalIcon) {
  if (props.selectionMode || uploadBlocked.value || !icon.url) return
  sourceRetryIcon.value = icon
  const source = await loadPersonalIconSource(icon)
  if (!source) return
  sourceRetryIcon.value = null
  editorMode.value = 'copy'
  editorSource.value = source
  editing.value = true
  await nextTick()
  editor.value?.focusInitial()
}

function clearPersonalSourceProvenance() {
  cancelSourceLoad()
  editorMode.value = 'create'
  editorSource.value = null
}

function cancelSourceLoad() {
  cancelPersonalIconSource()
  sourceRetryIcon.value = null
}

async function retryPersonalIconSource() {
  if (sourceErrorCode.value !== 'temporary' || !sourceRetryIcon.value) return
  await editAsCopy(sourceRetryIcon.value)
}

async function retryLoad() {
  closeButton.value?.focus()
  const loaded = await load()
  await nextTick()
  if (loaded) makeIconButton.value?.focus()
  else retryButton.value?.focus()
}

async function refreshAfterSourceError() {
  cancelSourceLoad()
  await retryLoad()
}

function close() {
  if (dismissalBlocked.value) return
  cancelSourceLoad()
  open.value = false
}

function chooseIcon(icon: PersonalIcon) {
  if (!props.selectionMode || selectionBlocked.value) return
  emit('select', icon)
  if (shouldCloseIconLibraryAfterSelection(props.selectionMode, props.rapidAssignment)) close()
}

function useChapterIcon() {
  if (!props.selectionMode || selectionBlocked.value) return
  emit('inherit')
  if (shouldCloseIconLibraryAfterSelection(props.selectionMode, props.rapidAssignment)) close()
}

function moveAssignment(direction: 'previous' | 'next') {
  if (!rapidSelection.value || selectionBlocked.value) return
  emit(direction)
}

function finishAssignment() {
  if (!rapidSelection.value || dismissalBlocked.value) return
  close()
}

function focusableElements(): HTMLElement[] {
  if (!dialog.value) return []
  return Array.from(dialog.value.querySelectorAll<HTMLElement>(
    'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter(element => !element.hasAttribute('hidden'))
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab') return

  const focusable = focusableElements()
  if (focusable.length === 0) return
  const first = focusable[0]!
  const last = focusable.at(-1)!

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  }
  else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

async function onUpload(blob: Blob, filename: string) {
  const submit = editorMode.value === 'copy' ? uploadCopy : upload
  const succeeded = await submit(blob, filename)
  if (!succeeded && !recoveryRequired.value) return
  cancelSourceLoad()
  editorSource.value = null
  editing.value = false
  await nextTick()
  if (recoveryRequired.value) retryButton.value?.focus()
  else makeIconButton.value?.focus()
}

async function onCommunityAccepted(response: PersonalIconUploadResponse) {
  communityAcceptanceBusy.value = true
  try {
    const refreshed = await acceptImportedIcon(response)
    if (!refreshed) {
      if (recoveryRequired.value) {
        activeTab.value = 'my'
        await nextTick()
        retryButton.value?.focus()
      }
      return
    }
    communityAcceptanceBusy.value = false
    if (props.selectionMode) {
      chooseIcon(response.icon)
      return
    }
    activeTab.value = 'my'
  }
  finally {
    communityAcceptanceBusy.value = false
  }
}

watch(open, async (isOpen) => {
  if (isOpen) {
    restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    editing.value = false
    editorMode.value = 'create'
    editorSource.value = null
    cancelSourceLoad()
    activeTab.value = 'my'
    communityBusy.value = false
    communityAcceptanceBusy.value = false
    communitySearch.value?.reset()
    await nextTick()
    closeButton.value?.focus()
    await openSession()
    return
  }

  cancelSourceLoad()
  editorSource.value = null
  editing.value = false
  await nextTick()
  restoreFocusTo?.focus()
  restoreFocusTo = null
})

onUnmounted(cancelSourceLoad)
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="icon-library" @keydown="onKeydown">
      <div class="icon-library__backdrop" aria-hidden="true" @click="close" />

      <section
        ref="dialog"
        class="icon-library__dialog border-maru rounded-maru bg-maru-white"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="headingId"
        :aria-busy="modalBusy || sourceLoading"
      >
        <header class="icon-library__header border-maru-bottom">
          <div>
            <p class="icon-library__kicker font-maru-bold">Your Yoto account</p>
            <h2 :id="headingId" class="icon-library__title font-maru-bold">
              {{ rapidSelection ? 'Assign track icons' : selectionMode ? 'Choose track icon' : 'My Icons' }}
            </h2>
          </div>
          <button
            ref="closeButton"
            type="button"
            class="icon-library__close"
            :disabled="dismissalBlocked"
            :aria-label="rapidSelection ? 'Close track icon assignment' : selectionMode ? 'Close track icon chooser' : 'Close My Icons'"
            @click="close"
          >
            Close
          </button>
        </header>

        <div v-if="rapidSelection" class="icon-library__assignment">
          <div>
            <span class="icon-library__assignment-position">
              Track {{ assignmentTargetPosition }} of {{ assignmentTargetCount }}
            </span>
            <strong>{{ assignmentTargetTitle }}</strong>
            <small v-if="assignmentComplete">All eligible tracks visited. Choices remain staged until {{ draftAssignment ? 'Create' : 'update' }} or Reset.</small>
          </div>
        </div>

        <div class="icon-library__body">
          <IconStaticEditor
            v-if="editing"
            ref="editor"
            :busy="uploadBusy"
            :initial-source="editorSource"
            :copy-mode="editorMode === 'copy'"
            @cancel="showLibrary"
            @source-replaced="clearPersonalSourceProvenance"
            @upload="onUpload"
          />

          <template v-else>
            <div class="icon-library__tabs" role="tablist" aria-label="Icon library source">
              <button
                type="button"
                role="tab"
                :aria-selected="activeTab === 'my'"
                :disabled="modalBusy || sourceLoading"
                :class="{ 'icon-library__tab--active': activeTab === 'my' }"
                @click="activeTab = 'my'"
              >
                My Icons
              </button>
              <button
                type="button"
                role="tab"
                :aria-selected="activeTab === 'community'"
                :disabled="modalBusy || sourceLoading"
                :class="{ 'icon-library__tab--active': activeTab === 'community' }"
                @click="activeTab = 'community'"
              >
                Community — Experimental
              </button>
            </div>

            <template v-if="activeTab === 'my'">
            <button
              v-if="selectionMode"
              type="button"
              class="icon-library__inherit-button"
              :disabled="selectionBlocked"
              @click="useChapterIcon"
            >
              <span class="icon-library__inherit-mark" aria-hidden="true">↳</span>
              <span>
                <strong>{{ secondaryAction === 'none' ? 'No icon' : 'Use chapter icon' }}</strong>
                <small>{{ secondaryAction === 'none' ? 'Clear both the track and chapter icon.' : 'Remove this track’s explicit override.' }}</small>
              </span>
            </button>

            <div class="icon-library__intro">
              <div>
                <h3 class="icon-library__section-title font-maru-bold">Reusable icons</h3>
                <p class="icon-library__section-copy">Browse the tiny pictures already saved to your personal Yoto library.</p>
              </div>
              <button
                ref="makeIconButton"
                type="button"
                class="maru-button maru-button--sm bg-maru-blue text-maru-white"
                :disabled="uploadBlocked"
                @click="showEditor"
              >
                <span class="maru-button__label">Make an icon</span>
              </button>
            </div>

            <div v-if="status === 'loading'" class="icon-library__state" role="status">
              <span class="icon-library__loading-mark" aria-hidden="true" />
              <strong>Loading your icons…</strong>
              <span>Louis is checking your personal Yoto library.</span>
            </div>

            <div v-else-if="recoveryRequired" class="icon-library__state icon-library__state--error" role="alert">
              <strong>Refresh My Icons before uploading again.</strong>
              <span>{{ errorMessage }}</span>
              <button ref="retryButton" type="button" class="icon-library__secondary-button" :disabled="modalBusy" @click="retryLoad">
                Refresh My Icons
              </button>
            </div>

            <div v-else-if="sourceStatus === 'loading'" class="icon-library__state" role="status">
              <span class="icon-library__loading-mark" aria-hidden="true" />
              <strong>Opening a copy in Icon Studio…</strong>
              <button type="button" class="icon-library__secondary-button" @click="cancelSourceLoad">
                Cancel
              </button>
            </div>

            <div v-else-if="sourceStatus === 'error'" class="icon-library__state icon-library__state--error" role="alert">
              <strong>We couldn’t open that icon.</strong>
              <span>{{ sourceError }}</span>
              <button v-if="sourceErrorCode === 'unavailable'" type="button" class="icon-library__secondary-button" :disabled="modalBusy" @click="refreshAfterSourceError">
                Refresh My Icons
              </button>
              <a v-else-if="sourceErrorCode === 'authentication'" class="icon-library__secondary-button" href="/api/yoto/auth/login">
                Reconnect to Yoto
              </a>
              <button v-else-if="sourceErrorCode === 'temporary'" type="button" class="icon-library__secondary-button" :disabled="modalBusy" @click="retryPersonalIconSource">
                Try again
              </button>
            </div>

            <div v-else-if="status === 'error'" class="icon-library__state icon-library__state--error">
              <strong>We couldn’t load your icons.</strong>
              <span>{{ errorMessage }}</span>
              <button ref="retryButton" type="button" class="icon-library__secondary-button" :disabled="modalBusy" @click="retryLoad">
                {{ recoveryRequired ? 'Refresh library' : 'Try again' }}
              </button>
            </div>

            <div v-else-if="icons.length === 0" class="icon-library__state">
              <div class="icon-library__empty-pixel" aria-hidden="true" />
              <strong>No personal icons yet</strong>
              <span>Turn a favorite photo or drawing into your first reusable 16×16 icon.</span>
              <button type="button" class="icon-library__secondary-button" :disabled="uploadBlocked" @click="showEditor">Make the first one</button>
            </div>

            <ul v-else class="icon-library__grid" aria-label="Personal Yoto icons">
              <li
                v-for="(icon, index) in icons"
                :key="icon.displayIconId"
                class="icon-library__item"
                :class="{
                  'icon-library__item--newest': icon.mediaId === newestMediaId,
                  'icon-library__item--selected': selectionMode && icon.mediaId === selectedMediaId,
                }"
              >
                <button
                  v-if="selectionMode"
                  type="button"
                  class="icon-library__pick"
                  :disabled="selectionBlocked"
                  :aria-label="`Use personal icon ${index + 1}`"
                  :aria-pressed="icon.mediaId === selectedMediaId"
                  @click="chooseIcon(icon)"
                >
                  <span class="icon-library__icon-stage icon-library__checkerboard">
                    <img v-if="icon.url" :src="icon.url" alt="" loading="lazy">
                    <span v-else class="icon-library__missing-preview" aria-hidden="true">?</span>
                  </span>
                </button>
                <div v-else class="icon-library__icon-stage icon-library__checkerboard">
                  <img v-if="icon.url" :src="icon.url" :alt="`Personal icon ${index + 1}`" loading="lazy">
                  <span v-else class="icon-library__missing-preview" aria-label="Preview unavailable">?</span>
                </div>
                <button
                  v-if="!selectionMode"
                  type="button"
                  class="icon-library__edit-copy"
                  :disabled="uploadBlocked || !icon.url"
                  :aria-label="icon.url ? `Edit personal icon ${index + 1} as a copy` : `Personal icon ${index + 1} source unavailable`"
                  @click="editAsCopy(icon)"
                >
                  {{ icon.url ? 'Edit as Copy' : 'Source unavailable' }}
                </button>
                <span v-if="icon.mediaId === newestMediaId" class="icon-library__new-label">Just added</span>
              </li>
            </ul>
            </template>

            <CommunityIconSearch
              v-else
              ref="communitySearch"
              :busy="uploadBlocked || communityAcceptanceBusy"
              :selection-mode="selectionMode"
              @accepted="onCommunityAccepted"
              @busy-change="communityBusy = $event"
            />
          </template>

          <p v-if="errorMessage && !recoveryRequired && (editing || activeTab === 'community' || status !== 'error')" class="icon-library__error" role="alert">{{ errorMessage }}</p>
        </div>

        <footer v-if="rapidSelection" class="icon-library__assignment-nav border-maru-top">
          <button
            type="button"
            class="icon-library__secondary-button"
            :disabled="!canPrevious || selectionBlocked"
            @click="moveAssignment('previous')"
          >
            Previous
          </button>
          <button
            type="button"
            class="icon-library__secondary-button"
            :disabled="!canNext || selectionBlocked"
            @click="moveAssignment('next')"
          >
            Next
          </button>
          <button
            type="button"
            class="maru-button maru-button--sm bg-maru-blue text-maru-white"
            :disabled="dismissalBlocked"
            @click="finishAssignment"
          >
            <span class="maru-button__label">Done</span>
          </button>
        </footer>

        <p class="sr-only" aria-live="polite">{{ announcement }} {{ assignmentAnnouncement }}</p>
      </section>
    </div>
  </Teleport>
</template>

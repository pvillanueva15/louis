<script setup lang="ts">
import IconStaticEditor from './IconStaticEditor.vue'
import CommunityIconSearch from './CommunityIconSearch.vue'
import { useIconLibrary } from './useIconLibrary'
import type { PersonalIcon, PersonalIconUploadResponse } from '#shared/yoto/iconContract'

const props = withDefaults(defineProps<{
  selectionMode?: boolean
  selectedMediaId?: string | null
}>(), {
  selectionMode: false,
  selectedMediaId: null,
})

const emit = defineEmits<{
  select: [icon: PersonalIcon]
  inherit: []
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
  load,
  upload,
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
const activeTab = ref<'my' | 'community'>('my')
const communityBusy = ref(false)
const headingId = 'icon-library-heading'
let restoreFocusTo: HTMLElement | null = null

const uploadBusy = computed(() => uploadStatus.value === 'uploading')
const modalBusy = computed(() => uploadBusy.value || communityBusy.value)
const uploadBlocked = computed(() => uploadBusy.value || recoveryRequired.value)

async function showEditor() {
  if (uploadBlocked.value) return
  editing.value = true
  await nextTick()
  editor.value?.focusInitial()
}

async function showLibrary() {
  editing.value = false
  await nextTick()
  makeIconButton.value?.focus()
}

async function retryLoad() {
  closeButton.value?.focus()
  const loaded = await load()
  await nextTick()
  if (loaded) makeIconButton.value?.focus()
  else retryButton.value?.focus()
}

function close() {
  if (modalBusy.value) return
  open.value = false
}

function chooseIcon(icon: PersonalIcon) {
  if (!props.selectionMode || uploadBusy.value) return
  emit('select', icon)
  close()
}

function useChapterIcon() {
  if (!props.selectionMode || uploadBusy.value) return
  emit('inherit')
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
  const succeeded = await upload(blob, filename)
  if (!succeeded && !recoveryRequired.value) return
  editing.value = false
  await nextTick()
  if (recoveryRequired.value) retryButton.value?.focus()
  else makeIconButton.value?.focus()
}

async function onCommunityAccepted(response: PersonalIconUploadResponse) {
  const refreshed = await acceptImportedIcon(response)
  if (!refreshed) {
    if (recoveryRequired.value) {
      activeTab.value = 'my'
      await nextTick()
      retryButton.value?.focus()
    }
    return
  }
  if (props.selectionMode) {
    emit('select', response.icon)
    close()
    return
  }
  activeTab.value = 'my'
}

watch(open, async (isOpen) => {
  if (isOpen) {
    restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    editing.value = false
    activeTab.value = 'my'
    communityBusy.value = false
    communitySearch.value?.reset()
    await nextTick()
    closeButton.value?.focus()
    await openSession()
    return
  }

  editing.value = false
  await nextTick()
  restoreFocusTo?.focus()
  restoreFocusTo = null
})
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
        :aria-busy="modalBusy"
      >
        <header class="icon-library__header border-maru-bottom">
          <div>
            <p class="icon-library__kicker font-maru-bold">Your Yoto account</p>
            <h2 :id="headingId" class="icon-library__title font-maru-bold">
              {{ selectionMode ? 'Choose track icon' : 'My Icons' }}
            </h2>
          </div>
          <button
            ref="closeButton"
            type="button"
            class="icon-library__close"
            :disabled="modalBusy"
            :aria-label="selectionMode ? 'Close track icon chooser' : 'Close My Icons'"
            @click="close"
          >
            Close
          </button>
        </header>

        <div class="icon-library__body">
          <IconStaticEditor
            v-if="editing"
            ref="editor"
            :busy="uploadBusy"
            @cancel="showLibrary"
            @upload="onUpload"
          />

          <template v-else>
            <div class="icon-library__tabs" role="tablist" aria-label="Icon library source">
              <button
                type="button"
                role="tab"
                :aria-selected="activeTab === 'my'"
                :disabled="modalBusy"
                :class="{ 'icon-library__tab--active': activeTab === 'my' }"
                @click="activeTab = 'my'"
              >
                My Icons
              </button>
              <button
                type="button"
                role="tab"
                :aria-selected="activeTab === 'community'"
                :disabled="modalBusy"
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
              :disabled="uploadBusy"
              @click="useChapterIcon"
            >
              <span class="icon-library__inherit-mark" aria-hidden="true">↳</span>
              <span>
                <strong>Use chapter icon</strong>
                <small>Remove this track’s explicit override.</small>
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

            <div v-else-if="status === 'error'" class="icon-library__state icon-library__state--error">
              <strong>We couldn’t load your icons.</strong>
              <span>{{ errorMessage }}</span>
              <button ref="retryButton" type="button" class="icon-library__secondary-button" @click="retryLoad">
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
                <span v-if="icon.mediaId === newestMediaId" class="icon-library__new-label">Just added</span>
              </li>
            </ul>
            </template>

            <CommunityIconSearch
              v-else
              ref="communitySearch"
              :busy="uploadBlocked"
              :selection-mode="selectionMode"
              @accepted="onCommunityAccepted"
              @busy-change="communityBusy = $event"
            />
          </template>

          <p v-if="errorMessage && (editing || activeTab === 'community' || status !== 'error')" class="icon-library__error" role="alert">{{ errorMessage }}</p>
        </div>

        <p class="sr-only" aria-live="polite">{{ announcement }}</p>
      </section>
    </div>
  </Teleport>
</template>

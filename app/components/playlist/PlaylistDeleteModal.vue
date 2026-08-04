<script setup lang="ts">
import { MYO_EDITOR_KEY } from '~/components/myo-editor/keys'
import {
  restoreCardDeletionFocus,
  resolveCardDeletionTabTarget,
} from '#shared/yoto/cardDeletion'

const editor = inject(MYO_EDITOR_KEY, null)
if (!editor) throw new Error('PlaylistDeleteModal requires MYO_EDITOR_KEY provider')

const dialog = ref<HTMLElement | null>(null)
const titleInput = ref<HTMLInputElement | null>(null)
const enteredTitle = ref('')
const headingId = 'playlist-delete-heading'
const warningId = 'playlist-delete-warning'
let restoreFocusTo: HTMLElement | null = null

const target = editor.deletionTarget
const busy = editor.deletionActive
const errorMessage = editor.errorMessage
const outcomeUncertain = editor.deletionOutcomeUncertain
const canConfirm = computed(() => editor.canSubmitCardDeletion(enteredTitle.value))

function close() {
  if (busy.value) return
  editor.cancelCardDeletion()
}

function focusableElements(): HTMLElement[] {
  if (!dialog.value) return []
  return Array.from(dialog.value.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ))
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab') return

  const focusable = focusableElements()
  if (!dialog.value) return
  const nextTarget = resolveCardDeletionTabTarget(
    dialog.value,
    focusable,
    document.activeElement,
    event.shiftKey,
  )
  if (!nextTarget) return
  event.preventDefault()
  nextTarget.focus()
}

function submit() {
  if (!canConfirm.value || busy.value) return
  void editor.deleteSelectedCard(enteredTitle.value)
}

watch(target, async (nextTarget, previousTarget) => {
  if (nextTarget && !previousTarget) {
    restoreFocusTo = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    enteredTitle.value = ''
    await nextTick()
    titleInput.value?.focus()
    return
  }
  if (!nextTarget && previousTarget) {
    enteredTitle.value = ''
    await nextTick()
    restoreFocus()
    restoreFocusTo = null
  }
})

watch(busy, async (isBusy) => {
  if (!isBusy) return
  await nextTick()
  dialog.value?.focus()
})

function restoreFocus() {
  const activeElement = () => document.activeElement
  restoreCardDeletionFocus(
    restoreFocusTo,
    document.querySelector<HTMLElement>('[data-my-cards-focus-anchor]'),
    activeElement,
  )
}
</script>

<template>
  <Teleport to="body">
    <div v-if="target" class="playlist-delete-modal" @keydown="onKeydown">
      <div class="playlist-delete-modal__backdrop" aria-hidden="true" @click="close" />
      <section
        ref="dialog"
        class="playlist-delete-modal__dialog border-maru rounded-maru bg-maru-white"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        :aria-labelledby="headingId"
        :aria-describedby="warningId"
        :aria-busy="busy"
      >
        <h2 :id="headingId" class="playlist-delete-modal__heading font-maru-bold">
          Delete this playlist?
        </h2>
        <p :id="warningId" class="playlist-delete-modal__warning font-maru-mono">
          This permanently deletes the playlist from Yoto. You cannot undo this action.
        </p>

        <form class="playlist-delete-modal__form" @submit.prevent="submit">
          <label for="playlist-delete-title" class="font-maru-bold">
            Type the exact playlist title to confirm
          </label>
          <code class="playlist-delete-modal__exact-title">{{ target.baselineTitle }}</code>
          <input
            id="playlist-delete-title"
            ref="titleInput"
            v-model="enteredTitle"
            type="text"
            class="playlist-delete-modal__input font-maru-mono"
            autocomplete="off"
            spellcheck="false"
            :disabled="busy"
            :aria-invalid="enteredTitle.length > 0 && !canConfirm"
          >

          <p
            v-if="errorMessage"
            class="playlist-delete-modal__error font-maru-mono"
            role="alert"
            aria-live="assertive"
          >
            {{ errorMessage }}
          </p>
          <p v-else-if="outcomeUncertain" class="playlist-delete-modal__error font-maru-mono" aria-live="assertive">
            Check My Cards before trying again.
          </p>

          <div class="playlist-delete-modal__actions">
            <button
              type="button"
              class="maru-button bg-maru-white text-maru-black"
              :disabled="busy"
              @click="close"
            >
              <span class="maru-button__label">Cancel</span>
            </button>
            <button
              type="submit"
              class="maru-button bg-maru-red text-maru-white"
              :disabled="!canConfirm || busy"
            >
              <span class="maru-button__label">{{ busy ? 'Deleting…' : 'Delete permanently' }}</span>
            </button>
          </div>
        </form>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.playlist-delete-modal {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 1rem;
}

.playlist-delete-modal__backdrop {
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / 62%);
}

.playlist-delete-modal__dialog {
  position: relative;
  width: min(32rem, 100%);
  padding: clamp(1.25rem, 4vw, 2rem);
  box-shadow: 0.5rem 0.5rem 0 var(--color-maru-black);
}

.playlist-delete-modal__dialog:focus-visible {
  outline: 3px solid var(--color-maru-blue);
  outline-offset: 3px;
}

.playlist-delete-modal__heading {
  margin: 0;
  font-size: clamp(1.7rem, 5vw, 2.4rem);
  line-height: 1;
}

.playlist-delete-modal__warning {
  margin: 1rem 0;
  padding: 0.75rem;
  border: 2px solid var(--color-maru-red);
  border-radius: 0.5rem;
  background: var(--color-maru-red-lighter);
}

.playlist-delete-modal__form {
  display: grid;
  gap: 0.75rem;
}

.playlist-delete-modal__exact-title {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  padding: 0.65rem 0.75rem;
  border-radius: 0.5rem;
  background: var(--color-maru-gray-light);
  color: var(--color-maru-black);
}

.playlist-delete-modal__input {
  width: 100%;
  border: 2px solid var(--color-maru-black);
  border-radius: 0.5rem;
  padding: 0.65rem 0.75rem;
  background: var(--color-maru-white);
}

.playlist-delete-modal__input:focus-visible {
  outline: 3px solid var(--color-maru-blue);
  outline-offset: 2px;
}

.playlist-delete-modal__error {
  margin: 0;
  color: var(--color-maru-red);
}

.playlist-delete-modal__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 0.5rem;
}
</style>

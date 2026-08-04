<script setup lang="ts">
import { useCommunityIconSearch } from './useCommunityIconSearch'
import type { PersonalIconUploadResponse } from '#shared/yoto/iconContract'
import type { CommunityIcon } from '#shared/yoto/communityIconContract'

const props = withDefaults(defineProps<{
  busy?: boolean
  selectionMode?: boolean
}>(), {
  busy: false,
  selectionMode: false,
})

const emit = defineEmits<{
  accepted: [response: PersonalIconUploadResponse]
  busyChange: [busy: boolean]
}>()

const {
  query,
  icons,
  status,
  errorMessage,
  nextPage,
  loadingMore,
  importingId,
  uploadOutcomeUncertain,
  canSearch,
  search,
  loadMore,
  importIcon,
  reset,
} = useCommunityIconSearch()

async function addIcon(icon: CommunityIcon) {
  if (props.busy) return
  emit('busyChange', true)
  try {
    const response = await importIcon(icon)
    if (response) emit('accepted', response)
  }
  finally {
    emit('busyChange', false)
  }
}

defineExpose({ reset })
</script>

<template>
  <section class="community-icons" aria-labelledby="community-icons-heading">
    <div class="icon-library__intro">
      <div>
        <h3 id="community-icons-heading" class="icon-library__section-title font-maru-bold">Search Yotoicons</h3>
        <p class="icon-library__section-copy">Experimental: search popular single icons, 25 at a time.</p>
      </div>
    </div>

    <form class="community-icons__search" role="search" @submit.prevent="search">
      <label for="community-icon-query" class="font-maru-bold">Tag or title</label>
      <div class="community-icons__search-row">
        <input
          id="community-icon-query"
          v-model="query"
          type="search"
          maxlength="80"
          autocomplete="off"
          :disabled="busy || uploadOutcomeUncertain || Boolean(importingId)"
        >
        <button
          type="submit"
          class="maru-button maru-button--sm bg-maru-blue text-maru-white"
          :disabled="busy || !canSearch || Boolean(importingId) || status === 'searching'"
        >
          <span class="maru-button__label">Search</span>
        </button>
      </div>
    </form>

    <p class="community-icons__boundary">
      Adding uploads a permanent copy to My Icons. Reset can remove the staged card assignment, but it cannot undo that Yoto library upload.
    </p>

    <div v-if="status === 'idle'" class="icon-library__state">
      <strong>Search when you’re ready</strong>
      <span>Louis never crawls or searches Yotoicons in the background.</span>
    </div>
    <div v-else-if="status === 'searching'" class="icon-library__state" role="status">
      <span class="icon-library__loading-mark" aria-hidden="true" />
      <strong>Searching Yotoicons…</strong>
    </div>
    <div v-else-if="status === 'error'" class="icon-library__state icon-library__state--error">
      <strong>Community search failed.</strong>
      <span>{{ errorMessage }}</span>
    </div>
    <div v-else-if="icons.length === 0" class="icon-library__state">
      <strong>No matching single icons</strong>
      <span>Try another tag or title.</span>
    </div>
    <template v-else>
      <ul class="community-icons__results" aria-label="Community Yotoicons results">
        <li v-for="icon in icons" :key="icon.id" class="community-icons__result">
          <div class="icon-library__icon-stage icon-library__checkerboard">
            <img :src="icon.previewUrl" :alt="icon.title" loading="lazy">
          </div>
          <div class="community-icons__metadata">
            <strong>{{ icon.title }}</strong>
            <span>{{ icon.tags.join(' · ') }}</span>
            <span>by {{ icon.creator }}</span>
            <span v-if="icon.downloads !== null">{{ icon.downloads }} downloads</span>
            <a :href="icon.sourceUrl" target="_blank" rel="noopener noreferrer">View on Yotoicons</a>
          </div>
          <button
            type="button"
            class="icon-library__secondary-button community-icons__add"
            :disabled="busy || uploadOutcomeUncertain || Boolean(importingId)"
            @click="addIcon(icon)"
          >
            {{ importingId === icon.id
              ? 'Adding…'
              : selectionMode ? 'Add to My Icons & use' : 'Add to My Icons' }}
          </button>
        </li>
      </ul>
      <div v-if="nextPage !== null" class="community-icons__load-more">
        <button
          type="button"
          class="maru-button maru-button--sm bg-maru-yellow text-maru-black"
          :disabled="busy || uploadOutcomeUncertain || Boolean(importingId) || loadingMore"
          @click="loadMore"
        >
          <span class="maru-button__label">{{ loadingMore ? 'Loading…' : 'Load more' }}</span>
        </button>
        <span aria-live="polite">Showing {{ icons.length }} icons</span>
      </div>
    </template>

    <p v-if="errorMessage && status !== 'error'" class="icon-library__error" role="alert">{{ errorMessage }}</p>
  </section>
</template>

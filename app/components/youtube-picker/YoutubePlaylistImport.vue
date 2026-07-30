<script setup lang="ts">
import { MYO_EDITOR_KEY } from '~/components/myo-editor/keys'
import { pickerVideoToPlaylistTrack } from '~/components/playlist/types'
import {
  evaluateYoutubePlaylistImport,
  parseYoutubePlaylistUrl,
  preselectYoutubePlaylistImport,
  type YoutubePlaylistImportBlockReason,
  type YoutubePlaylistImportItem,
  type YoutubePlaylistImportResponse,
  type YoutubePlaylistSummary,
} from '#shared/myo-editor/youtubePlaylistImport'
import { formatDurationSeconds } from '#shared/myo-editor/youtubeDuration'

const BLOCK_REASON_LABELS: Record<YoutubePlaylistImportBlockReason, string> = {
  unavailable: 'Unavailable',
  'missing-duration': 'Missing duration',
  'over-track-duration': 'Over 60 minutes',
  'duplicate-existing': 'Already on this card',
  'duplicate-source': 'Repeated in source playlist',
  'track-capacity': 'Card track limit',
  'duration-capacity': 'Card time limit',
}

const editor = inject(MYO_EDITOR_KEY, null)
const { allowLongTracks, setAllowLongTracks } = useUserPreferences()
const { playEvent } = useUiSound()

const open = ref(false)
const url = ref('')
const playlist = ref<YoutubePlaylistSummary | null>(null)
const items = ref<YoutubePlaylistImportItem[]>([])
const selectedKeys = ref(new Set<string>())
const nextPageToken = ref<string | undefined>()
const loading = ref(false)
const loadingMore = ref(false)
const appending = ref(false)
const errorMessage = ref('')
const pageErrorMessage = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

const canOpen = computed(
  () => Boolean(editor?.selectedCardId.value) && !editor?.isPlaylistLocked.value,
)

const evaluation = computed(() =>
  evaluateYoutubePlaylistImport(
    items.value,
    editor?.playlist.value ?? [],
    selectedKeys.value,
    allowLongTracks.value,
  ),
)

const selectedDurationLabel = computed(
  () => formatDurationSeconds(evaluation.value.selectedDurationSeconds),
)

function resetImport() {
  url.value = ''
  playlist.value = null
  items.value = []
  selectedKeys.value = new Set()
  nextPageToken.value = undefined
  loading.value = false
  loadingMore.value = false
  appending.value = false
  errorMessage.value = ''
  pageErrorMessage.value = ''
}

async function show() {
  if (!canOpen.value) {
    playEvent('disabled')
    return
  }
  resetImport()
  open.value = true
  playEvent('buttonClick')
  await nextTick()
  inputRef.value?.focus()
}

function close() {
  if (loading.value || loadingMore.value || appending.value) return
  open.value = false
  playEvent('toggleOff')
}

function fetchErrorMessage(err: unknown, fallback: string): string {
  const fetchErr = err as {
    statusMessage?: string
    data?: { message?: string, statusMessage?: string }
    message?: string
  }
  return fetchErr.data?.message
    ?? fetchErr.data?.statusMessage
    ?? fetchErr.statusMessage
    ?? fetchErr.message
    ?? fallback
}

async function fetchPage(playlistId: string, pageToken?: string) {
  return await $fetch<YoutubePlaylistImportResponse>('/api/youtube/playlist', {
    query: { playlistId, pageToken },
  })
}

async function loadPlaylist() {
  const playlistId = parseYoutubePlaylistUrl(url.value)
  if (!playlistId) {
    errorMessage.value = 'Paste a full HTTPS YouTube playlist URL.'
    return
  }

  loading.value = true
  errorMessage.value = ''
  pageErrorMessage.value = ''
  playlist.value = null
  items.value = []
  selectedKeys.value = new Set()
  nextPageToken.value = undefined

  try {
    const data = await fetchPage(playlistId)
    playlist.value = data.playlist ?? null
    items.value = data.items
    nextPageToken.value = data.nextPageToken
    selectedKeys.value = preselectYoutubePlaylistImport(
      items.value,
      editor?.playlist.value ?? [],
      allowLongTracks.value,
    ).selectedKeys
    playEvent('loadMoreComplete')
  }
  catch (err: unknown) {
    errorMessage.value = fetchErrorMessage(err, 'Failed to load YouTube playlist')
  }
  finally {
    loading.value = false
  }
}

async function loadMore() {
  const playlistId = parseYoutubePlaylistUrl(url.value)
  const token = nextPageToken.value
  if (!playlistId || !token || loadingMore.value) return

  loadingMore.value = true
  pageErrorMessage.value = ''
  try {
    const data = await fetchPage(playlistId, token)
    const requested = new Set(selectedKeys.value)
    for (const item of data.items) requested.add(item.playlistItemId)
    items.value = [...items.value, ...data.items]
    nextPageToken.value = data.nextPageToken
    selectedKeys.value = evaluateYoutubePlaylistImport(
      items.value,
      editor?.playlist.value ?? [],
      requested,
      allowLongTracks.value,
    ).selectedKeys
    playEvent('loadMoreComplete')
  }
  catch (err: unknown) {
    pageErrorMessage.value = fetchErrorMessage(err, 'Failed to load the next page')
  }
  finally {
    loadingMore.value = false
  }
}

function toggleItem(
  playlistItemId: string,
  selected: boolean,
  blockReason?: YoutubePlaylistImportBlockReason,
) {
  if (blockReason && !selected) {
    playEvent('disabled')
    return
  }

  const requested = new Set(selectedKeys.value)
  if (selected) requested.delete(playlistItemId)
  else requested.add(playlistItemId)

  selectedKeys.value = evaluateYoutubePlaylistImport(
    items.value,
    editor?.playlist.value ?? [],
    requested,
    allowLongTracks.value,
  ).selectedKeys
  playEvent(selected ? 'toggleOff' : 'toggleOn')
}

function enableLongTracks() {
  setAllowLongTracks(true)
  playEvent('toggleOn')
}

function appendSelected() {
  if (!editor || appending.value) return

  const latest = evaluateYoutubePlaylistImport(
    items.value,
    editor.playlist.value,
    selectedKeys.value,
    allowLongTracks.value,
  )
  selectedKeys.value = latest.selectedKeys
  if (latest.selectedCount === 0) {
    errorMessage.value = 'Select at least one available track to import.'
    return
  }

  appending.value = true
  errorMessage.value = ''
  const tracks = latest.items
    .filter(entry => entry.selected)
    .map(({ item }) =>
      pickerVideoToPlaylistTrack({
        id: item.videoId,
        title: item.title,
        channelTitle: item.channelTitle,
        thumbnailUrl: item.thumbnailUrl,
        publishedAt: '',
        duration: item.duration,
        durationSeconds: item.durationSeconds,
      }),
    )
  const result = editor.appendTracks(tracks)
  appending.value = false

  if (!result.ok) {
    errorMessage.value = result.message
    return
  }

  playEvent('drop')
  open.value = false
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    close()
  }
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="playlist-import-launch">
    <button
      type="button"
      class="maru-button maru-button--sm bg-maru-yellow text-maru-black"
      :disabled="!canOpen"
      :title="canOpen ? 'Import tracks from a public YouTube playlist' : 'Select a MYO card first'"
      @click="show"
    >
      <span class="maru-button__label">Import playlist</span>
    </button>
  </div>

  <Teleport to="body">
    <div
      v-if="open"
      class="playlist-import"
      @click.self="close"
    >
      <section
        class="playlist-import__dialog border-maru rounded-maru bg-maru-white"
        role="dialog"
        aria-modal="true"
        aria-labelledby="playlist-import-title"
      >
        <header class="playlist-import__header border-maru-bottom">
          <div>
            <h2
              id="playlist-import-title"
              class="font-maru-bold"
            >
              Import a YouTube playlist
            </h2>
            <p class="font-maru-mono">
              Public playlists only. Review every track before adding it.
            </p>
          </div>
          <button
            type="button"
            class="playlist-import__close font-maru-mono"
            aria-label="Close playlist import"
            :disabled="loading || loadingMore || appending"
            @click="close"
          >
            ×
          </button>
        </header>

        <div class="playlist-import__body">
          <form
            class="playlist-import__form"
            @submit.prevent="loadPlaylist"
          >
            <label
              for="playlist-import-url"
              class="font-maru-mono"
            >YouTube playlist URL</label>
            <div class="playlist-import__url-row">
              <input
                id="playlist-import-url"
                ref="inputRef"
                v-model="url"
                type="url"
                inputmode="url"
                autocomplete="off"
                placeholder="https://www.youtube.com/playlist?list=…"
                :disabled="loading || items.length > 0"
              >
              <button
                type="submit"
                class="maru-button maru-button--sm bg-maru-blue text-maru-white"
                :disabled="loading || items.length > 0"
              >
                <span class="maru-button__label">{{ loading ? 'Loading…' : 'Review' }}</span>
              </button>
            </div>
          </form>

          <p
            v-if="errorMessage"
            class="playlist-import__error font-maru-mono"
            role="alert"
          >
            {{ errorMessage }}
          </p>

          <div
            v-if="playlist"
            class="playlist-import__summary"
          >
            <div>
              <h3 class="font-maru-bold">{{ playlist.title }}</h3>
              <p class="font-maru-mono">
                {{ playlist.channelTitle }}
                <template v-if="playlist.itemCount !== undefined">
                  · {{ playlist.itemCount }} source tracks
                </template>
              </p>
            </div>
            <p class="font-maru-mono">
              {{ evaluation.selectedCount }} selected
              <template v-if="selectedDurationLabel">
                · {{ selectedDurationLabel }}
              </template>
            </p>
          </div>

          <ul
            v-if="items.length > 0"
            class="playlist-import__items"
          >
            <li
              v-for="entry in evaluation.items"
              :key="entry.item.playlistItemId"
              class="playlist-import__item"
              :class="{ 'playlist-import__item--blocked': entry.blockReason }"
            >
              <label>
                <input
                  type="checkbox"
                  :checked="entry.selected"
                  :disabled="Boolean(entry.blockReason) && !entry.selected"
                  @change="toggleItem(entry.item.playlistItemId, entry.selected, entry.blockReason)"
                >
                <img
                  v-if="entry.item.thumbnailUrl"
                  :src="entry.item.thumbnailUrl"
                  alt=""
                  loading="lazy"
                >
                <span class="playlist-import__item-copy">
                  <strong class="font-maru-medium">{{ entry.item.title }}</strong>
                  <span class="font-maru-mono">
                    {{ entry.item.channelTitle }}
                    <template v-if="entry.item.durationSeconds">
                      · {{ formatDurationSeconds(entry.item.durationSeconds) }}
                    </template>
                  </span>
                </span>
                <span
                  v-if="entry.blockReason"
                  class="playlist-import__reason font-maru-mono"
                >
                  {{ BLOCK_REASON_LABELS[entry.blockReason] }}
                </span>
              </label>
            </li>
          </ul>

          <div
            v-if="items.length > 0 && !allowLongTracks && evaluation.items.some(entry => entry.blockReason === 'over-track-duration')"
            class="playlist-import__long-tracks font-maru-mono"
          >
            <span>Some tracks are over Yoto’s 60-minute per-track limit.</span>
            <button
              type="button"
              @click="enableLongTracks"
            >
              Allow for this session
            </button>
          </div>

          <p
            v-if="pageErrorMessage"
            class="playlist-import__error font-maru-mono"
            role="alert"
          >
            {{ pageErrorMessage }}
          </p>

          <button
            v-if="nextPageToken"
            type="button"
            class="playlist-import__load-more font-maru-mono"
            :disabled="loadingMore"
            @click="loadMore"
          >
            {{ loadingMore ? 'Loading more…' : 'Load 50 more' }}
          </button>
        </div>

        <footer class="playlist-import__footer border-maru-top">
          <button
            type="button"
            class="maru-button maru-button--sm bg-maru-white text-maru-black"
            :disabled="loading || loadingMore || appending"
            @click="close"
          >
            <span class="maru-button__label">Cancel</span>
          </button>
          <button
            type="button"
            class="maru-button maru-button--sm bg-maru-green-light text-maru-black"
            :disabled="evaluation.selectedCount === 0 || loading || loadingMore || appending"
            @click="appendSelected"
          >
            <span class="maru-button__label">
              Add {{ evaluation.selectedCount || '' }} track{{ evaluation.selectedCount === 1 ? '' : 's' }}
            </span>
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.playlist-import-launch {
  display: flex;
  justify-content: flex-end;
  padding: .5rem 0 .75rem;
}

.playlist-import-launch button:disabled {
  cursor: not-allowed;
  opacity: .45;
}

.playlist-import {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: rgb(0 0 0 / .55);
}

.playlist-import__dialog {
  display: flex;
  width: min(58rem, 100%);
  max-height: min(52rem, calc(100vh - 2rem));
  flex-direction: column;
  overflow: hidden;
  box-shadow: .5rem .5rem 0 rgb(0 0 0 / .25);
}

.playlist-import__header,
.playlist-import__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.25rem;
}

.playlist-import__header h2,
.playlist-import__header p,
.playlist-import__summary h3,
.playlist-import__summary p {
  margin: 0;
}

.playlist-import__header h2 {
  font-size: 2rem;
  line-height: .9;
}

.playlist-import__header p,
.playlist-import__summary p {
  margin-top: .35rem;
  font-size: .85rem;
}

.playlist-import__close {
  border: 0;
  background: transparent;
  font-size: 2rem;
  line-height: 1;
}

.playlist-import__body {
  min-height: 0;
  overflow-y: auto;
  padding: 1rem 1.25rem;
}

.playlist-import__form label {
  display: block;
  margin-bottom: .35rem;
  font-size: .85rem;
}

.playlist-import__url-row {
  display: flex;
  gap: .65rem;
}

.playlist-import__url-row input {
  min-width: 0;
  flex: 1;
  border: 2px solid currentcolor;
  border-radius: var(--radius-maru);
  padding: .65rem .75rem;
  background: white;
  font-family: var(--font-maru-mono);
}

.playlist-import__error {
  margin: .75rem 0 0;
  border-radius: var(--radius-maru);
  padding: .65rem .75rem;
  background: var(--color-maru-red-lighter);
  color: var(--color-maru-red);
}

.playlist-import__summary {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 1rem;
  margin-top: 1rem;
}

.playlist-import__summary h3 {
  font-size: 1.35rem;
  line-height: 1;
}

.playlist-import__items {
  display: grid;
  gap: .4rem;
  margin: 1rem 0 0;
  padding: 0;
  list-style: none;
}

.playlist-import__item {
  border: 2px solid rgb(0 0 0 / .16);
  border-radius: var(--radius-maru);
}

.playlist-import__item--blocked {
  opacity: .6;
}

.playlist-import__item label {
  display: grid;
  grid-template-columns: auto 5.5rem minmax(0, 1fr) auto;
  align-items: center;
  gap: .65rem;
  padding: .5rem;
  cursor: pointer;
}

.playlist-import__item input {
  width: 1.15rem;
  height: 1.15rem;
}

.playlist-import__item img {
  width: 5.5rem;
  aspect-ratio: 16 / 9;
  border-radius: calc(var(--radius-maru) - 3px);
  object-fit: cover;
}

.playlist-import__item-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.playlist-import__item-copy strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.playlist-import__item-copy span,
.playlist-import__reason {
  font-size: .78rem;
}

.playlist-import__reason {
  border-radius: 999px;
  padding: .25rem .45rem;
  background: rgb(0 0 0 / .08);
  white-space: nowrap;
}

.playlist-import__long-tracks {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .75rem;
  margin-top: .75rem;
  font-size: .8rem;
}

.playlist-import__long-tracks button,
.playlist-import__load-more {
  border: 0;
  padding: .35rem 0;
  background: transparent;
  text-decoration: underline;
}

.playlist-import__load-more {
  display: block;
  margin: .75rem auto 0;
}

.playlist-import__footer {
  justify-content: flex-end;
}

@media (max-width: 640px) {
  .playlist-import__url-row,
  .playlist-import__summary,
  .playlist-import__long-tracks {
    align-items: stretch;
    flex-direction: column;
  }

  .playlist-import__item label {
    grid-template-columns: auto 4.5rem minmax(0, 1fr);
  }

  .playlist-import__item img {
    width: 4.5rem;
  }

  .playlist-import__reason {
    grid-column: 2 / -1;
    justify-self: start;
  }
}
</style>

<script setup lang="ts">
import { useDraggable } from '@dnd-kit/vue'
import MaruTooltip from '~/components/ui/MaruTooltip.vue'
import type { ResultsLayout, YoutubeVideoSummary } from './types'
import YoutubePickerAudioControls from './YoutubePickerAudioControls.vue'
import { useAddToPlaylist } from './useAddToPlaylist'
import { resultDragId, type ResultDragData } from '../playlist/dnd'
import {
  formatDurationSeconds,
  formatYoutubeDurationIso,
  isOverMyoTrackDuration,
  YOTO_MYO_LONG_TRACK_CHIP,
  YOTO_MYO_OVER_TRACK_DURATION_FOOTER,
  YOTO_MYO_OVER_TRACK_DURATION_MESSAGE,
  YOTO_MYO_OVER_TRACK_DURATION_TOOLTIP,
} from '#shared/myo-editor/youtubeDuration'

const props = withDefaults(defineProps<{
  video: YoutubeVideoSummary
  focused?: boolean
  layout?: ResultsLayout
}>(), {
  layout: 'list',
})

const emit = defineEmits<{
  select: [id: string]
  enableLongTracks: []
}>()

const { allowLongTracks } = useUserPreferences()
const {
  available: playlistAvailable,
  canAdd,
  isAdded,
  addToPlaylist,
} = useAddToPlaylist()

const element = ref<HTMLElement | null>(null)
const handle = ref<HTMLElement | null>(null)

const overLimit = computed(() => {
  const seconds = props.video.durationSeconds
  return typeof seconds === 'number' && isOverMyoTrackDuration(seconds)
})

/** Over-limit until the user enables long tracks for this session. */
const restricted = computed(() => overLimit.value && !allowLongTracks.value)

/** Unlocked over-hour tracks get a status chip under the thumbnail. */
const showLongTrackChip = computed(() => overLimit.value && allowLongTracks.value)

const durationLabel = computed(() => {
  if (typeof props.video.durationSeconds === 'number') {
    return formatDurationSeconds(props.video.durationSeconds)
  }
  return formatYoutubeDurationIso(props.video.duration)
})

const { isDragging } = useDraggable({
  id: () => resultDragId(props.video.id),
  element,
  handle,
  type: 'result',
  disabled: () => restricted.value,
  data: (): ResultDragData => ({
    type: 'result',
    video: props.video,
  }),
})

const added = computed(() => isAdded(props.video.id))
const addBlocked = computed(() => added.value || !canAdd.value)

const addAriaLabel = computed(() => added.value
  ? `“${props.video.title}” is already in the playlist`
  : `Add “${props.video.title}” to playlist`)

const addTitle = computed(() => added.value ? 'Already in playlist' : 'Add to playlist')

const addButtonClass = computed(() => [
  added.value ? 'yt-result-add--added' : '',
  !added.value && !canAdd.value ? 'yt-result-add--blocked' : '',
])

function onAddToPlaylist(event: Event) {
  event.stopPropagation()
  addToPlaylist(props.video)
}

const shellClass = computed(() => [
  props.focused
    ? 'bg-maru-blue-lighter ring-2 ring-maru-blue'
    : 'bg-maru-white',
  isDragging.value ? 'opacity-50' : '',
  restricted.value ? 'yt-result-card--over-limit' : '',
])

function onEnableLongTracks(event: Event) {
  event.stopPropagation()
  emit('enableLongTracks')
}

</script>

<template>
  <!-- List layout -->
  <div
    v-if="layout === 'list'"
    ref="element"
    class="yt-result-card w-full border-maru rounded-maru overflow-hidden transition-[opacity,box-shadow,background-color]"
    :class="shellClass"
    :title="restricted ? YOTO_MYO_OVER_TRACK_DURATION_MESSAGE : undefined"
    :aria-disabled="restricted || undefined"
  >
    <div class="yt-result-card__main flex items-start gap-3 p-2 pr-3">
      <div class="yt-result-card__thumb relative shrink-0 flex flex-col items-stretch gap-1.5">
        <div
          class="relative block overflow-hidden rounded-[calc(var(--radius-maru)-2px)]"
          @click="emit('select', video.id)"
        >
          <img
            :src="video.thumbnailUrl"
            alt=""
            class="yt-result-card__thumb-img w-24 sm:w-36 aspect-video object-cover"
            loading="lazy"
          >
          <span
            v-if="durationLabel"
            class="yt-result-duration font-maru-mono tabular-nums"
          >{{ durationLabel }}</span>
        </div>
        <button
          v-if="!restricted"
          ref="handle"
          type="button"
          class="playlist-handle absolute top-1.5 left-1.5 z-10 bg-maru-yellow"
          aria-label="Drag to playlist"
        >
          <span /><span /><span />
        </button>
        <span
          v-if="showLongTrackChip"
          class="yt-result-long-chip font-maru-mono"
        >{{ YOTO_MYO_LONG_TRACK_CHIP }}</span>
      </div>

      <div class="yt-result-card__body flex min-w-0 flex-1 flex-col gap-2 py-0.5">
        <button
          type="button"
          class="min-w-0 w-full text-left"
          :aria-label="`Select “${video.title}” by ${video.channelTitle}`"
          @click="emit('select', video.id)"
        >
          <p class="yt-result-card__title font-maru-medium text-[1.6rem] sm:text-[2rem] leading-[0.8] line-clamp-2 max-sm:line-clamp-3 text-pretty">{{ video.title }}</p>
          <p class="yt-result-card__meta font-maru-mono font-maru-regular text-[1.4rem] sm:text-[1.75rem] leading-[0.8] text-maru-black/75 mt-0">{{ video.channelTitle }}</p>
        </button>

        <div class="w-full min-w-0">
          <YoutubePickerAudioControls
            :video-id="video.id"
            :title="video.title"
          />
        </div>
      </div>

      <button
        v-if="playlistAvailable && !restricted"
        type="button"
        class="yt-result-add shrink-0 self-center"
        :class="addButtonClass"
        :aria-disabled="addBlocked || undefined"
        :aria-label="addAriaLabel"
        :title="addTitle"
        @click="onAddToPlaylist"
      >
        <span
          v-if="added"
          class="yt-result-add__check"
          aria-hidden="true"
        />
        <span
          v-else
          class="yt-result-add__plus"
          aria-hidden="true"
        />
      </button>
    </div>

    <div
      v-if="restricted"
      class="yt-result-card__footer"
    >
      <p class="yt-result-card__footer-label font-maru-mono text-maru-black">
        <span>{{ YOTO_MYO_OVER_TRACK_DURATION_FOOTER }}</span>
        <MaruTooltip
          :text="YOTO_MYO_OVER_TRACK_DURATION_TOOLTIP"
          placement="top"
        >
          <button
            type="button"
            class="yt-result-card__info"
            aria-label="About Yoto track length limits"
            @click.stop
          >
            ?
          </button>
        </MaruTooltip>
      </p>
      <button
        type="button"
        class="yt-result-card__enable font-maru-mono text-maru-black"
        @click="onEnableLongTracks"
      >
        Enable long tracks
      </button>
    </div>
  </div>

  <!-- Tile layout -->
  <div
    v-else
    ref="element"
    class="yt-result-card w-full text-left border-maru rounded-maru overflow-hidden transition-[opacity,box-shadow,background-color]"
    :class="shellClass"
    :title="restricted ? YOTO_MYO_OVER_TRACK_DURATION_MESSAGE : undefined"
    :aria-disabled="restricted || undefined"
  >
    <div class="yt-result-card__main">
      <div class="relative">
        <div
          class="relative w-full overflow-hidden text-left"
          @click="emit('select', video.id)"
        >
          <img
            :src="video.thumbnailUrl"
            alt=""
            class="w-full aspect-video object-cover"
            loading="lazy"
          >
          <span
            v-if="durationLabel"
            class="yt-result-duration font-maru-mono tabular-nums"
          >{{ durationLabel }}</span>
        </div>
        <button
          v-if="!restricted"
          ref="handle"
          type="button"
          class="playlist-handle absolute top-2 left-2 z-10 bg-maru-yellow"
          aria-label="Drag to playlist"
        >
          <span /><span /><span />
        </button>
        <button
          v-if="playlistAvailable && !restricted"
          type="button"
          class="yt-result-add absolute top-2 right-2 z-10"
          :class="addButtonClass"
          :aria-disabled="addBlocked || undefined"
          :aria-label="addAriaLabel"
          :title="addTitle"
          @click="onAddToPlaylist"
        >
          <span
            v-if="added"
            class="yt-result-add__check"
            aria-hidden="true"
          />
          <span
            v-else
            class="yt-result-add__plus"
            aria-hidden="true"
          />
        </button>
      </div>
      <span
        v-if="showLongTrackChip"
        class="yt-result-long-chip yt-result-long-chip--tile font-maru-mono"
      >{{ YOTO_MYO_LONG_TRACK_CHIP }}</span>
      <div class="yt-result-card__body px-3 pt-3 pb-3">
        <button
          type="button"
          class="w-full text-left"
          :aria-label="`Select “${video.title}” by ${video.channelTitle}`"
          @click="emit('select', video.id)"
        >
          <p class="yt-result-card__title font-maru-medium text-[1.6rem] sm:text-[2rem] leading-[0.8] line-clamp-2 text-pretty">{{ video.title }}</p>
          <p class="yt-result-card__meta font-maru-mono font-maru-regular text-[1.4rem] sm:text-[1.75rem] leading-[0.8] text-maru-black/75 mt-0">{{ video.channelTitle }}</p>
        </button>
        <div class="pt-2">
          <YoutubePickerAudioControls
            :video-id="video.id"
            :title="video.title"
          />
        </div>
      </div>
    </div>

    <div
      v-if="restricted"
      class="yt-result-card__footer"
    >
      <p class="yt-result-card__footer-label font-maru-mono text-maru-black">
        <span>{{ YOTO_MYO_OVER_TRACK_DURATION_FOOTER }}</span>
        <MaruTooltip
          :text="YOTO_MYO_OVER_TRACK_DURATION_TOOLTIP"
          placement="top"
        >
          <button
            type="button"
            class="yt-result-card__info"
            aria-label="About Yoto track length limits"
            @click.stop
          >
            ?
          </button>
        </MaruTooltip>
      </p>
      <button
        type="button"
        class="yt-result-card__enable font-maru-mono text-maru-black"
        @click="onEnableLongTracks"
      >
        Enable long tracks
      </button>
    </div>
  </div>
</template>

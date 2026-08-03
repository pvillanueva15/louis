<script setup lang="ts">
import { useSortable } from '@dnd-kit/vue/sortable'
import type { PlaylistTrack } from '~/components/playlist/types'
import type { EffectiveTrackIcon } from '#shared/myo-editor/trackIconAssignment'
import { playlistDragId, type PlaylistDragData } from './dnd'

const props = defineProps<{
  track: PlaylistTrack
  index: number
  locked?: boolean
  reorderLocked?: boolean
  titleEnabled?: boolean
  iconEnabled?: boolean
  effectiveIcon?: EffectiveTrackIcon
}>()

const emit = defineEmits<{
  remove: [track: PlaylistTrack]
  chooseIcon: [track: PlaylistTrack]
  rename: [track: PlaylistTrack, title: string]
}>()

const editingTitle = ref(false)
const titleDraft = ref(props.track.title)

watch(() => props.track.title, (title) => {
  if (!editingTitle.value) titleDraft.value = title
})

function startTitleEdit() {
  if (props.locked || !props.titleEnabled) return
  titleDraft.value = props.track.title
  editingTitle.value = true
}

function saveTitleEdit() {
  if (!editingTitle.value) return
  emit('rename', props.track, titleDraft.value)
  editingTitle.value = false
}

function cancelTitleEdit() {
  titleDraft.value = props.track.title
  editingTitle.value = false
}

const iconLabel = computed(() => {
  if (!props.effectiveIcon?.reference) return 'No track icon. Choose an icon.'
  return props.effectiveIcon.source === 'chapter'
    ? 'Using chapter icon. Choose a track icon.'
    : 'Using a track icon. Change track icon.'
})

const { playEvent } = useUiSound()

function onRemoveHover() {
  if (props.locked) return
  playEvent('chipHover')
}

const element = ref<HTMLElement | null>(null)
const handle = ref<HTMLElement | null>(null)

const { isDragging, isDropTarget } = useSortable({
  id: () => playlistDragId(props.track.id),
  index: () => props.index,
  group: 'playlist',
  type: 'playlist',
  accept: ['playlist', 'result'],
  element,
  handle,
  disabled: () => Boolean(props.locked || props.reorderLocked),
  data: (): PlaylistDragData => ({
    type: 'playlist',
    track: props.track,
  }),
})
</script>

<template>
  <li
    ref="element"
    :data-playlist-video-id="track.id"
    class="playlist-item flex items-center gap-2 border-maru rounded-maru bg-maru-white p-2 pr-2.5 transition-[background-color,opacity,scale]"
    :class="{
      'opacity-50': isDragging,
      'bg-maru-yellow-light ring-2 ring-maru-blue': isDropTarget && !isDragging,
    }"
  >
    <button
      ref="handle"
      type="button"
      class="playlist-handle shrink-0 bg-maru-gray-light"
      :disabled="locked || reorderLocked"
      aria-label="Drag to reorder"
      :title="reorderLocked ? 'Reset raw card changes before reordering tracks.' : undefined"
    >
      <span /><span /><span />
    </button>

    <img
      v-if="track.thumbnailUrl"
      :src="track.thumbnailUrl"
      :alt="track.title"
      class="w-16 sm:w-20 shrink-0 aspect-video object-cover rounded-[calc(var(--radius-maru)-2px)]"
      loading="lazy"
    >

    <div class="min-w-0 flex-1 leading-tight">
      <form
        v-if="editingTitle"
        class="flex items-center gap-1"
        @submit.prevent="saveTitleEdit"
      >
        <input
          v-model="titleDraft"
          maxlength="100"
          class="min-w-0 flex-1 rounded-maru border-2 border-maru-blue px-2 py-1 font-maru-bold text-xl leading-none"
          :aria-label="`Edit ${track.title} title`"
          autofocus
          @keydown.esc.prevent="cancelTitleEdit"
        >
        <button type="submit" class="playlist-track-title-action" aria-label="Save track title">Save</button>
        <button type="button" class="playlist-track-title-action" aria-label="Cancel track title edit" @click="cancelTitleEdit">Cancel</button>
      </form>
      <div v-else class="flex min-w-0 items-start gap-1">
        <p class="min-w-0 flex-1 font-maru-bold text-xl sm:text-2xl line-clamp-2 text-pretty leading-[0.85]">{{ track.title }}</p>
        <button
          v-if="titleEnabled"
          type="button"
          class="playlist-track-title-action shrink-0"
          :disabled="locked"
          :aria-label="`Edit ${track.title} title`"
          @click="startTitleEdit"
        >
          Edit
        </button>
      </div>
      <p class="font-maru-mono font-maru-regular text-[1.25rem] text-maru-black/75 leading-none">{{ track.subtitle }}</p>
    </div>

    <button
      v-if="iconEnabled"
      type="button"
      class="playlist-track-icon"
      :disabled="locked"
      :aria-label="`${track.title}: ${iconLabel}`"
      :title="iconLabel"
      @click="emit('chooseIcon', track)"
    >
      <img
        v-if="effectiveIcon?.previewUrl"
        :src="effectiveIcon.previewUrl"
        alt=""
      >
      <span v-else aria-hidden="true">{{ effectiveIcon?.reference ? '✦' : '+' }}</span>
      <small>{{ effectiveIcon?.source === 'chapter' ? 'Chapter' : 'Icon' }}</small>
    </button>

    <button
      type="button"
      class="playlist-remove"
      :disabled="locked"
      :aria-label="`Remove ${track.title}`"
      @mouseenter="onRemoveHover"
      @click="emit('remove', track)"
    >
      <MaruEmoji name="Fire" size="md" />
    </button>
  </li>
</template>

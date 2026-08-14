import { MYO_EDITOR_KEY } from '~/components/myo-editor/keys'
import { pickerVideoToPlaylistTrack } from '~/components/playlist/types'
import { isOverMyoTrackDuration } from '#shared/myo-editor/youtubeDuration'
import type { YoutubeVideoSummary } from './types'

/** Click/keyboard add path into the playlist editor; no-op when the picker runs standalone. */
export function useAddToPlaylist() {
  const editor = inject(MYO_EDITOR_KEY, null)
  const { allowLongTracks } = useUserPreferences()
  const { playEvent } = useUiSound()

  const available = computed(() => editor !== null)

  const canAdd = computed(
    () => Boolean(editor?.isEditing.value) && !editor?.isPlaylistLocked.value,
  )

  function isAdded(videoId: string): boolean {
    return Boolean(editor?.playlist.value.some(
      track => (track.youtubeId ?? track.id) === videoId,
    ))
  }

  function isRestricted(video: YoutubeVideoSummary): boolean {
    return typeof video.durationSeconds === 'number'
      && isOverMyoTrackDuration(video.durationSeconds)
      && !allowLongTracks.value
  }

  function addToPlaylist(video: YoutubeVideoSummary): boolean {
    if (!editor || !canAdd.value || isRestricted(video) || isAdded(video.id)) {
      playEvent('disabled')
      return false
    }

    const result = editor.appendTracks([pickerVideoToPlaylistTrack(video)])
    if (!result.ok) {
      playEvent('disabled')
      return false
    }

    playEvent('drop')
    return true
  }

  return {
    available,
    canAdd,
    isAdded,
    isRestricted,
    addToPlaylist,
  }
}

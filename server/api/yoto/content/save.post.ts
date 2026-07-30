import { getStandalonePlaylistValidationError } from '#shared/myo-editor/standalonePlaylist'
import type { PlaylistTrack } from '#shared/myo-editor/types'
import { getScopeCookie, hasContentManageScope } from '../../../utils/yoto-auth'
import { startSaveJob } from '../../../utils/save-jobs'
import { getYotoAccessToken } from '../../../utils/yoto'

interface CreateSaveRequestBody {
  playlist: PlaylistTrack[]
  cardTitle: string
  /** When true, skip our MYO capacity gates and let Yoto decide. */
  acknowledgeCapacityRisk?: boolean
}

export default defineEventHandler(async (event) => {
  const scope = getScopeCookie(event)
  if (!hasContentManageScope(scope)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Reconnect to Yoto to grant playlist edit permission (user:content:manage).',
    })
  }

  await getYotoAccessToken(event)

  const body = await readBody<CreateSaveRequestBody>(event)
  const playlist = Array.isArray(body?.playlist) ? body.playlist : []
  const cardTitle = body?.cardTitle?.trim() ?? ''
  const validationError = getStandalonePlaylistValidationError(cardTitle, playlist)
  if (validationError) {
    throw createError({ statusCode: 400, statusMessage: validationError })
  }

  const job = startSaveJob(
    event,
    { operation: 'create' },
    playlist,
    cardTitle,
    [],
    { acknowledgeCapacityRisk: body?.acknowledgeCapacityRisk === true },
  )

  return { jobId: job.id, status: job.status }
})

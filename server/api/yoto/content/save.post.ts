import { getStandalonePlaylistValidationError } from '#shared/myo-editor/standalonePlaylist'
import { getScopeCookie, hasContentManageScope } from '../../../utils/yoto-auth'
import { parseCreateSaveRequest } from '../../../utils/save-as-request'
import { startSaveJob } from '../../../utils/save-jobs'
import { getYotoAccessToken } from '../../../utils/yoto'

export default defineEventHandler(async (event) => {
  const scope = getScopeCookie(event)
  if (!hasContentManageScope(scope)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Reconnect to Yoto to grant playlist edit permission (user:content:manage).',
    })
  }

  await getYotoAccessToken(event)

  let request
  try {
    request = parseCreateSaveRequest(await readBody<unknown>(event))
  }
  catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'The create request is malformed.'
    throw createError({ statusCode: 400, statusMessage: message })
  }
  const {
    playlist,
    cardTitle,
    saveAsSourceReference,
    saveAsMutations,
    acknowledgeCapacityRisk,
  } = request
  const validationError = getStandalonePlaylistValidationError(cardTitle, playlist, {
    isSaveAsDraft: Boolean(saveAsSourceReference),
  })
  if (validationError) {
    throw createError({ statusCode: 400, statusMessage: validationError })
  }

  const job = startSaveJob(
    event,
    { operation: 'create' },
    playlist,
    cardTitle,
    [],
    {
      acknowledgeCapacityRisk,
      saveAsSourceReference,
      saveAsMutations,
    },
  )

  return { jobId: job.id, status: job.status }
})

import {
  cardMutationStatusCode,
  CardMutationError,
  parseMutateCardRequest,
} from '#shared/yoto/cardMutation'
import { getScopeCookie, hasContentManageScope } from '../../../../utils/yoto-auth'
import { mutateYotoCard } from '../../../../utils/yoto-card-mutation'
import { getYotoAccessToken } from '../../../../utils/yoto'

export default defineEventHandler(async (event) => {
  const cardId = getRouterParam(event, 'cardId')
  if (!cardId) {
    throw createError({ statusCode: 400, statusMessage: 'cardId is required' })
  }

  const scope = getScopeCookie(event)
  if (!hasContentManageScope(scope)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Reconnect to Yoto to grant playlist edit permission (user:content:manage).',
    })
  }

  try {
    const request = parseMutateCardRequest(await readBody<unknown>(event))
    const accessToken = await getYotoAccessToken(event)
    return await mutateYotoCard(cardId, request, accessToken)
  }
  catch (error) {
    if (!(error instanceof CardMutationError)) throw error
    throw createError({
      statusCode: cardMutationStatusCode(error),
      statusMessage: error.message,
    })
  }
})

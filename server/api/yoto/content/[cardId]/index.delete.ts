import { parseDeleteCardRequest } from '#shared/yoto/cardDeletion'
import { getScopeCookie, hasContentManageScope } from '../../../../utils/yoto-auth'
import {
  CardDeletionError,
  cardDeletionStatusCode,
  deleteYotoCard,
  validateDeletionCardId,
} from '../../../../utils/yoto-card-deletion'
import { getYotoAccessToken } from '../../../../utils/yoto'

export default defineEventHandler(async (event) => {
  let cardId: string
  let request
  try {
    cardId = validateDeletionCardId(getRouterParam(event, 'cardId'))
    request = parseDeleteCardRequest(await readBody<unknown>(event))
  }
  catch (error) {
    const message = error instanceof Error ? error.message : 'The deletion request is malformed.'
    throw createError({ statusCode: 400, statusMessage: message })
  }

  const scope = getScopeCookie(event)
  if (!hasContentManageScope(scope)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Reconnect to Yoto to grant playlist edit permission (user:content:manage).',
    })
  }

  try {
    const accessToken = await getYotoAccessToken(event)
    return await deleteYotoCard(cardId, request, accessToken)
  }
  catch (error) {
    if (!(error instanceof CardDeletionError)) throw error
    throw createError({
      statusCode: cardDeletionStatusCode(error),
      statusMessage: error.message,
      data: { outcomeUncertain: error.outcomeUncertain },
    })
  }
})

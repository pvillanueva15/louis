import {
  getScopeCookie,
  getStoredYotoAccessToken,
  hasContentManageScope,
} from '../../../../../utils/yoto-auth.ts'
import {
  communityIconService,
  CommunityIconError,
  CommunityIconUploadOutcomeUncertainError,
} from '../../../../../utils/community-icons.ts'
import { hasRecentYotoTokenValidation, YotoIconContractError } from '../../../../../utils/yoto-icons.ts'
import { fetchYotoApi, getYotoAccessToken } from '../../../../../utils/yoto.ts'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store')

  if (!hasContentManageScope(getScopeCookie(event))) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Reconnect to Yoto to grant icon upload permission (user:content:manage).',
    })
  }

  const storedAccessToken = getStoredYotoAccessToken(event)
  if (!storedAccessToken || !hasRecentYotoTokenValidation(storedAccessToken)) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Close and reopen My Icons to refresh your Yoto session, then try again.',
    })
  }

  const accessToken = await getYotoAccessToken(event)
  const body = await readBody<{ query?: unknown, page?: unknown }>(event)
  const yotoRequest = (path: string, token: string, options?: Parameters<typeof fetchYotoApi>[2]) => (
    fetchYotoApi<unknown>(path, token, options)
  )
  try {
    return await communityIconService.importIcon(
      body?.query,
      getRouterParam(event, 'id'),
      body?.page,
      accessToken,
      yotoRequest,
    )
  }
  catch (error) {
    if (error instanceof CommunityIconUploadOutcomeUncertainError) {
      throw createError({
        statusCode: error.statusCode,
        statusMessage: error.message,
        data: { code: error.code },
      })
    }
    if (error instanceof CommunityIconError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message })
    }
    if (error instanceof YotoIconContractError) {
      throw createError({ statusCode: 502, statusMessage: error.message })
    }
    throw error
  }
})

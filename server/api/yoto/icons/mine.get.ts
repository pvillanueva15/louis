import { fetchPersonalIcons, YotoIconContractError } from '../../../utils/yoto-icons'
import { fetchYotoApi, getYotoAccessToken } from '../../../utils/yoto'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const accessToken = await getYotoAccessToken(event)

  try {
    return await fetchPersonalIcons(
      accessToken,
      (path, token, options) => fetchYotoApi<unknown>(path, token, options),
    )
  }
  catch (error) {
    if (!(error instanceof YotoIconContractError)) throw error
    throw createError({ statusCode: 502, statusMessage: error.message })
  }
})

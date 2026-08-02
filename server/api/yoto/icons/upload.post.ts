import { getScopeCookie, hasContentManageScope } from '../../../utils/yoto-auth'
import {
  normalizeIconFilename,
  readBoundedStaticIconBody,
  StaticIconInputError,
  uploadPersonalIcon,
  validateStaticIconContentType,
  YotoIconContractError,
} from '../../../utils/yoto-icons'
import { fetchYotoApi, getYotoAccessToken } from '../../../utils/yoto'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store')

  const scope = getScopeCookie(event)
  if (!hasContentManageScope(scope)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Reconnect to Yoto to grant icon upload permission (user:content:manage).',
    })
  }

  const contentLength = Number(getHeader(event, 'content-length'))
  if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
    throw createError({ statusCode: 413, statusMessage: 'PNG body must be no larger than 64 KiB.' })
  }

  try {
    validateStaticIconContentType(getHeader(event, 'content-type'))
    const query = getQuery(event)
    const filename = normalizeIconFilename(query.filename)
    const bytes = await readBoundedStaticIconBody(event.node.req)
    const accessToken = await getYotoAccessToken(event)
    return await uploadPersonalIcon(
      bytes,
      filename,
      accessToken,
      (path, token, options) => fetchYotoApi<unknown>(path, token, options),
    )
  }
  catch (error) {
    if (error instanceof StaticIconInputError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message })
    }
    if (error instanceof YotoIconContractError) {
      throw createError({ statusCode: 502, statusMessage: error.message })
    }
    throw error
  }
})

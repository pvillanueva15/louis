import {
  personalIconSourceService,
  PersonalIconSourceError,
} from '../../../utils/personal-icon-source.ts'
import { fetchPersonalIconSourceCandidates } from '../../../utils/yoto-icons.ts'
import { fetchYotoApi, getYotoAccessToken } from '../../../utils/yoto.ts'

const recoveryMessage = {
  unavailable: 'This personal icon is no longer available. Refresh My Icons and try again.',
  unsupported: 'This personal icon can’t be edited in Icon Studio.',
  temporary: 'Louis couldn’t load this icon. Try again.',
} as const

interface RequestAbortEmitter {
  readonly aborted?: boolean
  readonly destroyed?: boolean
  once(event: 'aborted' | 'close', listener: () => void): unknown
  off(event: 'aborted' | 'close', listener: () => void): unknown
}

function createRequestAbort(event: {
  node?: { req?: RequestAbortEmitter, res?: RequestAbortEmitter }
}): { signal: AbortSignal, dispose: () => void } {
  const controller = new AbortController()
  const abort = () => controller.abort()
  event.node?.req?.once('aborted', abort)
  event.node?.res?.once('close', abort)
  if (event.node?.req?.aborted || event.node?.res?.destroyed) abort()
  return {
    signal: controller.signal,
    dispose: () => {
      event.node?.req?.off('aborted', abort)
      event.node?.res?.off('close', abort)
    },
  }
}

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const requestAbort = createRequestAbort(event)

  try {
    const accessToken = await getYotoAccessToken(event)
    try {
      const result = await personalIconSourceService.load(
        getQuery(event),
        () => fetchPersonalIconSourceCandidates(
          accessToken,
          (path, token, options) => fetchYotoApi<unknown>(path, token, {
            ...options,
            signal: requestAbort.signal,
          }),
        ),
        requestAbort.signal,
      )
      setHeader(event, 'Content-Type', 'image/png')
      setHeader(event, 'Content-Length', result.bytes.byteLength)
      setHeader(event, 'Content-Disposition', `inline; filename="${result.filename}"`)
      setHeader(event, 'X-Content-Type-Options', 'nosniff')
      return Buffer.from(result.bytes)
    }
    catch (error) {
      if (error instanceof PersonalIconSourceError) {
        throw createError({
          statusCode: error.statusCode,
          statusMessage: recoveryMessage[error.code],
        })
      }
      const statusCode = (error as { statusCode?: number, status?: number })?.statusCode
        ?? (error as { status?: number })?.status
      if (statusCode === 401 || statusCode === 403) throw error
      throw createError({
        statusCode: 502,
        statusMessage: recoveryMessage.temporary,
      })
    }
  }
  finally {
    requestAbort.dispose()
  }
})

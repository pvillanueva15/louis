import {
  communityIconService,
  CommunityIconError,
} from '../../../../../utils/community-icons.ts'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, max-age=300')
  setHeader(event, 'Content-Type', 'image/png')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  try {
    return Buffer.from(await communityIconService.preview(getRouterParam(event, 'id')))
  }
  catch (error) {
    if (error instanceof CommunityIconError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message })
    }
    throw error
  }
})

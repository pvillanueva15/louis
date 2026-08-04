import {
  communityIconService,
  CommunityIconError,
} from '../../../../utils/community-icons.ts'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  try {
    const query = getQuery(event)
    return await communityIconService.search(query.q, { page: query.page })
  }
  catch (error) {
    if (error instanceof CommunityIconError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message })
    }
    throw error
  }
})

import type { YotoTrackPayload } from '#shared/myo-editor/types'
import type { YotoCardMetadata } from '#shared/myo-editor/types'
import { fetchYotoApi } from './yoto'
import type { YotoContentResponse } from './yoto-content-contract'

export interface YotoContentChapter {
  key: string
  title: string
  overlayLabel?: string
  tracks: YotoTrackPayload[]
  display?: { icon16x16: string | null }
  duration?: number
  fileSize?: number
}

export interface CreateOrUpdateContentBody {
  cardId?: string
  title: string
  content: {
    version?: string
    chapters: YotoContentChapter[]
  }
  metadata: YotoCardMetadata & {
    title: string
    note?: string
    media?: {
      duration?: number
      fileSize?: number
      readableFileSize?: number
    }
  }
}

export async function createOrUpdateContent(
  accessToken: string,
  body: CreateOrUpdateContentBody,
): Promise<YotoContentResponse> {
  return fetchYotoApi<YotoContentResponse>('/content', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

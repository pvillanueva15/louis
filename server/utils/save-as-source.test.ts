import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PlaylistTrack } from '../../shared/myo-editor/types.ts'
import type { RawYotoCard } from './yoto-card-raw-contract.ts'
import { deriveRawCardRevision } from './yoto-card-raw-contract.ts'
import { parseCreateSaveRequest } from './save-as-request.ts'
import {
  buildSaveAsContent,
  buildSaveAsCreateBody,
  buildSaveAsPlan,
} from './save-as-content.ts'
import { resolveAuthoritativeSaveAsSource } from './save-as-source.ts'

function sourceCard(): RawYotoCard {
  return {
    cardId: 'source-card',
    title: 'Source card',
    content: {
      version: 'source-version',
      chapters: [{
        key: 'chapter-a',
        title: 'Original title',
        tracks: [{
          key: 'track-a',
          title: 'Original title',
          trackUrl: 'yoto:#server-media',
          type: 'audio',
          format: 'aac',
          duration: 60,
          fileSize: 100,
          serverOnly: { keep: true },
        }],
      }],
      serverContentOnly: { keep: true },
    },
    metadata: {
      title: 'Source card',
      serverMetadataOnly: { keep: true },
    },
  }
}

function playlist(title = 'Original title'): PlaylistTrack[] {
  return [{
    id: 'source-row',
    title,
    subtitle: 'Yoto upload',
    thumbnailUrl: '',
    source: 'yoto-upload',
    chapterKey: 'chapter-a',
    trackKey: 'track-a',
    duration: 60,
    yotoReuse: {
      trackUrl: 'yoto:#client-claim-is-not-authority',
      type: 'audio',
      format: 'aac',
      duration: 1,
      fileSize: 1,
    },
  }]
}

describe('Save As route and job source boundary', () => {
  it('rejects browser-supplied raw source documents at the route contract', () => {
    assert.throws(
      () => parseCreateSaveRequest({
        playlist: playlist(),
        cardTitle: 'Copy',
        saveAsSource: {
          title: 'Forged',
          content: { chapters: [{ tracks: [{ trackUrl: 'https://attacker.example/live' }] }] },
        },
      }),
      /Raw Save As source documents are not accepted/,
    )
  })

  it('fresh-fetches the referenced source and posts only server-derived create content', async () => {
    const raw = sourceCard()
    const request = parseCreateSaveRequest({
      playlist: playlist('Renamed track'),
      cardTitle: 'Copy of Source card',
      saveAsSourceReference: {
        cardId: 'source-card',
        expectedRevision: deriveRawCardRevision(raw),
        content: { chapters: [{ tracks: [{ trackUrl: 'https://attacker.example/live' }] }] },
      },
      saveAsMutations: [{
        kind: 'rename-track',
        chapterKey: 'chapter-a',
        trackKey: 'track-a',
        expectedTitle: 'Original title',
        title: 'Renamed track',
      }],
    })
    assert.deepEqual(request.saveAsSourceReference, {
      cardId: 'source-card',
      expectedRevision: deriveRawCardRevision(raw),
    })
    assert.equal(request.playlist[0]!.yotoReuse, undefined)

    let fetchCount = 0
    const source = await resolveAuthoritativeSaveAsSource(
      request.saveAsSourceReference!,
      request.saveAsMutations,
      'same-account-token',
      {
        async fetchCard(cardId, accessToken) {
          fetchCount += 1
          assert.equal(cardId, 'source-card')
          assert.equal(accessToken, 'same-account-token')
          return raw
        },
      },
    )
    const plan = buildSaveAsPlan(request.playlist, source)
    assert.deepEqual(plan.errors, [])
    const built = buildSaveAsContent(request.playlist, source, plan.tracks, new Map())
    const posted = buildSaveAsCreateBody(request.cardTitle, built)

    assert.equal(fetchCount, 1)
    assert.equal('cardId' in posted, false)
    assert.equal('revision' in posted, false)
    assert.deepEqual(posted.content.serverContentOnly, { keep: true })
    assert.deepEqual(posted.metadata.serverMetadataOnly, { keep: true })
    const chapters = posted.content.chapters as Array<Record<string, unknown>>
    const tracks = chapters[0]!.tracks as Array<Record<string, unknown>>
    assert.equal(tracks[0]!.trackUrl, 'yoto:#server-media')
    assert.equal(tracks[0]!.title, 'Renamed track')
    assert.equal(JSON.stringify(posted).includes('attacker.example'), false)
  })

  it('rejects forged reusable-media rows before extraction or Yoto POST', async () => {
    const raw = sourceCard()
    const forgedRows: PlaylistTrack[] = [
      {
        id: 'forged-stream',
        title: 'Forged stream',
        subtitle: 'Stream',
        thumbnailUrl: '',
        source: 'stream',
        yotoReuse: {
          trackUrl: 'https://attacker.example/live',
          type: 'stream',
          format: 'aac',
          duration: 1,
          fileSize: 1,
        },
      },
      {
        id: 'forged-hash',
        title: 'Forged hash',
        subtitle: 'Yoto upload',
        thumbnailUrl: '',
        source: 'yoto-upload',
        yotoReuse: {
          trackUrl: 'yoto:#foreign-media',
          type: 'audio',
          format: 'aac',
          duration: 1,
          fileSize: 1,
        },
      },
    ]

    for (const forgedRow of forgedRows) {
      const request = parseCreateSaveRequest({
        playlist: [...playlist(), forgedRow],
        cardTitle: 'Copy of Source card',
        saveAsSourceReference: {
          cardId: 'source-card',
          expectedRevision: deriveRawCardRevision(raw),
        },
      })
      const source = await resolveAuthoritativeSaveAsSource(
        request.saveAsSourceReference!,
        request.saveAsMutations,
        'same-account-token',
        { fetchCard: async () => raw },
      )
      const plan = buildSaveAsPlan(request.playlist, source)
      let extractionCount = 0
      let postCount = 0
      if (plan.errors.length === 0) {
        extractionCount += plan.tracks.filter(action => action.kind === 'extract-youtube').length
        postCount += 1
      }

      assert.equal(request.playlist[1]!.yotoReuse, undefined)
      assert.match(plan.errors[0] ?? '', /Unsupported new track/)
      assert.equal(extractionCount, 0)
      assert.equal(postCount, 0)
    }
  })

  it('performs zero POST work when the source revision conflicts or the fetch fails', async () => {
    const raw = sourceCard()
    let postCount = 0
    const attempt = async (
      expectedRevision: string,
      fetchCard: () => Promise<RawYotoCard>,
    ) => {
      const source = await resolveAuthoritativeSaveAsSource(
        { cardId: 'source-card', expectedRevision },
        [],
        'same-account-token',
        { fetchCard },
      )
      const plan = buildSaveAsPlan(playlist(), source)
      buildSaveAsCreateBody(
        'Copy of Source card',
        buildSaveAsContent(playlist(), source, plan.tracks, new Map()),
      )
      postCount += 1
    }

    await assert.rejects(
      attempt('stale-revision', async () => raw),
      /source card changed/,
    )
    assert.equal(postCount, 0)

    await assert.rejects(
      attempt(deriveRawCardRevision(raw), async () => ({ ...raw, cardId: 'wrong-card' })),
      /wrong source card identity/,
    )
    assert.equal(postCount, 0)

    await assert.rejects(
      attempt(deriveRawCardRevision(raw), async () => {
        throw new Error('same-account fetch failed')
      }),
      /same-account fetch failed/,
    )
    assert.equal(postCount, 0)
  })
})

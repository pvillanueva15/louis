import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  calculateStaticIconCrop,
  createStaticIconRenderPlan,
  inspectStaticIconSource,
  safeStaticIconFilename,
  validateStaticIconSource,
  validateStaticIconSourceHeader,
} from './staticIcon.ts'

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([73, 72, 68, 82], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function jpegHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(21)
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08])
  const view = new DataView(bytes.buffer)
  view.setUint16(7, height)
  view.setUint16(9, width)
  return bytes
}

function webpHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set(new TextEncoder().encode('RIFF'), 0)
  bytes.set(new TextEncoder().encode('WEBP'), 8)
  bytes.set(new TextEncoder().encode('VP8X'), 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 22, true)
  view.setUint32(16, 10, true)
  const storedWidth = width - 1
  const storedHeight = height - 1
  bytes.set([storedWidth & 0xff, (storedWidth >>> 8) & 0xff, (storedWidth >>> 16) & 0xff], 24)
  bytes.set([storedHeight & 0xff, (storedHeight >>> 8) & 0xff, (storedHeight >>> 16) & 0xff], 27)
  return bytes
}

describe('static icon geometry', () => {
  it('centers a square crop and pans across the available source', () => {
    assert.deepEqual(calculateStaticIconCrop(800, 400, 1, 0, 0), {
      x: 200,
      y: 0,
      size: 400,
    })
    assert.deepEqual(calculateStaticIconCrop(800, 400, 1, 1, 0), {
      x: 400,
      y: 0,
      size: 400,
    })
  })

  it('clamps zoom and pan and produces a 16px render plan', () => {
    assert.deepEqual(
      createStaticIconRenderPlan(400, 400, 2, -2, 2, 'solid', '#FFCC00'),
      {
        crop: { x: 0, y: 200, size: 200 },
        outputSize: 16,
        background: '#ffcc00',
      },
    )
    assert.equal(
      createStaticIconRenderPlan(400, 400, 1, 0, 0, 'transparent', '#ffffff').background,
      null,
    )
  })

  it('validates browser-local source limits', () => {
    assert.doesNotThrow(() => validateStaticIconSource('image/webp', 1024, 4096, 4096))
    assert.throws(() => validateStaticIconSource('image/gif', 1024, 16, 16), /PNG, JPEG, or WebP/)
    assert.throws(() => validateStaticIconSource('image/png', 10 * 1024 * 1024 + 1, 16, 16), /10 MiB/)
    assert.throws(() => validateStaticIconSource('image/png', 1024, 4097, 16), /4096×4096/)
  })

  it('rejects disguised SVG and GIF source files', () => {
    assert.doesNotThrow(() => validateStaticIconSourceHeader(
      'image/png',
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ))
    assert.doesNotThrow(() => validateStaticIconSourceHeader(
      'image/jpeg',
      Uint8Array.from([0xff, 0xd8, 0xff]),
    ))
    assert.doesNotThrow(() => validateStaticIconSourceHeader(
      'image/webp',
      Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]),
    ))
    assert.throws(
      () => validateStaticIconSourceHeader('image/png', new TextEncoder().encode('<svg>')),
      /file contents do not match/,
    )
    assert.throws(
      () => validateStaticIconSourceHeader('image/png', new TextEncoder().encode('GIF89a')),
      /file contents do not match/,
    )
  })

  it('inspects PNG, JPEG, and WebP dimensions before decode', () => {
    assert.deepEqual(inspectStaticIconSource('image/png', pngHeader(16, 32)), { width: 16, height: 32 })
    assert.deepEqual(inspectStaticIconSource('image/jpeg', jpegHeader(640, 480)), { width: 640, height: 480 })
    assert.deepEqual(inspectStaticIconSource('image/webp', webpHeader(320, 240)), { width: 320, height: 240 })
  })

  it('rejects oversized and malformed image headers before decode', () => {
    assert.throws(() => inspectStaticIconSource('image/png', pngHeader(4097, 16)), /4096×4096/)
    assert.throws(() => inspectStaticIconSource('image/png', pngHeader(16, 16).slice(0, 20)), /PNG header/)

    const malformedJpeg = jpegHeader(16, 16)
    new DataView(malformedJpeg.buffer).setUint16(4, 0xffff)
    assert.throws(() => inspectStaticIconSource('image/jpeg', malformedJpeg), /malformed segment/)

    const malformedWebp = webpHeader(16, 16)
    new DataView(malformedWebp.buffer).setUint32(4, 100, true)
    assert.throws(() => inspectStaticIconSource('image/webp', malformedWebp), /RIFF length/)
  })

  it('turns local names into bounded safe stems', () => {
    assert.equal(safeStaticIconFilename('../../A happy face.PNG'), 'A-happy-face')
    assert.equal(safeStaticIconFilename('💫.webp'), 'icon')
    assert.equal(safeStaticIconFilename('a'.repeat(100)), 'a'.repeat(80))
  })
})

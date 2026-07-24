import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

const DRAG_THRESHOLD_PX = 4
/** Optical mouse “line” notches → px. Keep pixel-mode (trackpads) 1:1. */
const LINE_HEIGHT_PX = 40

function canScrollX(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth + 1
}

function stepSize(el: HTMLElement): number {
  return Math.max(80, Math.round(el.clientWidth * 0.28))
}

function deltaToPixels(delta: number, deltaMode: number, pageSize: number): number {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) return delta * LINE_HEIGHT_PX
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * pageSize
  return delta
}

/**
 * Horizontal fan scroll: continuous pixel panning (no snap / no chunk steps on wheel).
 */
export function useMyoCardFanScroll() {
  const fanRef = ref<HTMLElement | null>(null)
  const dragging = ref(false)
  let suppressCardClick = false
  let boundEl: HTMLElement | null = null
  let drag: {
    pointerId: number
    startX: number
    startScroll: number
    moved: boolean
  } | null = null

  function onWheel(event: WheelEvent) {
    const el = fanRef.value
    if (!el || !canScrollX(el)) return

    // Map every wheel pixel onto the fan immediately (vertical + horizontal → x).
    // No RAF batching, no snap — avoids delay, dead zones, and chunky steps.
    const page = el.clientWidth
    const dx = deltaToPixels(event.deltaX, event.deltaMode, page)
      + deltaToPixels(event.deltaY, event.deltaMode, page)

    if (dx === 0) return

    event.preventDefault()
    el.scrollLeft += dx
  }

  function bindWheel(el: HTMLElement | null) {
    if (boundEl) {
      boundEl.removeEventListener('wheel', onWheel)
      boundEl = null
    }
    if (el) {
      el.addEventListener('wheel', onWheel, { passive: false })
      boundEl = el
    }
  }

  watch(fanRef, (el) => {
    bindWheel(el)
  })

  onBeforeUnmount(() => {
    bindWheel(null)
  })

  function onKeydown(event: KeyboardEvent) {
    const el = fanRef.value
    if (!el || !canScrollX(el)) return
    if (event.target !== el) return

    const step = stepSize(el)
    // Instant steps (not CSS smooth) so keyboard matches continuous fan feel.
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      el.scrollLeft += step
    }
    else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      el.scrollLeft -= step
    }
    else if (event.key === 'Home') {
      event.preventDefault()
      el.scrollLeft = 0
    }
    else if (event.key === 'End') {
      event.preventDefault()
      el.scrollLeft = el.scrollWidth
    }
  }

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0) return
    const el = fanRef.value
    if (!el || !canScrollX(el)) return

    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScroll: el.scrollLeft,
      moved: false,
    }
  }

  function onPointerMove(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return
    const el = fanRef.value
    if (!el) return

    const dx = event.clientX - drag.startX
    if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return

    if (!drag.moved) {
      drag.moved = true
      dragging.value = true
      suppressCardClick = true
      el.setPointerCapture(event.pointerId)
    }

    el.scrollLeft = drag.startScroll - dx
  }

  function endDrag(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return
    const el = fanRef.value
    const moved = drag.moved
    drag = null
    dragging.value = false
    if (el?.hasPointerCapture(event.pointerId)) {
      el.releasePointerCapture(event.pointerId)
    }
    if (moved) {
      suppressCardClick = true
      setTimeout(() => {
        suppressCardClick = false
      }, 0)
    }
  }

  function shouldSuppressCardClick(): boolean {
    return suppressCardClick
  }

  return {
    fanRef: fanRef as Ref<HTMLElement | null>,
    dragging,
    shouldSuppressCardClick,
    onKeydown,
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  }
}

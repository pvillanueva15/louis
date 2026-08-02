<script setup lang="ts">
import {
  createStaticIconRenderPlan,
  inspectStaticIconSource,
  safeStaticIconFilename,
  STATIC_ICON_MAX_BYTES,
  validateStaticIconSource,
} from '#shared/yoto/staticIcon'

const props = withDefaults(defineProps<{
  busy?: boolean
}>(), {
  busy: false,
})

const emit = defineEmits<{
  cancel: []
  upload: [blob: Blob, filename: string]
}>()

const fileInput = ref<HTMLInputElement | null>(null)
const cropCanvas = ref<HTMLCanvasElement | null>(null)
const actualCanvas = ref<HTMLCanvasElement | null>(null)
const pixelCanvas = ref<HTMLCanvasElement | null>(null)
const sourceImage = shallowRef<HTMLImageElement | null>(null)
const sourceName = ref('icon')
const filename = ref('icon')
const sourceWidth = ref(0)
const sourceHeight = ref(0)
const zoom = ref(1)
const panX = ref(0)
const panY = ref(0)
const backgroundMode = ref<'transparent' | 'solid'>('transparent')
const backgroundColor = ref('#ffffff')
const errorMessage = ref('')
const loading = ref(false)
const encoding = ref(false)

let objectUrl: string | null = null
let loadGeneration = 0
let pointerStart: { x: number, y: number, panX: number, panY: number } | null = null

const hasImage = computed(() => sourceImage.value !== null)
const safeFilename = computed(() => safeStaticIconFilename(filename.value))
const locked = computed(() => props.busy || encoding.value || loading.value)

function focusInitial() {
  fileInput.value?.focus()
}

defineExpose({ focusInitial })

function clearObjectUrl() {
  if (!objectUrl) return
  URL.revokeObjectURL(objectUrl)
  objectUrl = null
}

function resetEdits() {
  zoom.value = 1
  panX.value = 0
  panY.value = 0
  backgroundMode.value = 'transparent'
  backgroundColor.value = '#ffffff'
  errorMessage.value = ''
}

function drawToCanvas(canvas: HTMLCanvasElement, size: number, includeBackground: boolean) {
  const image = sourceImage.value
  if (!image) return

  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) return

  const plan = createStaticIconRenderPlan(
    sourceWidth.value,
    sourceHeight.value,
    zoom.value,
    panX.value,
    panY.value,
    backgroundMode.value,
    backgroundColor.value,
  )

  context.clearRect(0, 0, size, size)
  if (includeBackground && plan.background) {
    context.fillStyle = plan.background
    context.fillRect(0, 0, size, size)
  }
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(
    image,
    plan.crop.x,
    plan.crop.y,
    plan.crop.size,
    plan.crop.size,
    0,
    0,
    size,
    size,
  )
}

function renderPreviews() {
  if (!hasImage.value) return
  if (cropCanvas.value) drawToCanvas(cropCanvas.value, 256, true)
  if (actualCanvas.value) drawToCanvas(actualCanvas.value, 16, true)

  if (pixelCanvas.value && actualCanvas.value) {
    pixelCanvas.value.width = 16
    pixelCanvas.value.height = 16
    const context = pixelCanvas.value.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, 16, 16)
    context.imageSmoothingEnabled = false
    context.drawImage(actualCanvas.value, 0, 0)
  }
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  if (locked.value || loading.value) {
    input.value = ''
    return
  }
  const file = input.files?.[0]
  if (!file) return

  errorMessage.value = ''
  loading.value = true
  const generation = ++loadGeneration
  clearObjectUrl()
  let nextObjectUrl: string | null = null

  try {
    validateStaticIconSource(file.type, file.size, 1, 1)
    inspectStaticIconSource(file.type, new Uint8Array(await file.arrayBuffer()))
    nextObjectUrl = URL.createObjectURL(file)
    objectUrl = nextObjectUrl
    const image = new Image()
    image.src = nextObjectUrl
    await image.decode()

    if (generation !== loadGeneration) return
    validateStaticIconSource(file.type, file.size, image.naturalWidth, image.naturalHeight)
    sourceImage.value = image
    sourceWidth.value = image.naturalWidth
    sourceHeight.value = image.naturalHeight
    sourceName.value = file.name
    filename.value = safeStaticIconFilename(file.name)
    resetEdits()
    await nextTick()
    renderPreviews()
  }
  catch (error) {
    if (generation !== loadGeneration) return
    sourceImage.value = null
    errorMessage.value = error instanceof Error ? error.message : 'This image could not be opened.'
  }
  finally {
    if (generation === loadGeneration) loading.value = false
    if (nextObjectUrl) {
      URL.revokeObjectURL(nextObjectUrl)
      if (objectUrl === nextObjectUrl) objectUrl = null
    }
    input.value = ''
  }
}

function adjustPan(deltaX: number, deltaY: number) {
  panX.value = Math.max(-1, Math.min(1, panX.value + deltaX))
  panY.value = Math.max(-1, Math.min(1, panY.value + deltaY))
}

function onCropKeydown(event: KeyboardEvent) {
  const step = event.shiftKey ? 0.15 : 0.05
  if (event.key === 'ArrowLeft') adjustPan(-step, 0)
  else if (event.key === 'ArrowRight') adjustPan(step, 0)
  else if (event.key === 'ArrowUp') adjustPan(0, -step)
  else if (event.key === 'ArrowDown') adjustPan(0, step)
  else if (event.key === '+' || event.key === '=') zoom.value = Math.min(8, zoom.value + 0.1)
  else if (event.key === '-' || event.key === '_') zoom.value = Math.max(1, zoom.value - 0.1)
  else return
  event.preventDefault()
}

function onPointerDown(event: PointerEvent) {
  if (!cropCanvas.value) return
  cropCanvas.value.setPointerCapture(event.pointerId)
  pointerStart = {
    x: event.clientX,
    y: event.clientY,
    panX: panX.value,
    panY: panY.value,
  }
}

function onPointerMove(event: PointerEvent) {
  if (!pointerStart || !cropCanvas.value) return
  const bounds = cropCanvas.value.getBoundingClientRect()
  panX.value = Math.max(-1, Math.min(1, pointerStart.panX - (event.clientX - pointerStart.x) / bounds.width * 2))
  panY.value = Math.max(-1, Math.min(1, pointerStart.panY - (event.clientY - pointerStart.y) / bounds.height * 2))
}

function onPointerEnd() {
  pointerStart = null
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('The 16×16 PNG could not be created.'))
        return
      }
      resolve(blob)
    }, 'image/png')
  })
}

async function onUpload() {
  if (!actualCanvas.value || locked.value) return
  encoding.value = true
  errorMessage.value = ''

  try {
    renderPreviews()
    const blob = await canvasToPng(actualCanvas.value)
    if (blob.type !== 'image/png' || blob.size === 0) {
      throw new Error('The browser did not create a valid PNG.')
    }
    if (blob.size > STATIC_ICON_MAX_BYTES) {
      throw new Error('The final PNG is larger than 64 KiB.')
    }
    emit('upload', blob, safeFilename.value)
  }
  catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'The icon could not be prepared.'
  }
  finally {
    encoding.value = false
  }
}

watch([zoom, panX, panY, backgroundMode, backgroundColor], renderPreviews)

onUnmounted(() => {
  loadGeneration += 1
  clearObjectUrl()
})
</script>

<template>
  <section class="static-icon" aria-labelledby="static-icon-heading">
    <div class="static-icon__heading-row">
      <div>
        <p class="static-icon__eyebrow font-maru-bold">New reusable icon</p>
        <h3 id="static-icon-heading" class="static-icon__heading font-maru-bold">Make it clear at 16×16</h3>
      </div>
      <button type="button" class="icon-library__text-action" :disabled="locked" @click="emit('cancel')">
        Cancel
      </button>
    </div>

    <label v-if="!hasImage" class="static-icon__file-drop" :class="{ 'static-icon__file-drop--loading': loading }">
      <input
        ref="fileInput"
        class="static-icon__file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        :aria-describedby="errorMessage ? 'static-icon-error' : undefined"
        :disabled="locked || loading"
        @change="onFileChange"
      >
      <span class="static-icon__file-title font-maru-bold">{{ loading ? 'Opening image…' : 'Choose a photo or drawing' }}</span>
      <span class="static-icon__file-help">PNG, JPEG, or WebP · up to 10 MiB</span>
    </label>

    <template v-else>
      <div class="static-icon__workspace">
        <div class="static-icon__crop-column">
          <div class="static-icon__canvas-frame static-icon__checkerboard">
            <canvas
              ref="cropCanvas"
              class="static-icon__crop-canvas"
              tabindex="0"
              role="img"
              aria-label="Square crop area. Drag to pan, use arrow keys to move, and plus or minus to zoom."
              @keydown="onCropKeydown"
              @pointerdown="onPointerDown"
              @pointermove="onPointerMove"
              @pointerup="onPointerEnd"
              @pointercancel="onPointerEnd"
            />
          </div>
          <p class="static-icon__source-name" :title="sourceName">{{ sourceName }}</p>
        </div>

        <div class="static-icon__controls">
          <div class="static-icon__preview-pair" aria-label="Icon previews">
            <figure class="static-icon__preview-figure">
              <div class="static-icon__actual-stage static-icon__checkerboard">
                <canvas ref="actualCanvas" class="static-icon__actual-canvas" width="16" height="16" aria-hidden="true" />
              </div>
              <figcaption>Actual 16×16</figcaption>
            </figure>
            <figure class="static-icon__preview-figure">
              <div class="static-icon__pixel-stage static-icon__checkerboard">
                <canvas ref="pixelCanvas" class="static-icon__pixel-canvas" width="16" height="16" aria-hidden="true" />
              </div>
              <figcaption>Pixel preview</figcaption>
            </figure>
          </div>

          <label class="static-icon__field" for="static-icon-zoom">
            <span class="static-icon__label">Zoom <output>{{ zoom.toFixed(1) }}×</output></span>
            <input id="static-icon-zoom" v-model.number="zoom" type="range" min="1" max="8" step="0.1" :disabled="locked">
          </label>

          <fieldset class="static-icon__fieldset">
            <legend class="static-icon__label">Background</legend>
            <label class="static-icon__choice">
              <input v-model="backgroundMode" type="radio" value="transparent" :disabled="locked">
              Transparent
            </label>
            <label class="static-icon__choice">
              <input v-model="backgroundMode" type="radio" value="solid" :disabled="locked">
              Solid
            </label>
            <label v-if="backgroundMode === 'solid'" class="static-icon__color-choice">
              <span>Color</span>
              <input v-model="backgroundColor" type="color" :disabled="locked" aria-label="Solid background color">
            </label>
          </fieldset>

          <label class="static-icon__field" for="static-icon-name">
            <span class="static-icon__label">Icon name</span>
            <input
              id="static-icon-name"
              v-model="filename"
              class="static-icon__name-input"
              type="text"
              maxlength="80"
              autocomplete="off"
              :disabled="locked"
            >
            <span v-if="filename !== safeFilename" class="static-icon__field-help">Uploads as {{ safeFilename }}</span>
          </label>
        </div>
      </div>

      <div class="static-icon__actions">
        <label class="icon-library__text-action static-icon__change-file">
          <input
            class="static-icon__file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            :aria-describedby="errorMessage ? 'static-icon-error' : undefined"
            :disabled="locked || loading"
            @change="onFileChange"
          >
          Change image
        </label>
        <button type="button" class="icon-library__secondary-button" :disabled="locked" @click="resetEdits">
          Reset
        </button>
        <button type="button" class="maru-button maru-button--sm bg-maru-blue text-maru-white" :disabled="locked" @click="onUpload">
          <span class="maru-button__label">{{ encoding ? 'Preparing…' : busy ? 'Uploading…' : 'Upload to Yoto' }}</span>
        </button>
      </div>
    </template>

    <p v-if="errorMessage" id="static-icon-error" class="icon-library__error" role="alert">{{ errorMessage }}</p>
  </section>
</template>

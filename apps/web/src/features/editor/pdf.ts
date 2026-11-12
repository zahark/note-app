/**
 * The PDF.js boundary: the only module that touches `pdfjs-dist`. PDF.js and its worker are loaded
 * with dynamic imports, so they land in their own lazy chunks and are fetched only when a PDF node is
 * shown. Tests mock this module.
 *
 * Build: the LEGACY build (`pdfjs-dist/legacy/build/…`, library and worker), which is transpiled and
 * polyfilled for older browsers (older iOS Safari and Android); the modern build needs very recent
 * JavaScript (e.g. `Map.prototype.getOrInsertComputed`) and would show "Preview unavailable" there.
 * It needs nothing more from the page CSP than the modern build (no eval: its only `Function(...)` is
 * core-js's `globalThis` fallback, never reached in a browser with ES modules).
 *
 * Hardening: the bytes are passed in as an `ArrayBuffer` (PDF.js never fetches the document from a
 * URL), the worker is the bundled same-origin file, XFA forms are off, and pages are drawn to a
 * canvas only: annotation appearances are painted into the image, but there is no annotation layer, so
 * nothing on the page is interactive (no links or form fields), and nothing runs the PDF's JavaScript
 * (scripting lives in PDF.js's viewer component, which is not used). PDF.js 6 no longer has the
 * `isEvalSupported` option: it has no eval-based code path left to disable.
 *
 * Fonts: the standard-14 font data and the CJK CMaps ship as same-origin static files
 * (`/pdfjs/standard_fonts/`, `/pdfjs/cmaps/`, copied from `pdfjs-dist` at build time, see
 * `vite.config.ts`), fetched only when a PDF needs them. The WebAssembly image decoders (JPEG 2000,
 * JBIG2) are not shipped: they would need `wasm-unsafe-eval` in the page CSP.
 */

/** A page render in progress; `cancel` stops it (its promise then rejects). */
export interface PdfRender {
  promise: Promise<void>
  cancel: () => void
}

/** An open PDF. */
export interface PdfDocument {
  numPages: number
  /** Draws page `pageNumber` (1-based) into `canvas`, scaled to `cssWidth` CSS pixels wide. */
  renderPage: (pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number) => PdfRender
}

/** A PDF being opened; `destroy` frees it (and its worker), whether or not it finished loading. */
export interface PdfLoad {
  promise: Promise<PdfDocument>
  destroy: () => void
}

/** Pixel density of the canvas backing store, capped so a huge page on a 3x screen stays affordable. */
const MAX_PIXEL_RATIO = 2

/**
 * Most pixels one page's canvas backing store may have (about 64 MB of RGBA; iOS Safari refuses
 * canvases past 16.7 M pixels). A page with an extreme aspect ratio is drawn at a lower resolution
 * instead of allocating a huge canvas.
 */
export const MAX_CANVAS_PIXELS = 16 * 1024 * 1024

/** Longest side of a canvas backing store (browsers fail to draw past about 32K pixels per side). */
export const MAX_CANVAS_SIDE = 16 * 1024

/**
 * The backing-store density for a page shown at `cssWidth` × `cssHeight` CSS pixels: the screen's
 * pixel ratio (at most `MAX_PIXEL_RATIO`), lowered as far as needed to stay within `MAX_CANVAS_PIXELS`
 * and `MAX_CANVAS_SIDE` (possibly below 1: a blurry page rather than a frozen tab).
 */
function canvasPixelRatio(cssWidth: number, cssHeight: number): number {
  const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)
  const area = cssWidth * cssHeight
  const byArea = area > 0 ? Math.sqrt(MAX_CANVAS_PIXELS / area) : ratio
  const bySide = MAX_CANVAS_SIDE / Math.max(cssWidth, cssHeight, 1)
  return Math.min(ratio, byArea, bySide)
}

/** Base URL of the static files PDF.js fetches on demand (see the module comment). */
const PDFJS_ASSETS = `${import.meta.env.BASE_URL}pdfjs/`

/** Opens `data` (the PDF's bytes) with PDF.js. */
export function loadPdf(data: ArrayBuffer): PdfLoad {
  let destroyed = false
  let destroyTask: (() => void) | null = null

  const open = async (): Promise<PdfDocument> => {
    const [pdfjs, worker] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
    ])
    if (destroyed) throw new Error('PDF load cancelled')
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default

    const task = pdfjs.getDocument({
      data,
      enableXfa: false,
      standardFontDataUrl: `${PDFJS_ASSETS}standard_fonts/`,
      cMapUrl: `${PDFJS_ASSETS}cmaps/`,
      cMapPacked: true,
    })
    destroyTask = () => void task.destroy()
    const doc = await task.promise

    return {
      numPages: doc.numPages,
      renderPage: (pageNumber, canvas, cssWidth) => {
        let cancelled = false
        let cancelRender: (() => void) | null = null
        const promise = (async () => {
          const page = await doc.getPage(pageNumber)
          if (cancelled) throw new Error('Render cancelled')
          const base = page.getViewport({ scale: 1 })
          const scale = cssWidth > 0 ? cssWidth / base.width : 1
          const css = page.getViewport({ scale })
          const ratio = canvasPixelRatio(css.width, css.height)
          const viewport = page.getViewport({ scale: scale * ratio })
          canvas.width = Math.max(1, Math.floor(viewport.width))
          canvas.height = Math.max(1, Math.floor(viewport.height))
          canvas.style.width = `${Math.floor(css.width)}px`
          canvas.style.height = `${Math.floor(css.height)}px`
          const render = page.render({ canvas, viewport })
          cancelRender = () => render.cancel()
          await render.promise
        })()
        return {
          promise,
          cancel: () => {
            cancelled = true
            cancelRender?.()
          },
        }
      },
    }
  }

  return {
    promise: open(),
    destroy: () => {
      destroyed = true
      destroyTask?.()
    },
  }
}

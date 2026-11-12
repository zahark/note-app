/**
 * The PDF.js boundary: the only module that touches `pdfjs-dist`. PDF.js and its worker are loaded
 * with dynamic imports, so they land in their own lazy chunks and are fetched only when a PDF node is
 * shown. Tests mock this module.
 *
 * Hardening: the bytes are passed in as an `ArrayBuffer` (PDF.js never fetches a URL), the worker is
 * the bundled same-origin file, XFA forms are off, and pages are drawn to a canvas only: no
 * annotation layer (so no links or form fields), and nothing that would run the PDF's JavaScript
 * (scripting lives in PDF.js's viewer component, which is not used). PDF.js 6 no longer has the
 * `isEvalSupported` option: it has no eval-based code path left to disable.
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

/** Opens `data` (the PDF's bytes) with PDF.js. */
export function loadPdf(data: ArrayBuffer): PdfLoad {
  let destroyed = false
  let destroyTask: (() => void) | null = null

  const open = async (): Promise<PdfDocument> => {
    const [pdfjs, worker] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ])
    if (destroyed) throw new Error('PDF load cancelled')
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default

    const task = pdfjs.getDocument({ data, enableXfa: false })
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
          const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)
          const viewport = page.getViewport({ scale: scale * ratio })
          canvas.width = Math.floor(viewport.width)
          canvas.height = Math.floor(viewport.height)
          canvas.style.width = `${Math.floor(viewport.width / ratio)}px`
          canvas.style.height = `${Math.floor(viewport.height / ratio)}px`
          const render = page.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE })
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

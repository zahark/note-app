import { beforeEach, describe, expect, it, vi } from 'vitest'

// the real PDF.js needs a worker and a canvas; the boundary's own wiring is checked against a fake
const pdfjs = vi.hoisted(() => {
  const renderCancel = vi.fn()
  const page = {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale })),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: renderCancel })),
  }
  const doc = { numPages: 2, getPage: vi.fn(async () => page) }
  const task = { promise: Promise.resolve(doc), destroy: vi.fn(async () => {}) }
  return {
    page,
    doc,
    task,
    renderCancel,
    module: {
      GlobalWorkerOptions: { workerSrc: '' },
      AnnotationMode: { DISABLE: 0, ENABLE: 1, ENABLE_FORMS: 2, ENABLE_STORAGE: 3 },
      getDocument: vi.fn(() => task),
    },
  }
})
vi.mock('pdfjs-dist', () => pdfjs.module)
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.min-abc123.mjs' }))

const { loadPdf } = await import('./pdf')

beforeEach(() => {
  pdfjs.module.getDocument.mockClear()
  pdfjs.task.destroy.mockClear()
  pdfjs.page.render.mockClear()
  pdfjs.renderCancel.mockClear()
})

describe('loadPdf', () => {
  it('opens the bytes with the bundled same-origin worker, XFA off, no URL', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer
    const doc = await loadPdf(bytes).promise

    expect(pdfjs.module.GlobalWorkerOptions.workerSrc).toBe('/assets/pdf.worker.min-abc123.mjs')
    expect(pdfjs.module.getDocument).toHaveBeenCalledWith({ data: bytes, enableXfa: false })
    expect(doc.numPages).toBe(2)
  })

  it('renders a page fit to the given width with canvas-only annotations (no forms, no links)', async () => {
    const doc = await loadPdf(new ArrayBuffer(4)).promise
    const canvas = document.createElement('canvas')
    await doc.renderPage(2, canvas, 300).promise

    expect(pdfjs.doc.getPage).toHaveBeenCalledWith(2)
    const params = (pdfjs.page.render.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(params.canvas).toBe(canvas)
    expect(params.annotationMode).toBe(pdfjs.module.AnnotationMode.ENABLE)
    // 600 pt wide page at 300 css px: half scale, 400 css px high
    expect(canvas.style.width).toBe('300px')
    expect(canvas.style.height).toBe('400px')
  })

  it('cancel stops the PDF.js render task', async () => {
    const doc = await loadPdf(new ArrayBuffer(4)).promise
    const render = doc.renderPage(1, document.createElement('canvas'), 300)
    await render.promise
    render.cancel()
    expect(pdfjs.renderCancel).toHaveBeenCalledTimes(1)
  })

  it('destroy destroys the loading task (and with it the document and worker)', async () => {
    const load = loadPdf(new ArrayBuffer(4))
    await load.promise
    load.destroy()
    expect(pdfjs.task.destroy).toHaveBeenCalledTimes(1)
  })

  it('destroy before PDF.js has loaded cancels the load', async () => {
    const load = loadPdf(new ArrayBuffer(4))
    load.destroy()
    await expect(load.promise).rejects.toThrow('cancelled')
    expect(pdfjs.module.getDocument).not.toHaveBeenCalled()
  })
})

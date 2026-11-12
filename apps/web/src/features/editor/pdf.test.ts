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
      getDocument: vi.fn(() => task),
    },
  }
})
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => pdfjs.module)
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.min-abc123.mjs' }))

const { loadPdf, MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE } = await import('./pdf')

const pageSize = (width: number, height: number) =>
  pdfjs.page.getViewport.mockImplementation(({ scale }: { scale: number }) => ({ width: width * scale, height: height * scale }))

beforeEach(() => {
  pdfjs.module.getDocument.mockClear()
  pdfjs.task.destroy.mockClear()
  pdfjs.page.render.mockClear()
  pdfjs.renderCancel.mockClear()
  pdfjs.doc.getPage.mockClear()
  pageSize(600, 800)
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(1)
})

describe('loadPdf', () => {
  it('opens the bytes with the bundled same-origin worker, XFA off, same-origin font data, no document URL', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer
    const doc = await loadPdf(bytes).promise

    expect(pdfjs.module.GlobalWorkerOptions.workerSrc).toBe('/assets/pdf.worker.min-abc123.mjs')
    expect(pdfjs.module.getDocument).toHaveBeenCalledWith({
      data: bytes,
      enableXfa: false,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
    })
    expect(doc.numPages).toBe(2)
  })

  it('renders a page fit to the given width onto the canvas only (no annotation layer)', async () => {
    const doc = await loadPdf(new ArrayBuffer(4)).promise
    const canvas = document.createElement('canvas')
    await doc.renderPage(2, canvas, 300).promise

    expect(pdfjs.doc.getPage).toHaveBeenCalledWith(2)
    const params = (pdfjs.page.render.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(params.canvas).toBe(canvas)
    expect(params.viewport).toEqual({ width: 300, height: 400 })
    // 600 pt wide page at 300 css px: half scale, 400 css px high
    expect(canvas.style.width).toBe('300px')
    expect(canvas.style.height).toBe('400px')
    expect([canvas.width, canvas.height]).toEqual([300, 400])
  })

  it('draws at the screen pixel ratio, capped at 2x', async () => {
    const doc = await loadPdf(new ArrayBuffer(4)).promise
    const canvas = document.createElement('canvas')
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2)
    await doc.renderPage(1, canvas, 300).promise
    expect([canvas.width, canvas.height]).toEqual([600, 800])
    expect([canvas.style.width, canvas.style.height]).toEqual(['300px', '400px'])

    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(3)
    await doc.renderPage(1, canvas, 300).promise
    expect([canvas.width, canvas.height]).toEqual([600, 800])
    expect([canvas.style.width, canvas.style.height]).toEqual(['300px', '400px'])
  })

  it('without a width (not laid out yet) draws the page at its natural size', async () => {
    const doc = await loadPdf(new ArrayBuffer(4)).promise
    const canvas = document.createElement('canvas')
    await doc.renderPage(1, canvas, 0).promise
    expect([canvas.style.width, canvas.style.height]).toEqual(['600px', '800px'])
    expect([canvas.width, canvas.height]).toEqual([600, 800])
  })

  it('caps the backing store of an extreme page instead of allocating a huge canvas', async () => {
    // 1 pt wide, 14400 pt tall: at 700 css px wide the page is 10 million css px tall
    pageSize(1, 14400)
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2)
    const doc = await loadPdf(new ArrayBuffer(4)).promise
    const canvas = document.createElement('canvas')
    await doc.renderPage(1, canvas, 700).promise
    expect(canvas.style.width).toBe('700px')
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS)
    expect(Math.max(canvas.width, canvas.height)).toBeLessThanOrEqual(MAX_CANVAS_SIDE)
    expect(canvas.width).toBeGreaterThanOrEqual(1)
  })

  it('caps a large page by area, keeping its aspect ratio', async () => {
    pageSize(1000, 1000)
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2)
    const doc = await loadPdf(new ArrayBuffer(4)).promise
    const canvas = document.createElement('canvas')
    await doc.renderPage(1, canvas, 4000).promise
    expect(canvas.style.width).toBe('4000px')
    expect(canvas.width).toBe(canvas.height)
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS)
    expect(canvas.width * canvas.height).toBeGreaterThan(MAX_CANVAS_PIXELS * 0.99)
  })

  it('a render cancelled before its page has loaded never draws', async () => {
    const doc = await loadPdf(new ArrayBuffer(4)).promise
    let releasePage!: (page: typeof pdfjs.page) => void
    pdfjs.doc.getPage.mockImplementationOnce(() => new Promise((resolve) => (releasePage = resolve)))
    const render = doc.renderPage(1, document.createElement('canvas'), 300)
    render.cancel()
    releasePage(pdfjs.page)
    await expect(render.promise).rejects.toThrow('Render cancelled')
    expect(pdfjs.page.render).not.toHaveBeenCalled()
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

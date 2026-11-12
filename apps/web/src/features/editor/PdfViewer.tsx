import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AttachmentResolver } from './AttachmentImage'
import { loadPdf, type PdfDocument, type PdfLoad } from './pdf'

export interface PdfViewerProps {
  /** The attachment to preview. The viewer is keyed by it, so a new id starts a fresh load. */
  aid: string
  /** The node's resolver: the owner's `/api/attachments/:aid` or the shared view's blob URL. */
  resolveAttachment: AttachmentResolver | null
}

type ViewerState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; doc: PdfDocument }

/**
 * The PDF's bytes, through the same path as an image's: the resolver's URL (session cookie for the
 * owner, a blob URL the shared view fetched with its credential), read as an `ArrayBuffer`.
 */
async function fetchPdfBytes(aid: string, resolve: AttachmentResolver | null): Promise<ArrayBuffer> {
  if (!resolve) throw new Error('No attachment resolver')
  const url = await resolve(aid)
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`PDF fetch failed: ${res.status}`)
  return res.arrayBuffer()
}

/**
 * In-note PDF preview: the current page drawn fit-to-width on a canvas (in a box at most 480 px high,
 * scrolling past that), previous/next buttons and "Page i of n". While loading it says so; if the
 * bytes or PDF.js fail it says "Preview unavailable, download instead" (the chip's Download button
 * keeps working). The PDF is destroyed on unmount.
 */
export function PdfViewer({ aid, resolveAttachment }: PdfViewerProps) {
  const [state, setState] = useState<ViewerState>({ status: 'loading' })
  const [page, setPage] = useState(1)
  // the container's width, for fit-to-width; only a change re-renders the page
  const [width, setWidth] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let active = true
    let load: PdfLoad | null = null
    fetchPdfBytes(aid, resolveAttachment)
      .then((bytes) => {
        if (!active) return null
        load = loadPdf(bytes)
        return load.promise
      })
      .then(
        (doc) => {
          if (active && doc) setState({ status: 'ready', doc })
        },
        () => {
          if (active) setState({ status: 'error' })
        },
      )
    return () => {
      active = false
      load?.destroy()
    }
  }, [aid, resolveAttachment])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0)
      setWidth((current) => (current === next ? current : next))
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (state.status !== 'ready' || !canvas) return
    let cancelled = false
    const render = state.doc.renderPage(page, canvas, width || containerRef.current?.clientWidth || 0)
    render.promise.catch(() => {
      if (!cancelled) setState({ status: 'error' })
    })
    return () => {
      cancelled = true
      render.cancel()
    }
  }, [state, page, width])

  const numPages = state.status === 'ready' ? state.doc.numPages : 0

  return (
    <div className="pdf-viewer border-t" data-state={state.status}>
      <div ref={containerRef} className="max-h-[480px] overflow-auto bg-muted/40">
        {state.status === 'loading' && (
          <p role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">
            Loading preview…
          </p>
        )}
        {state.status === 'error' && (
          <p role="alert" className="px-3 py-6 text-center text-sm text-muted-foreground">
            Preview unavailable, download instead
          </p>
        )}
        <canvas
          ref={canvasRef}
          hidden={state.status !== 'ready'}
          className="mx-auto block max-w-full"
          aria-label={numPages ? `Page ${page} of ${numPages}` : undefined}
        />
      </div>
      {state.status === 'ready' && (
        <div className="flex items-center justify-center gap-2 border-t px-3 py-1.5 text-sm">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft />
          </Button>
          <span aria-live="polite" data-role="page-status">
            Page {page} of {numPages}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next page"
            disabled={page >= numPages}
            onClick={() => setPage((p) => Math.min(numPages, p + 1))}
          >
            <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  )
}

import { useEffect, useRef, useState, type RefObject } from 'react'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { apiFetchResponse } from '@/lib/api'
import type { AttachmentResolver } from './attachmentRef'
import { loadPdf, type PdfDocument, type PdfLoad } from './pdf'

/** Told why a preview failed: an `ApiError` when the bytes could not be fetched, else PDF.js's error. */
export type PdfPreviewErrorHandler = (err: unknown) => void

export interface PdfViewerProps {
  /** The attachment to preview. */
  aid: string
  /** The node's resolver: the owner's `/api/attachments/:aid` or the shared view's blob URL. */
  resolveAttachment: AttachmentResolver | null
  /** Called once when the preview fails (the owner's editor sends an expired session to login). */
  onError?: PdfPreviewErrorHandler | null
}

type ViewerState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; doc: PdfDocument }

/**
 * The PDF's bytes, through the same path as an image's: the resolver's URL (session cookie for the
 * owner, a blob URL the shared view fetched with its credential), read as an `ArrayBuffer`. Fetched
 * with `apiFetchResponse`, so a failed request is an `ApiError` (an expired session is a 401
 * `UNAUTHORIZED`). `signal` aborts the transfer (the viewer unmounted).
 */
async function fetchPdfBytes(aid: string, resolve: AttachmentResolver | null, signal: AbortSignal): Promise<ArrayBuffer> {
  if (!resolve) throw new Error('No attachment resolver')
  const url = await resolve(aid)
  const res = await apiFetchResponse(url, { signal })
  return res.arrayBuffer()
}

/** How far outside the viewport a viewer starts loading, so it is usually ready when scrolled to. */
const PRELOAD_MARGIN = '200px'

/**
 * True once `ref`'s element has come within `PRELOAD_MARGIN` of the viewport (and from then on), so a
 * note with several PDFs only downloads and opens the ones that are shown. Without
 * `IntersectionObserver` it is true at once.
 */
function useSeenOnce(ref: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const el = ref.current
    if (seen || !el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect()
          setSeen(true)
        }
      },
      { rootMargin: PRELOAD_MARGIN },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, seen])
  return seen
}

/**
 * In-note PDF preview: the current page drawn fit-to-width on a canvas (in a box at most 480 px high,
 * scrolling past that), previous/next buttons and "Page i of n". The PDF is fetched and opened only
 * once the viewer comes into view. While loading it says so; if the bytes or PDF.js fail it says
 * "Preview unavailable, download instead" (the chip's Download button keeps working) and calls
 * `onError`. On unmount a running fetch is aborted and the PDF destroyed.
 */
export function PdfViewer({ aid, resolveAttachment, onError = null }: PdfViewerProps) {
  const [state, setState] = useState<ViewerState>({ status: 'loading' })
  // the load effect reports through this ref, so a new handler never restarts the load
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onErrorRef.current = onError
  })
  const [page, setPage] = useState(1)
  // the container's width, for fit-to-width; only a change re-renders the page
  const [width, setWidth] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visible = useSeenOnce(rootRef)

  useEffect(() => {
    if (!visible) return
    let active = true
    let load: PdfLoad | null = null
    const abort = new AbortController()
    fetchPdfBytes(aid, resolveAttachment, abort.signal)
      .then((bytes) => {
        if (!active) return null
        load = loadPdf(bytes)
        return load.promise
      })
      .then(
        (doc) => {
          if (active && doc) setState({ status: 'ready', doc })
        },
        (err: unknown) => {
          if (!active) return
          setState({ status: 'error' })
          onErrorRef.current?.(err)
        },
      )
    return () => {
      active = false
      abort.abort()
      load?.destroy()
    }
  }, [visible, aid, resolveAttachment])

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
    <div ref={rootRef} className="pdf-viewer border-t" data-state={state.status}>
      {/* the gutter is always reserved, so a scrollbar appearing never changes the width the page is fitted to (no resize loop) */}
      <div ref={containerRef} className="max-h-[480px] overflow-auto bg-muted/40 [scrollbar-gutter:stable]">
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
            <ChevronLeftIcon />
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
            <ChevronRightIcon />
          </Button>
        </div>
      )}
    </div>
  )
}

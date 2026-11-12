import { useState, type ReactNode } from 'react'
import { MenuIcon } from 'lucide-react'
import { useDefaultLayout } from 'react-resizable-panels'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/useMediaQuery'

interface LayoutProps {
  /** Sidebar content (folder tree, settings). */
  sidebar: ReactNode
  /** Main pane content (editor). */
  children: ReactNode
  /** The mobile drawer closes whenever this value changes (e.g. the open note's id). */
  closeDrawerOn?: unknown
}

const DESKTOP_PANELS = ['sidebar', 'main']
const MOBILE_PANELS = ['main']

/**
 * Two-pane app shell: a resizable sidebar beside the main pane on wide screens (the split is remembered),
 * and a top bar with a slide-in drawer for the sidebar on narrow screens.
 *
 * Both modes share one element tree in which the main pane keeps the same position: crossing the
 * breakpoint (rotation, resize) only adds or removes the sidebar around it, so the open editor is
 * never unmounted and remounted.
 */
export function Layout({ sidebar, children, closeDrawerOn }: LayoutProps) {
  const isMobile = useIsMobile()
  const [drawerOpen, setDrawerOpen] = useState(false)
  // opening a note from the drawer shows it: close the drawer when the note changes
  const [drawerKey, setDrawerKey] = useState(closeDrawerOn)
  if (drawerKey !== closeDrawerOn) {
    setDrawerKey(closeDrawerOn)
    setDrawerOpen(false)
  }
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'notes-layout',
    panelIds: isMobile ? MOBILE_PANELS : DESKTOP_PANELS,
  })

  const aside = (
    <aside aria-label="Sidebar" className="flex h-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground">
      {sidebar}
    </aside>
  )

  return (
    <div className="flex h-svh flex-col">
      {isMobile && (
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
          <Button variant="ghost" size="icon" aria-label="Open sidebar" onClick={() => setDrawerOpen(true)}>
            <MenuIcon />
          </Button>
          <span className="font-semibold">Notes</span>
        </header>
      )}
      {isMobile && (
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetContent side="left" className="w-[85vw] max-w-sm p-0">
            <SheetHeader className="sr-only">
              <SheetTitle>Sidebar</SheetTitle>
              <SheetDescription>Folders and notes</SheetDescription>
            </SheetHeader>
            {aside}
          </SheetContent>
        </Sheet>
      )}
      <ResizablePanelGroup
        id="notes-layout"
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        {!isMobile && (
          <ResizablePanel id="sidebar" defaultSize="25%" minSize="15%" maxSize="50%">
            {aside}
          </ResizablePanel>
        )}
        {!isMobile && <ResizableHandle />}
        <ResizablePanel id="main" minSize="30%">
          <main className="h-full overflow-auto">{children}</main>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

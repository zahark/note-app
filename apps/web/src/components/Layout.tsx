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
}

/**
 * Two-pane app shell: a resizable sidebar beside the main pane on wide screens (the split is remembered),
 * and a top bar with a slide-in drawer for the sidebar on narrow screens.
 */
export function Layout({ sidebar, children }: LayoutProps) {
  const isMobile = useIsMobile()
  return isMobile ? <MobileLayout sidebar={sidebar}>{children}</MobileLayout> : <DesktopLayout sidebar={sidebar}>{children}</DesktopLayout>
}

function DesktopLayout({ sidebar, children }: LayoutProps) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: 'notes-layout' })
  return (
    <ResizablePanelGroup
      id="notes-layout"
      orientation="horizontal"
      className="h-svh"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      <ResizablePanel id="sidebar" defaultSize="25%" minSize="15%" maxSize="50%">
        <aside aria-label="Sidebar" className="flex h-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground">
          {sidebar}
        </aside>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="main" minSize="30%">
        <main className="h-full overflow-auto">{children}</main>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

function MobileLayout({ sidebar, children }: LayoutProps) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex h-svh flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
        <Button variant="ghost" size="icon" aria-label="Open sidebar" onClick={() => setOpen(true)}>
          <MenuIcon />
        </Button>
        <span className="font-semibold">Notes</span>
      </header>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-[85vw] max-w-sm p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Sidebar</SheetTitle>
            <SheetDescription>Folders and notes</SheetDescription>
          </SheetHeader>
          <aside aria-label="Sidebar" className="flex h-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground">
            {sidebar}
          </aside>
        </SheetContent>
      </Sheet>
      <main className="min-h-0 flex-1 overflow-auto">{children}</main>
    </div>
  )
}

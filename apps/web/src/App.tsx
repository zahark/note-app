import { useState, type ReactNode } from 'react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { Layout } from '@/components/Layout'
import { Toaster } from '@/components/ui/sonner'
import { LoginPage } from '@/features/auth/LoginPage'
import { RequireAuth } from '@/features/auth/RequireAuth'
import { SettingsDialog } from '@/features/auth/SettingsDialog'
import { SharedNotePage } from '@/features/share/SharedNotePage'
import { Sidebar } from '@/features/tree/Sidebar'
import { createQueryClient } from '@/lib/queryClient'

function HomePage() {
  return (
    <Layout
      sidebar={
        <>
          <Sidebar />
          <div className="border-t p-2">
            <SettingsDialog />
          </div>
        </>
      }
    >
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        Select a note or create a new one.
      </div>
    </Layout>
  )
}

/** Route table; rendered inside a router (BrowserRouter in the app, MemoryRouter in tests). */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/shared/:id" element={<SharedNotePage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <HomePage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

/** Query client and toasts, shared by the app and tests. */
export function AppProviders({ client, children }: { client: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      {children}
      <Toaster />
    </QueryClientProvider>
  )
}

function App() {
  const [client] = useState(createQueryClient)
  return (
    <AppProviders client={client}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AppProviders>
  )
}

export default App

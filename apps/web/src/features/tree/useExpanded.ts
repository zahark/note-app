import { useCallback, useEffect, useState } from 'react'

export const EXPANDED_STORAGE_KEY = 'notes-app:tree-expanded'

function load(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(EXPANDED_STORAGE_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    // storage blocked or corrupt: start collapsed
    return new Set()
  }
}

/** Expanded folder ids, remembered in localStorage across reloads. */
export function useExpanded() {
  const [expanded, setExpanded] = useState(load)

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...expanded]))
    } catch {
      // storage unavailable: expanded state lasts for this page only
    }
  }, [expanded])

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  const expand = useCallback((id: string) => {
    setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
  }, [])

  return { expanded, toggle, expand }
}

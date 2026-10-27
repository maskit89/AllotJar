import { useCallback, useState } from 'react'
import { isJarSort, type JarSort } from './jarStatus'

const KEY = 'zbb.jarSort'

/** The order last picked on this device; attention first until one is picked or when storage is blocked. */
function stored(): JarSort {
  try {
    const v = localStorage.getItem(KEY)
    return isJarSort(v) ? v : 'attention'
  } catch {
    return 'attention'
  }
}

/** The Jars page's order, remembered on this device (like the theme). */
export function useJarSort(): [JarSort, (sort: JarSort) => void] {
  const [sort, setSort] = useState<JarSort>(stored)
  const pick = useCallback((next: JarSort) => {
    setSort(next)
    try {
      if (next === 'attention') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, next)
    } catch {
      // Blocked storage: the pick holds until the page is left.
    }
  }, [])
  return [sort, pick]
}

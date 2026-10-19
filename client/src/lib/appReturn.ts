import { useEffect, useRef } from 'react'

/** How long the app must have been away before coming back reloads the page's figures (App.tsx). */
export const RELOAD_AFTER_MS = 10 * 60_000

/**
 * Calls `onReturn(awayMs)` each time the page comes back on screen after being hidden: the
 * installed app brought back from the background (a phone usually resumes it rather than
 * starting it afresh), or a browser tab switched back to. `awayMs` is how long it was hidden.
 */
export function useOnReturn(onReturn: (awayMs: number) => void): void {
  const latest = useRef(onReturn)
  useEffect(() => {
    latest.current = onReturn
  })
  useEffect(() => {
    let hiddenAt: number | null = document.visibilityState === 'hidden' ? Date.now() : null
    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        return
      }
      if (hiddenAt === null) return
      const awayMs = Date.now() - hiddenAt
      hiddenAt = null
      latest.current(awayMs)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])
}

// Fields that take typing. A focused checkbox, radio or button holds nothing half-entered.
const ENTRY_FIELD =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]), textarea, select'

/**
 * True while the person is part-way through entering something: a field has the focus, or a
 * dialog (a form, a confirmation, an open popover) is up. Nothing may reload under them then.
 */
export function isMidEntry(doc: Document = document): boolean {
  const active = doc.activeElement
  if (active instanceof HTMLElement && (active.isContentEditable || active.matches(ENTRY_FIELD))) return true
  return doc.querySelector('[role="dialog"], [role="alertdialog"]') !== null
}

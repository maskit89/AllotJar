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
 * True while the person is part-way through entering something: a field has the focus, a
 * dialog (a form, a confirmation, an open popover) is up, or an inline editor is open (marked
 * `data-entry`: a transaction's or an account's editor, a new budget line or group), whatever
 * has the focus. Nothing may reload under them then.
 */
export function isMidEntry(doc: Document = document): boolean {
  const active = doc.activeElement
  if (active instanceof HTMLElement && (active.isContentEditable || active.matches(ENTRY_FIELD))) return true
  return doc.querySelector('[role="dialog"], [role="alertdialog"], [data-entry]') !== null
}

// The built app's one entry script (Vite names it by its content hash).
const ENTRY_SCRIPT = /<script[^>]*type="module"[^>]*src="(\/assets\/[^"]+\.js)"/

/**
 * True when the server now has a newer build than the one running: index.html (never cached,
 * web.config) names a different entry script. An installed app is resumed for days, so after a
 * deploy it would otherwise keep saving through the old forms. False when it can't tell (the dev
 * server, no network, an unexpected page), so a failed check never forces a reload.
 */
export async function hasNewerBuild(doc: Document = document, fetchPage: typeof fetch = fetch): Promise<boolean> {
  const running = doc.querySelector<HTMLScriptElement>('script[type="module"][src^="/assets/"]')?.getAttribute('src')
  if (!running) return false
  try {
    const response = await fetchPage('/index.html', { cache: 'no-store' })
    if (!response.ok) return false
    const served = ENTRY_SCRIPT.exec(await response.text())?.[1]
    return !!served && served !== running
  } catch {
    return false
  }
}

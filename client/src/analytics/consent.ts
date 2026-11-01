// Persisted analytics-consent choice (GDPR/ePrivacy). Storage-only; the provider
// orchestrates what happens when it changes.

const KEY = 'allotjar.analyticsConsent'

export type ConsentChoice = 'granted' | 'denied'

/** The stored choice, or null when the user hasn't decided yet (⇒ show the banner). */
export function getConsent(): ConsentChoice | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'granted' || v === 'denied' ? v : null
  } catch {
    return null
  }
}

/** Persist (or clear, when given null) the consent choice. */
export function setConsent(choice: ConsentChoice | null): void {
  try {
    if (choice) localStorage.setItem(KEY, choice)
    else localStorage.removeItem(KEY)
  } catch {
    // Storage can throw in private-mode / restricted contexts; tracking simply won't persist.
  }
}

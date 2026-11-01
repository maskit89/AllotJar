// Before November 2026 the app kept its browser storage under the prefix 'zbb.' (from its old
// name). On start, each such key moves once to the same name under 'allotjar.', so saved
// preferences (theme, currency, money format, onboarding) carry over. A value already kept under
// the new name wins. Keys that older versions used for who was signed in are removed, never
// moved: identity is read from the server and is not kept in the browser (D2, client P3-8).

const OLD_PREFIX = 'zbb.'
const NEW_PREFIX = 'allotjar.'
const NEVER_MOVED = new Set(['zbb.email', 'zbb.role', 'zbb.displayName', 'zbb.token'])

export function moveLegacyStorage(storage: Storage = localStorage): void {
  try {
    const oldKeys: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key !== null && key.startsWith(OLD_PREFIX)) oldKeys.push(key)
    }
    for (const key of oldKeys) {
      if (!NEVER_MOVED.has(key)) {
        const newKey = NEW_PREFIX + key.slice(OLD_PREFIX.length)
        const value = storage.getItem(key)
        if (value !== null && storage.getItem(newKey) === null) storage.setItem(newKey, value)
      }
      storage.removeItem(key)
    }
  } catch {
    // Storage unavailable (private mode, blocked site data): there is nothing to move.
  }
}

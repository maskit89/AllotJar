import { useAuth } from '../auth/AuthContext'

/** Two-letter initials from a display name (or the email's first letter). */
export function initialsOf(name: string, email: string | null): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const initials = words.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('')
  return initials || email?.trim().charAt(0).toUpperCase() || '?'
}

/** Who is signed in, as the frame shows them: name, initials and the active household's label. */
export function useAccountIdentity() {
  const { email, displayName, households } = useAuth()
  const name = displayName || email || ''
  return {
    name,
    initials: initialsOf(name, email),
    householdLabel: households.find((h) => h.isActive)?.label ?? 'Personal',
  }
}

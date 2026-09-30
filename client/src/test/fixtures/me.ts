// The login as GET /auth/me answers it, shared by the Jars, Account page and ConsentModal tests:
// Alex, who owns household u1, and Sam, who only joined Alex's household.
import type { MeResponse } from '../../types'

/** Alex (u1), the owner of their own household. */
export function me(over: Partial<MeResponse> = {}): MeResponse {
  return { userId: 'u1', email: 'alex@x.com', displayName: 'Alex', role: 0, ownerId: 'u1', memberId: null, ...over }
}

/** Alex viewing their own household, with the household list the Account page reads. */
export const ownerMe: MeResponse = me({
  households: [{ ownerId: 'u1', label: 'Your household', role: 0, isActive: true, isOwn: true }],
})

/** Sam (u2), who joined Alex's household (owner-1) at `role` and has no household of their own. */
export function joinedMe(role: number, over: Partial<MeResponse> = {}): MeResponse {
  return me({
    userId: 'u2',
    email: 'sam@x.com',
    displayName: 'Sam',
    role,
    ownerId: 'owner-1',
    households: [{ ownerId: 'owner-1', label: 'Alex', role, isActive: true, isOwn: false }],
    ...over,
  })
}

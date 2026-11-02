import axios from 'axios'

/** What the login can prove it is the owner with, when the server asks (a 403 with `proof`). */
export interface ProofKinds {
  password: boolean
  passkey: boolean
  recoveryCode: boolean
}

export type Proof = { password?: string; recoveryCode?: string; ceremony?: string; credential?: string }

/** The server's 403 that asks for proof first: which kinds this login can give. */
export function proofAsked(err: unknown): ProofKinds | null {
  if (!axios.isAxiosError(err) || err.response?.status !== 403) return null
  return (err.response.data as { proof?: ProofKinds } | undefined)?.proof ?? null
}

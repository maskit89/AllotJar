import { useEffect, useId, useState, type FormEvent } from 'react'
import axios from 'axios'
import { Check, Copy, Download, KeyRound, ListChecks, Monitor, Smartphone, Tablet } from 'lucide-react'
import { Modal } from '../Modal'
import { Button, Input } from '../ui'
import { InfoHint } from '../InfoHint'
import { StatusChip } from '../StatusChip'
import { useAuth } from '../../auth/AuthContext'
import { api } from '../../lib/api'
import { createPasskey, getPasskey, passkeyError, passkeysSupported } from '../../lib/passkeys'
import {
  DIALOG_ACTIONS,
  DIALOG_BAD,
  DIALOG_BODY,
  DIALOG_CANCEL,
  DIALOG_PRIMARY,
  OUTLINE_SM,
  ROW,
  ROW_HINT,
  ROW_TITLE,
  Tile,
} from './parts'

/** One of the login's passkeys, as GET /auth/passkeys lists it. */
export interface Passkey {
  /** The credential id, base64url. */
  id: string
  /** The device it was added on ("Safari on iPhone"). */
  name: string | null
  createdUtc: string
}

interface PasskeyList {
  passkeys: Passkey[]
  recoveryCodesLeft: number
}

/** What the login can prove it is the owner with, when the server asks (a 403 with `proof`). */
interface ProofKinds {
  password: boolean
  passkey: boolean
  recoveryCode: boolean
}

type Proof = { password?: string; recoveryCode?: string; ceremony?: string; credential?: string }

const STEEL = 'var(--color-steel)'
const SUB = 'text-[13px] leading-[1.45] text-slate-500'

function PasskeyIcon({ name }: { name: string | null }) {
  if (name?.endsWith('iPad')) return <Tablet strokeWidth={1.8} />
  if (name?.endsWith('iPhone') || name?.endsWith('Android')) return <Smartphone strokeWidth={1.8} />
  if (name) return <Monitor strokeWidth={1.8} />
  return <KeyRound strokeWidth={1.8} />
}

function addedOn(iso: string): string {
  return `Added ${new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
}

/** The server's 403 that asks for proof first: which kinds this login can give. */
function proofAsked(err: unknown): ProofKinds | null {
  if (!axios.isAxiosError(err) || err.response?.status !== 403) return null
  return (err.response.data as { proof?: ProofKinds } | undefined)?.proof ?? null
}

/**
 * The Sign-in card's passkey rows (two-factor sign-in, fix 14): one to add a passkey, one per
 * passkey with Remove, and the recovery codes left with New codes. Changing them long after signing
 * in asks the owner to confirm it's them first (password, passkey or a recovery code). The first
 * passkey shows the recovery codes once.
 */
export function PasskeyRows() {
  const [list, setList] = useState<PasskeyList | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [removing, setRemoving] = useState<Passkey | null>(null)
  // A change waiting on proof: what to retry with it, and which proofs the login has.
  const [asking, setAsking] = useState<{ kinds: ProofKinds; retry: (proof: Proof) => Promise<void> } | null>(null)
  const [canAdd] = useState(passkeysSupported)

  async function load() {
    try {
      const { data } = await api.get<PasskeyList>('/auth/passkeys')
      if (Array.isArray(data?.passkeys)) setList(data)
      else setLoadFailed(true)
    } catch {
      setLoadFailed(true)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  /** Runs a change; when the server asks for proof first, opens Confirm it's you and retries from there. */
  async function withProof(change: (proof?: Proof) => Promise<void>) {
    setError(null)
    setBusy(true)
    try {
      await change()
    } catch (err) {
      const kinds = proofAsked(err)
      if (kinds) {
        // The remove dialog gives way to Confirm it's you, which finishes the removal.
        setRemoving(null)
        setAsking({ kinds, retry: change })
      } else {
        const message = passkeyError(err, 'Something went wrong. Please try again.')
        if (message) setError(message)
      }
    } finally {
      setBusy(false)
    }
  }

  const add = (proof?: Proof) =>
    (async () => {
      const { data: start } = await api.post<{ ceremony: string; options: string }>('/auth/passkeys/options', { proof })
      const credential = await createPasskey(start.options)
      const { data } = await api.post<{ passkey: Passkey; recoveryCodes: string[] | null }>('/auth/passkeys', {
        ceremony: start.ceremony,
        credential,
      })
      if (data.recoveryCodes) setCodes(data.recoveryCodes)
      await load()
    })()

  const remove = (passkey: Passkey) => (proof?: Proof) =>
    (async () => {
      await api.post(`/auth/passkeys/${encodeURIComponent(passkey.id)}/remove`, { proof })
      setRemoving(null)
      await load()
    })()

  const newCodes = (proof?: Proof) =>
    (async () => {
      const { data } = await api.post<{ recoveryCodes: string[] }>('/auth/passkeys/recovery-codes', { proof })
      setCodes(data.recoveryCodes)
      await load()
    })()

  const passkeys = list?.passkeys ?? []
  const on = passkeys.length > 0

  return (
    <>
      <div className={`${ROW} flex-wrap`} aria-busy={list === null && !loadFailed ? true : undefined}>
        <Tile color={STEEL}>
          <KeyRound strokeWidth={1.8} />
        </Tile>
        <span className="flex min-w-0 flex-[1_1_auto] items-center gap-1">
          <h3 className={ROW_TITLE}>Passkeys</h3>
          <InfoHint label="About passkeys" buttonClassName={ROW_HINT} align="end" fixed>
            A passkey signs you in with your device's fingerprint, face or PIN, or a password manager. Once you have one,
            signing in with a password or Google asks for it too. Recovery codes stand in if you lose it.
          </InfoHint>
        </span>
        {on && (
          <StatusChip tone="ok">
            <Check aria-hidden strokeWidth={2} />
            On
          </StatusChip>
        )}
        {canAdd && list && (
          <button
            type="button"
            onClick={() => void withProof(add)}
            aria-disabled={busy || undefined}
            aria-label={on ? 'Add another passkey' : 'Add a passkey'}
            className={`${OUTLINE_SM} ml-auto aria-disabled:pointer-events-none aria-disabled:opacity-50`}
          >
            Add
          </button>
        )}
      </div>

      {passkeys.map((p) => {
        const name = p.name ?? 'Passkey'
        return (
          <div key={p.id} className={`${ROW} flex-wrap`}>
            <Tile color={STEEL} tint="10%">
              <PasskeyIcon name={p.name} />
            </Tile>
            <div className="flex min-w-0 flex-[1_1_auto] flex-col gap-0.5">
              <h3 className={ROW_TITLE}>{name}</h3>
              <p className={SUB}>{addedOn(p.createdUtc)}</p>
            </div>
            <button type="button" onClick={() => setRemoving(p)} aria-label={`Remove passkey ${name}`} className={`${OUTLINE_SM} ml-auto`}>
              Remove
            </button>
          </div>
        )
      })}

      {on && (
        <div className={`${ROW} flex-wrap`}>
          <Tile color={STEEL} tint="10%">
            <ListChecks strokeWidth={1.8} />
          </Tile>
          <div className="flex min-w-0 flex-[1_1_auto] flex-col gap-0.5">
            <h3 className={ROW_TITLE}>Recovery codes</h3>
            <p className={list && list.recoveryCodesLeft <= 2 ? 'text-[13px] leading-[1.45] font-semibold text-warn' : SUB}>
              {list?.recoveryCodesLeft ?? 0} left
            </p>
          </div>
          <button
            type="button"
            onClick={() => void withProof(newCodes)}
            aria-disabled={busy || undefined}
            className={`${OUTLINE_SM} ml-auto aria-disabled:pointer-events-none aria-disabled:opacity-50`}
          >
            New codes
          </button>
        </div>
      )}

      {loadFailed && <p className="mt-2 text-[13px] text-slate-500">Could not load your passkeys.</p>}
      {error && (
        <p role="alert" className="auth-error mt-2">
          {error}
        </p>
      )}

      {removing && (
        <RemoveDialog
          passkey={removing}
          last={passkeys.length === 1}
          busy={busy}
          onRemove={() => void withProof(remove(removing))}
          onClose={() => setRemoving(null)}
        />
      )}
      {asking && (
        <ConfirmItsYouDialog
          kinds={asking.kinds}
          onProof={async (proof) => {
            await asking.retry(proof)
            setAsking(null)
          }}
          onClose={() => setAsking(null)}
        />
      )}
      {codes && <RecoveryCodesDialog codes={codes} onClose={() => setCodes(null)} />}
    </>
  )
}

function RemoveDialog({
  passkey,
  last,
  busy,
  onRemove,
  onClose,
}: {
  passkey: Passkey
  last: boolean
  busy: boolean
  onRemove: () => void
  onClose: () => void
}) {
  const name = passkey.name ?? 'This passkey'
  return (
    <Modal
      sheet
      title="Remove this passkey?"
      onClose={() => {
        if (!busy) onClose()
      }}
      footer={
        <div className={DIALOG_ACTIONS}>
          <Button variant="ghost" onClick={onClose} disabled={busy} className={DIALOG_CANCEL}>
            Cancel
          </Button>
          <button type="button" onClick={onRemove} aria-disabled={busy || undefined} className={DIALOG_BAD}>
            {busy ? 'Removing…' : 'Remove'}
          </button>
        </div>
      }
    >
      <p className={DIALOG_BODY}>
        {last
          ? 'Signing in will no longer ask for a passkey, and your recovery codes will stop working.'
          : `${name} won't sign you in any more.`}
      </p>
    </Modal>
  )
}

/**
 * Confirm it's you: the owner proves it before passkeys or codes change long after signing in. A
 * passkey when there is one, else the password; a recovery code as the way out. A Google-only login
 * with no passkey signs in again instead (it just did, so the change then goes through).
 */
function ConfirmItsYouDialog({
  kinds,
  onProof,
  onClose,
}: {
  kinds: ProofKinds
  onProof: (proof: Proof) => Promise<void>
  onClose: () => void
}) {
  const { logout } = useAuth()
  const formId = useId()
  const [mode, setMode] = useState<'passkey' | 'password' | 'code'>(kinds.passkey ? 'passkey' : 'password')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const none = !kinds.password && !kinds.passkey

  function switchTo(next: 'passkey' | 'password' | 'code') {
    setMode(next)
    setValue('')
    setError(null)
  }

  async function attempt(proof: () => Promise<Proof>) {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      await onProof(await proof())
    } catch (err) {
      setError(passkeyError(err, "That didn't work. Try again."))
      setBusy(false)
    }
  }

  async function passkeyProof(): Promise<Proof> {
    const { data } = await api.post<{ ceremony: string; options: string }>('/auth/passkeys/proof-options')
    return { ceremony: data.ceremony, credential: await getPasskey(data.options) }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void attempt(async () => (mode === 'code' ? { recoveryCode: value } : { password: value }))
  }

  const close = () => {
    if (!busy) onClose()
  }

  if (none) {
    return (
      <Modal
        sheet
        title="Sign in again"
        onClose={close}
        footer={
          <div className={DIALOG_ACTIONS}>
            <Button variant="ghost" onClick={close} className={DIALOG_CANCEL}>
              Cancel
            </Button>
            <Button onClick={() => logout()} className={DIALOG_PRIMARY}>
              Sign in again
            </Button>
          </div>
        }
      >
        <p className={DIALOG_BODY}>To change passkeys, sign in again first.</p>
      </Modal>
    )
  }

  const typed = mode !== 'passkey'
  return (
    <Modal
      sheet
      title="Confirm it's you"
      onClose={close}
      footer={
        <div className={DIALOG_ACTIONS}>
          <Button variant="ghost" onClick={close} disabled={busy} className={DIALOG_CANCEL}>
            Cancel
          </Button>
          {typed ? (
            <Button type="submit" form={formId} aria-disabled={busy || undefined} className={DIALOG_PRIMARY}>
              {busy ? 'Checking…' : 'Continue'}
            </Button>
          ) : (
            <Button onClick={() => void attempt(passkeyProof)} aria-disabled={busy || undefined} className={`${DIALOG_PRIMARY} gap-2`}>
              <KeyRound aria-hidden strokeWidth={1.8} className="size-4" />
              {busy ? 'Waiting…' : 'Use passkey'}
            </Button>
          )}
        </div>
      }
    >
      {typed ? (
        <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="auth-f">
            <label htmlFor={`${formId}-value`} className="auth-label">
              {mode === 'code' ? 'Recovery code' : 'Password'}
            </label>
            <Input
              id={`${formId}-value`}
              type={mode === 'code' ? 'text' : 'password'}
              required
              autoFocus
              autoComplete={mode === 'code' ? 'one-time-code' : 'current-password'}
              autoCapitalize="none"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="auth-in"
            />
          </div>
        </form>
      ) : (
        <p className={DIALOG_BODY}>Use one of your passkeys to continue.</p>
      )}
      {error && (
        <p role="alert" className="auth-error mt-4">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1">
        {kinds.passkey && mode !== 'passkey' && (
          <button type="button" className="auth-link" onClick={() => switchTo('passkey')}>
            Use a passkey
          </button>
        )}
        {kinds.password && mode !== 'password' && (
          <button type="button" className="auth-link" onClick={() => switchTo('password')}>
            Use your password
          </button>
        )}
        {kinds.recoveryCode && mode !== 'code' && (
          <button type="button" className="auth-link" onClick={() => switchTo('code')}>
            Use a recovery code
          </button>
        )}
      </div>
    </Modal>
  )
}

/** The recovery codes, shown once: copy or download them, then Done. */
export function RecoveryCodesDialog({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const text = codes.join('\n')

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([`AllotJar recovery codes\n\n${text}\n`], { type: 'text/plain' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'allotjar-recovery-codes.txt'
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }

  return (
    <Modal
      sheet
      title="Save your recovery codes"
      onClose={onClose}
      footer={
        <div className={DIALOG_ACTIONS}>
          <Button onClick={onClose} className={DIALOG_PRIMARY}>
            Done
          </Button>
        </div>
      }
    >
      <p className={DIALOG_BODY}>Each signs you in once if you lose your passkey. They won't be shown again.</p>
      <ul
        aria-label="Recovery codes"
        className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 rounded-xl bg-[var(--dlg-field)] px-4 py-3.5 font-mono text-[15px] tracking-wide text-slate-900 shadow-[inset_0_0_0_1px_var(--color-line)]"
      >
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={() => void copy()} className={OUTLINE_SM}>
          {copied ? <Check aria-hidden strokeWidth={2} className="size-3.5" /> : <Copy aria-hidden strokeWidth={1.8} className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={download} className={OUTLINE_SM}>
          <Download aria-hidden strokeWidth={1.8} className="size-3.5" />
          Download
        </button>
      </div>
    </Modal>
  )
}

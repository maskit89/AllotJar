import { useEffect, useState } from 'react'
import { LogOut, Monitor, Smartphone, Tablet } from 'lucide-react'
import { Modal } from '../Modal'
import { Button } from '../ui'
import { InfoHint } from '../InfoHint'
import { CARD_TITLE, DASH_CARD } from '../budget/card'
import { useAuth } from '../../auth/AuthContext'
import { api } from '../../lib/api'
import { lastActive } from '../../lib/lastActive'
import { DIALOG_ACTIONS, DIALOG_BAD, DIALOG_BODY, DIALOG_CANCEL, OUTLINE_SM, ROW, ROW_HINT, ROW_TITLE, Tile } from './parts'

/** One sign-in still in force, as GET /auth/sessions answers it. */
export interface SignedInDevice {
  id: string
  /** "Safari on iPhone"; null when the server could not tell. */
  device: string | null
  startedUtc: string
  lastActiveUtc: string
  /** The sign-in this browser holds. */
  current: boolean
}

const STEEL = 'var(--color-steel)'
function DeviceIcon({ name }: { name: string | null }) {
  if (name?.endsWith('iPad')) return <Tablet strokeWidth={1.8} />
  if (name?.endsWith('iPhone') || name?.endsWith('Android')) return <Smartphone strokeWidth={1.8} />
  return <Monitor strokeWidth={1.8} />
}

/**
 * Account settings' Devices card: every device the login is signed in on (this one first), each
 * other one with its own Sign out, and Sign out everywhere, which asks first and ends this device's
 * sign-in too. How long a sign-in lasts sits behind the (i).
 */
export function DevicesCard() {
  const { signOutEverywhere } = useAuth()
  const [devices, setDevices] = useState<SignedInDevice[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [ending, setEnding] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const [allBusy, setAllBusy] = useState(false)
  const [allError, setAllError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api
      .get<SignedInDevice[]>('/auth/sessions')
      .then(({ data }) => {
        if (!live) return
        if (Array.isArray(data)) setDevices(data)
        else setLoadFailed(true)
      })
      .catch(() => live && setLoadFailed(true))
    return () => {
      live = false
    }
  }, [])

  async function endSession(device: SignedInDevice) {
    if (ending) return
    setError(null)
    setEnding(device.id)
    try {
      await api.delete(`/auth/sessions/${device.id}`)
      setDevices((list) => list?.filter((d) => d.id !== device.id) ?? null)
    } catch (err) {
      // Already gone (it signed out, or its sign-in ran out): the list just catches up.
      if ((err as { response?: { status?: number } }).response?.status === 404) {
        setDevices((list) => list?.filter((d) => d.id !== device.id) ?? null)
      } else {
        setError('Could not sign that device out. Please try again.')
      }
    } finally {
      setEnding(null)
    }
  }

  async function onSignOutEverywhere() {
    if (allBusy) return
    setAllError(null)
    setAllBusy(true)
    try {
      await signOutEverywhere()
      // On success the app leaves for the sign-in page (full navigation).
    } catch {
      setAllError('Could not sign you out everywhere. Please try again.')
      setAllBusy(false)
    }
  }

  return (
    <section aria-labelledby="as-devices" className={DASH_CARD}>
      <h2 id="as-devices" className={`mb-3.5 flex min-h-8 items-center gap-1 ${CARD_TITLE}`}>
        Devices
        <InfoHint label="About devices" buttonClassName={ROW_HINT} align="end" fixed>
          Each device stays signed in while you use it. It signs out after 30 days unused, and you sign in again every
          90 days.
        </InfoHint>
      </h2>
      <ul className="flex flex-col" aria-busy={devices === null && !loadFailed ? true : undefined}>
        {devices?.map((d) => {
          const name = d.device ?? 'Unknown device'
          return (
            <li key={d.id} className={`${ROW} flex-wrap`}>
              <Tile color={STEEL}>
                <DeviceIcon name={d.device} />
              </Tile>
              <div className="flex min-w-0 flex-[1_1_auto] flex-col gap-0.5">
                <h3 className={ROW_TITLE}>{name}</h3>
                <p className="text-[13px] leading-[1.45] text-slate-500">{d.current ? 'This device' : lastActive(d.lastActiveUtc)}</p>
              </div>
              {!d.current && (
                <button
                  type="button"
                  onClick={() => void endSession(d)}
                  aria-disabled={ending === d.id || undefined}
                  aria-label={`Sign out ${name}`}
                  className={`${OUTLINE_SM} ml-auto aria-disabled:pointer-events-none aria-disabled:opacity-50`}
                >
                  {ending === d.id ? 'Signing out…' : 'Sign out'}
                </button>
              )}
            </li>
          )
        })}
        <li className={ROW}>
          <Tile color="var(--color-bad)" tint="10%">
            <LogOut strokeWidth={1.8} />
          </Tile>
          <h3 className={`${ROW_TITLE} min-w-0 flex-1`}>Sign out everywhere</h3>
          <button type="button" onClick={() => setConfirmAll(true)} aria-label="Sign out everywhere" className={`${OUTLINE_SM} ml-auto text-bad!`}>
            Sign out
          </button>
        </li>
      </ul>
      {loadFailed && <p className="mt-2 text-[13px] text-slate-500">Could not load your devices.</p>}
      {error && (
        <p role="alert" className="auth-error mt-2">
          {error}
        </p>
      )}

      {confirmAll && (
        <Modal
          sheet
          title="Sign out everywhere?"
          onClose={() => {
            if (!allBusy) setConfirmAll(false)
          }}
          footer={
            <div className={DIALOG_ACTIONS}>
              <Button variant="ghost" onClick={() => setConfirmAll(false)} disabled={allBusy} className={DIALOG_CANCEL}>
                Cancel
              </Button>
              <button
                type="button"
                onClick={() => void onSignOutEverywhere()}
                aria-disabled={allBusy || undefined}
                className={DIALOG_BAD}
              >
                {allBusy ? 'Signing out…' : 'Sign out everywhere'}
              </button>
            </div>
          }
        >
          <p className={DIALOG_BODY}>Every device, this one included, will need to sign in again.</p>
          {allError && (
            <p role="alert" className="auth-error mt-4">
              {allError}
            </p>
          )}
        </Modal>
      )}
    </section>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, ErrorBanner, Input, Select } from './ui'
import { Modal } from './Modal'
import { api } from '../lib/api'
import type { JarAccountLedgerDto, JarDto } from '../types'
import { formatMoney, fromAmount, parseMinor, toAmount } from '../lib/money'
import { selectOnFocusProps } from '../lib/selectOnFocus'
import { todayIso } from '../lib/dates'
import { serverErrors } from '../lib/serverErrors'

/** The select value standing for the account's unallocated funds (a null jar id on the wire). */
export const UNALLOCATED = 'unallocated'

export interface MoveMoneyModalProps {
  /** The jar the move starts from (preselected as the source). */
  jar: JarDto
  currency: string
  onClose: () => void
  /** Called with the account's refreshed ledger after POST /jars/reallocations succeeds. */
  onMoved: (ledger: JarAccountLedgerDto) => void
}

/**
 * Moves money between one account's jars and/or its unallocated funds (rule 6): the
 * account balance never changes, the source can't go negative (rule 68) and positive jars
 * must stay backed by the account's money (rule 70) — the server validates all three and
 * its messages are shown verbatim. Loads GET /jars/ledger?accountId= for the live figures.
 */
export function MoveMoneyModal({ jar, currency, onClose, onMoved }: MoveMoneyModalProps) {
  const [ledger, setLedger] = useState<JarAccountLedgerDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [source, setSource] = useState<string>(jar.id)
  const [destination, setDestination] = useState<string>(UNALLOCATED)
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayIso)
  const [note, setNote] = useState('')

  // Loading starts true and the modal mounts fresh per jar, so the effect only needs to
  // clear it once the ledger lands.
  useEffect(() => {
    let cancelled = false
    api
      .get<JarAccountLedgerDto[]>(`/jars/ledger?accountId=${jar.fundingAccountId}`)
      .then(({ data }) => {
        if (cancelled) return
        const first = Array.isArray(data) ? data[0] ?? null : null
        setLedger(first)
        if (!first) setError('Could not load the account’s jars.')
      })
      .catch(() => !cancelled && setError('Could not load the account’s jars.'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [jar.fundingAccountId])

  // Every place money can sit in this account: each active jar, plus unallocated funds.
  const options = useMemo(() => {
    const jars = (ledger?.jars ?? []).filter((j) => !j.isArchived)
    return [
      ...jars.map((j) => ({ value: j.jarId, label: j.name, balance: j.balance as number | null })),
      { value: UNALLOCATED, label: 'Unallocated funds', balance: ledger?.unallocated ?? null },
    ]
  }, [ledger])

  const labelFor = (value: string) => options.find((o) => o.value === value)?.label ?? value

  const submit = useCallback(async () => {
    if (!ledger) return
    if (source === destination) {
      setError('Choose two different places — money can’t move from a jar to itself.')
      return
    }
    const minor = parseMinor(amount)
    if (minor === null || minor <= 0) {
      setError('Enter the amount to move.')
      return
    }
    if (!date) {
      setError('Enter the date of the move.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const { data } = await api.post<JarAccountLedgerDto>('/jars/reallocations', {
        accountId: ledger.accountId,
        sourceJarId: source === UNALLOCATED ? null : source,
        destinationJarId: destination === UNALLOCATED ? null : destination,
        amount: toAmount(minor),
        date,
        note: note.trim() === '' ? null : note.trim(),
      })
      onMoved(data)
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not move that money.')
    } finally {
      setSaving(false)
    }
  }, [ledger, source, destination, amount, date, note, onMoved])

  const today = todayIso()

  return (
    <Modal title={`Move money — ${jar.name}`} onClose={onClose} size="lg">
      {error && (
        <div className="mb-3">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}
      {loading && <p className="text-sm text-slate-500">Loading…</p>}
      {ledger && (
        <div className="space-y-3">
          {/* The account's money as it stands: each jar and what's unallocated — the
              balances the move is validated against. */}
          <div className="rounded-lg bg-slate-100 px-3 py-2 text-[12.5px] text-slate-600">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold text-slate-900">{ledger.accountName}</span>
              <span className="tabular-nums">
                {ledger.accountBalance === null ? 'Balance not available' : `Balance ${formatMoney(fromAmount(ledger.accountBalance), currency)}`}
              </span>
            </div>
            <ul className="mt-1.5 grid gap-x-4 gap-y-0.5 sm:grid-cols-2" aria-label={`Money held in ${ledger.accountName}`}>
              {options.map((o) => (
                <li key={o.value} className="flex justify-between gap-2 tabular-nums">
                  <span>{o.label}</span>
                  <span className={o.balance !== null && o.balance < 0 ? 'font-semibold text-rose-600 dark:text-rose-400' : 'font-semibold text-slate-900'}>
                    {o.balance === null ? 'Not available' : formatMoney(fromAmount(o.balance), currency)}
                  </span>
                </li>
              ))}
            </ul>
            {ledger.hasBackingDeficit && (
              <p className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone="rose">Jars exceed account money</Badge>
                <span>Move money out of a jar until every positive jar is backed by the account.</span>
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              From
              <Select value={source} aria-label="Move from" onChange={(e) => setSource(e.target.value)} className="w-full">
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              To
              <Select value={destination} aria-label="Move to" onChange={(e) => setDestination(e.target.value)} className="w-full">
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Amount
              <Input
                type="text"
                inputMode="decimal"
                {...selectOnFocusProps}
                value={amount}
                placeholder="0.00"
                aria-label="Move amount"
                onChange={(e) => setAmount(e.target.value)}
                className="w-full text-right tabular-nums"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Date
              <Input type="date" value={date} max={today} aria-label="Move date" onChange={(e) => setDate(e.target.value)} className="w-full" />
            </label>
            <label className="col-span-2 flex flex-col gap-1 text-xs font-medium text-slate-500">
              Note (optional)
              <Input type="text" value={note} aria-label="Move note" onChange={(e) => setNote(e.target.value)} className="w-full" />
            </label>
          </div>
          <p className="text-[11px] text-slate-500">
            Moves money from {labelFor(source)} to {labelFor(destination)} inside {ledger.accountName}. The account balance doesn&rsquo;t change.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose} aria-label="Cancel move">
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving} aria-label="Confirm move">
              Move money
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, ErrorBanner, Input, Select } from './ui'
import { Modal } from './Modal'
import { api } from '../lib/api'
import { readLedgers } from '../lib/jarLedgers'
import type { AccountDto, CreateTransferRequest, JarAccountLedgerDto, JarDto, TransactionDto } from '../types'
import { formatMoney, fromAmount, parseMinor, toAmount, tooPrecise, TOO_MANY_DECIMALS } from '../lib/money'
import { selectOnFocusProps } from '../lib/selectOnFocus'
import { todayIso } from '../lib/dates'
import { serverErrors } from '../lib/serverErrors'

/**
 * The select value standing for an account's unallocated funds (a null jar id on the wire):
 * `unallocated:{accountId}`. Jar ids are unique across accounts so a jar's value is its id.
 */
const UNALLOCATED_PREFIX = 'unallocated:'

/** One place money can sit: a jar, or an account's unallocated funds. */
interface Place {
  value: string
  label: string
  accountId: string
  accountName: string
  currency: string
  /** Null for the account's unallocated funds. */
  jarId: string | null
  /** Major units; null when the account's balance is unavailable. */
  balance: number | null
}

export interface MoveMoneyModalProps {
  /** The jar the move starts from (preselected as the source), or goes to with `fromPage`. */
  jar: JarDto
  /**
   * Opened from the Jars page's own Move money button rather than from a jar: the title names no
   * jar, and the move starts from the account's unallocated money into `jar` (both can be changed).
   */
  fromPage?: boolean
  currency: string
  /** Every account, so money can also be moved to one that backs no jars (as its unallocated funds). */
  accounts?: AccountDto[]
  onClose: () => void
  /** Called after the move was recorded; the caller re-reads the jars and ledgers. */
  onMoved: () => void
}

/**
 * Moves money out of (or into) a jar.
 *
 * Inside one account (rule 6) it is a reallocation: the account balance never changes, the
 * source can't go negative (rule 68) and positive jars must stay backed by the account's money
 * (rule 70) — POST /jars/reallocations validates all three and its messages are shown verbatim.
 *
 * Between two accounts (rule 80) money only moves by a bank transfer the user has made, so it
 * is recorded as a CONFIRMED transfer (rules 7, 68, 71): the user ticks that they made it, gives
 * the departure date and, unless the money is still in transit, the receipt date. The source
 * jar gives at most what it holds and the source account never goes below zero (rule 74);
 * POST /transactions/transfer validates that and its messages are shown verbatim.
 */
export function MoveMoneyModal({ jar, fromPage = false, currency, accounts = [], onClose, onMoved }: MoveMoneyModalProps) {
  const [ledgers, setLedgers] = useState<JarAccountLedgerDto[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const unallocatedHere = `${UNALLOCATED_PREFIX}${jar.fundingAccountId}`
  const [source, setSource] = useState<string>(fromPage ? unallocatedHere : jar.id)
  const [destination, setDestination] = useState<string>(fromPage ? jar.id : unallocatedHere)
  const [amount, setAmount] = useState('')
  // The move date inside one account; the departure date of a transfer between two.
  const [date, setDate] = useState(todayIso)
  // Cross-account only: when the destination bank posted it. Cleared = still in transit.
  const [receivedOn, setReceivedOn] = useState(todayIso)
  const [confirmed, setConfirmed] = useState(false)
  const [note, setNote] = useState('')

  // Every jar-backed account's ledger, so the destination can be a jar in another account.
  // Loading starts true and the modal mounts fresh per jar, so the effect only needs to
  // clear it once the ledgers land.
  useEffect(() => {
    let cancelled = false
    api
      .get<JarAccountLedgerDto[]>('/jars/ledger')
      .then(({ data }) => {
        if (cancelled) return
        const list = readLedgers(data)
        setLedgers(list)
        if (!list.some((l) => l.accountId === jar.fundingAccountId)) setError('Could not load the account’s jars.')
      })
      .catch(() => !cancelled && setError('Could not load the account’s jars.'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [jar.fundingAccountId])

  const ledger = useMemo(() => ledgers?.find((l) => l.accountId === jar.fundingAccountId) ?? null, [ledgers, jar.fundingAccountId])

  // Every place money can sit, grouped by account: each jar-backed account's active jars plus
  // its unallocated funds, then any other account as unallocated funds only.
  const groups = useMemo(() => {
    // Rules 63/85: a jar's money stays in the budget currency, so money moves only between
    // accounts kept in it. The jar's own account is always listed (it is the source). The
    // server refuses the rest anyway; leaving them out spares a refused save.
    const inBudgetCurrency = (accountId: string, accountCurrency: string) =>
      accountId === jar.fundingAccountId || !accountCurrency || accountCurrency === currency
    const result: { accountId: string; accountName: string; places: Place[] }[] = []
    for (const l of ledgers ?? []) {
      if (!inBudgetCurrency(l.accountId, l.currency)) continue
      const places: Place[] = l.jars
        .filter((j) => !j.isArchived)
        .map((j) => ({
          value: j.jarId,
          label: j.name,
          accountId: l.accountId,
          accountName: l.accountName,
          currency: l.currency || currency,
          jarId: j.jarId,
          balance: j.balance,
        }))
      places.push({
        value: `${UNALLOCATED_PREFIX}${l.accountId}`,
        label: 'Unallocated funds',
        accountId: l.accountId,
        accountName: l.accountName,
        currency: l.currency || currency,
        jarId: null,
        balance: l.unallocated,
      })
      result.push({ accountId: l.accountId, accountName: l.accountName, places })
    }
    for (const a of accounts) {
      if (result.some((g) => g.accountId === a.id) || !inBudgetCurrency(a.id, a.currency)) continue
      result.push({
        accountId: a.id,
        accountName: a.name,
        places: [
          {
            value: `${UNALLOCATED_PREFIX}${a.id}`,
            label: 'Unallocated funds',
            accountId: a.id,
            accountName: a.name,
            currency: a.currency || currency,
            jarId: null,
            balance: a.currentBalance,
          },
        ],
      })
    }
    return result
  }, [ledgers, accounts, currency, jar.fundingAccountId])

  const placeByValue = useMemo(() => new Map(groups.flatMap((g) => g.places).map((p) => [p.value, p])), [groups])
  // The source stays inside the jar's own account.
  const sourcePlaces = useMemo(() => groups.find((g) => g.accountId === jar.fundingAccountId)?.places ?? [], [groups, jar.fundingAccountId])

  const sourcePlace = placeByValue.get(source) ?? null
  const destinationPlace = placeByValue.get(destination) ?? null
  const crossAccount = !!destinationPlace && destinationPlace.accountId !== jar.fundingAccountId
  const destinationLedger = crossAccount ? ledgers?.find((l) => l.accountId === destinationPlace.accountId) ?? null : null

  const labelFor = (place: Place | null, value: string) => place?.label ?? value
  const defaultPayee = `Move money: ${labelFor(sourcePlace, source)} → ${labelFor(destinationPlace, destination)}`
  const receiverName = destinationPlace
    ? destinationPlace.jarId
      ? destinationPlace.label
      : `the unallocated money in ${destinationPlace.accountName}`
    : 'the destination'

  async function submit() {
    if (!ledger || !sourcePlace || !destinationPlace) return
    if (source === destination) {
      setError('Choose two different places — money can’t move from a jar to itself.')
      return
    }
    const minor = parseMinor(amount)
    if (minor === null || minor <= 0) {
      setError('Enter the amount to move.')
      return
    }
    if (tooPrecise(amount)) {
      setError(TOO_MANY_DECIMALS)
      return
    }
    if (!date) {
      setError(crossAccount ? 'Enter the date the money left the account.' : 'Enter the date of the move.')
      return
    }
    if (crossAccount && !confirmed) {
      setError('Tick “I have made this transfer” to record it.')
      return
    }
    if (crossAccount && receivedOn && receivedOn < date) {
      setError('The receipt date can’t be before the departure date.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (!crossAccount) {
        await api.post<JarAccountLedgerDto>('/jars/reallocations', {
          accountId: ledger.accountId,
          sourceJarId: sourcePlace.jarId,
          destinationJarId: destinationPlace.jarId,
          amount: toAmount(minor),
          date,
          note: note.trim() === '' ? null : note.trim(),
        })
      } else {
        const body: CreateTransferRequest = {
          departedOn: date,
          receivedOn: receivedOn || null,
          amount: toAmount(minor),
          fromAccountId: sourcePlace.accountId,
          toAccountId: destinationPlace.accountId,
          payee: note.trim() === '' ? defaultPayee : note.trim(),
          fromJarId: sourcePlace.jarId,
          ...(destinationPlace.jarId ? { jarAllocations: [{ jarId: destinationPlace.jarId, amount: toAmount(minor) }] } : {}),
        }
        await api.post<TransactionDto>('/transactions/transfer', body)
      }
      onMoved()
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not move that money.')
    } finally {
      setSaving(false)
    }
  }

  const today = todayIso()

  // The money of one account as it stands: each jar and what's unallocated — the balances
  // the move is validated against.
  const accountMoney = (l: JarAccountLedgerDto) => {
    const places = groups.find((g) => g.accountId === l.accountId)?.places ?? []
    return (
      <div className="rounded-lg bg-slate-100 px-3 py-2 text-[12.5px] text-slate-600">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-semibold text-slate-900">{l.accountName}</span>
          <span className="tabular-nums">
            {l.accountBalance === null ? 'Balance not available' : `Balance ${formatMoney(fromAmount(l.accountBalance), l.currency || currency)}`}
          </span>
        </div>
        <ul className="mt-1.5 grid gap-x-4 gap-y-0.5 sm:grid-cols-2" aria-label={`Money held in ${l.accountName}`}>
          {places.map((o) => (
            <li key={o.value} className="flex justify-between gap-2 tabular-nums">
              <span>{o.label}</span>
              <span className={o.balance !== null && o.balance < 0 ? 'font-semibold text-rose-600 dark:text-rose-400' : 'font-semibold text-slate-900'}>
                {o.balance === null ? 'Not available' : formatMoney(fromAmount(o.balance), o.currency)}
              </span>
            </li>
          ))}
        </ul>
        {l.hasBackingDeficit && (
          <p className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone="bad">Jars exceed account money</Badge>
            <span>Move money out of a jar until every positive jar is backed by the account.</span>
          </p>
        )}
      </div>
    )
  }

  return (
    <Modal title={fromPage ? 'Move money' : `Move money — ${jar.name}`} onClose={onClose} size="lg">
      {error && (
        <div className="mb-3">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}
      {loading && <p className="text-sm text-slate-500">Loading…</p>}
      {ledger && (
        <div className="space-y-3">
          {accountMoney(ledger)}
          {destinationLedger && accountMoney(destinationLedger)}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              From
              <Select value={source} aria-label="Move from" onChange={(e) => setSource(e.target.value)} className="w-full">
                {sourcePlaces.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              To
              <Select value={destination} aria-label="Move to" onChange={(e) => setDestination(e.target.value)} className="w-full">
                {groups.map((g) => (
                  <optgroup key={g.accountId} label={g.accountName}>
                    {g.places.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
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
            {crossAccount ? (
              <>
                <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                  Departure date
                  <Input type="date" value={date} max={today} aria-label="Departure date" onChange={(e) => setDate(e.target.value)} className="w-full" />
                </label>
                <div className="col-span-2 flex flex-col gap-1 text-xs font-medium text-slate-500">
                  <label htmlFor="move-received-on">Receipt date</label>
                  <Input
                    id="move-received-on"
                    type="date"
                    value={receivedOn}
                    min={date || undefined}
                    max={today}
                    aria-describedby="move-received-on-hint"
                    onChange={(e) => setReceivedOn(e.target.value)}
                    className="w-full"
                  />
                  <span id="move-received-on-hint" className="font-normal text-slate-500">
                    Clear it if the money hasn&rsquo;t arrived yet — {receiverName} receives it once you confirm the receipt on the Transactions page.
                  </span>
                </div>
              </>
            ) : (
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                Date
                <Input type="date" value={date} max={today} aria-label="Move date" onChange={(e) => setDate(e.target.value)} className="w-full" />
              </label>
            )}
            <label className="col-span-2 flex flex-col gap-1 text-xs font-medium text-slate-500">
              {crossAccount ? 'Note (optional, recorded as the transfer’s payee)' : 'Note (optional)'}
              <Input
                type="text"
                value={note}
                aria-label="Move note"
                placeholder={crossAccount ? defaultPayee : undefined}
                onChange={(e) => setNote(e.target.value)}
                className="w-full"
              />
            </label>
          </div>
          {crossAccount && destinationPlace ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              <p>
                This moves money between {ledger.accountName} and {destinationPlace.accountName}, so it is recorded as a bank
                transfer you have made.
              </p>
              <label className="mt-2 flex items-center gap-2 font-medium">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-400 text-brand-600 focus:ring-2 focus:ring-brand-500/40"
                />
                I have made this transfer
              </label>
            </div>
          ) : (
            <p className="text-[11px] text-slate-500">
              Moves money from {labelFor(sourcePlace, source)} to {labelFor(destinationPlace, destination)} inside {ledger.accountName}. The
              account balance doesn&rsquo;t change.
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose} aria-label="Cancel move">
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving}>
              {crossAccount ? 'Record transfer' : 'Move money'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { Badge, Button, Card, EmptyState, ErrorBanner, Input, Select } from '../components/ui'
import { Hero } from '../components/Hero'
import { Modal } from '../components/Modal'
import { AccountsIcon } from '../components/icons'
import { useAuth } from '../auth/AuthContext'
import { useFeatures } from '../features/FeatureContext'
import { useHousehold } from '../features/HouseholdContext'
import { HolderPicker, PrivateCheckbox } from '../components/AccountHolders'
import { holderNames } from '../lib/accountHolders'
import { api } from '../lib/api'
import { EVENTS, track } from '../analytics'
import type { AccountDto, AccountReconciliationDto, UnreachableAccountDto } from '../types'
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_OPTIONS, AccountType } from '../types'
import { formatMoney, fromAmount, parseMinor, toAmount, toEditString, tooPrecise, TOO_MANY_DECIMALS } from '../lib/money'
import { formatDate, todayIso } from '../lib/dates'
import { selectOnFocusProps } from '../lib/selectOnFocus'
import { editConflict, serverErrors } from '../lib/serverErrors'
import { hueColor, hueForAccountType, hueTint } from '../lib/categoryColors'

// Current / Savings / Cash / Other — credit cards are not accounts (rule 75). An account
// recorded as one before the change still labels via ACCOUNT_TYPE_LABELS, so keep it as an
// extra option only while editing that row (never offered for a new account).
const TYPE_OPTIONS = ACCOUNT_TYPE_OPTIONS

function typeOptionsFor(type: number) {
  return TYPE_OPTIONS.some((o) => o.value === type)
    ? TYPE_OPTIONS
    : [...TYPE_OPTIONS, { value: type, label: ACCOUNT_TYPE_LABELS[type] ?? 'Other' }]
}

/**
 * Parse a non-negative amount string into a wire decimal; '' → 0; null when invalid. No
 * account may open below zero (rule 74), so a leading minus is invalid here; should one
 * reach the server anyway, its 400 message is shown as-is.
 */
function parseOpeningBalance(input: string): number | null {
  if (input.trim() === '') return 0
  const minor = parseMinor(input)
  return minor === null ? null : toAmount(minor)
}

/** The optional bank identifiers (rule 76): trimmed, empty → null on the wire. */
interface Identifiers {
  iban: string
  bic: string
  sortCode: string
  accountNumber: string
}

const BLANK_IDS: Identifiers = { iban: '', bic: '', sortCode: '', accountNumber: '' }

function identifiersFrom(a: AccountDto): Identifiers {
  return { iban: a.iban ?? '', bic: a.bic ?? '', sortCode: a.sortCode ?? '', accountNumber: a.accountNumber ?? '' }
}

function identifiersPayload(ids: Identifiers) {
  const clean = (v: string) => (v.trim() === '' ? null : v.trim())
  return { iban: clean(ids.iban), bic: clean(ids.bic), sortCode: clean(ids.sortCode), accountNumber: clean(ids.accountNumber) }
}

const ID_FIELDS: Array<{ key: keyof Identifiers; label: string; placeholder: string }> = [
  { key: 'iban', label: 'IBAN', placeholder: 'e.g. MT84 MALT 0110 0001 2345 MTLC AST0 01S' },
  { key: 'bic', label: 'BIC', placeholder: 'e.g. VALLMTMT' },
  { key: 'sortCode', label: 'Sort code', placeholder: 'e.g. 40-47-84' },
  { key: 'accountNumber', label: 'Account number', placeholder: 'e.g. 12345678' },
]

export function AccountsPage() {
  // Managing accounts needs Admin+ (canWrite); others get a read-only register.
  const { canWrite, canManageHousehold, budgetCurrency, memberId } = useAuth()
  const { multiCurrency } = useFeatures()
  // W13: the people who can hold an account (rule 30).
  const { members } = useHousehold()
  const [accounts, setAccounts] = useState<AccountDto[]>([])
  const [reconciliation, setReconciliation] = useState<AccountReconciliationDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  // P59: accounts private to a login no longer in the household. Only the owner sees them, by
  // name and entry count, and may erase one for good behind its typed name.
  const [unreachable, setUnreachable] = useState<UnreachableAccountDto[]>([])
  const [eraseId, setEraseId] = useState<string | null>(null)
  const [eraseName, setEraseName] = useState('')
  const [eraseError, setEraseError] = useState<string | null>(null)
  const [erasing, setErasing] = useState(false)

  // Add-account modal.
  const [showAdd, setShowAdd] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState<number>(AccountType.Current)
  const [opening, setOpening] = useState('')
  // The opening balance is the money held at the START of this date (rule 40); required.
  const [openingDate, setOpeningDate] = useState(todayIso)
  const [ids, setIds] = useState<Identifiers>(BLANK_IDS)
  const [holderIds, setHolderIds] = useState<string[]>([])
  // Rule 31: an account you add for yourself alone starts private unless you untick this.
  const [keepPrivate, setKeepPrivate] = useState(true)
  const [adding, setAdding] = useState(false)

  // Inline (in-card) edit.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [eName, setEName] = useState('')
  const [eType, setEType] = useState<number>(AccountType.Current)
  const [eOpening, setEOpening] = useState('')
  const [eOpeningDate, setEOpeningDate] = useState('')
  const [eIds, setEIds] = useState<Identifiers>(BLANK_IDS)
  const [eHolderIds, setEHolderIds] = useState<string[]>([])
  // The version the edit was loaded from, sent back with the save (D11).
  const [eVersion, setEVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .get<AccountDto[]>('/accounts')
      .then(({ data }) => !cancelled && setAccounts(data))
      .catch(() => !cancelled && setError('Could not load your accounts.'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!canManageHousehold) return
    let cancelled = false
    api
      .get<UnreachableAccountDto[]>('/accounts/unreachable')
      .then(({ data }) => !cancelled && setUnreachable(Array.isArray(data) ? data : []))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [canManageHousehold])

  const erase = useCallback(async (id: string, confirmName: string) => {
    setErasing(true)
    setEraseError(null)
    try {
      await api.post(`/accounts/${id}/erase`, { confirmName })
      setUnreachable((prev) => prev.filter((a) => a.id !== id))
      setEraseId(null)
      setEraseName('')
      // The erase can drop movements the shared accounts counted (a transfer that never
      // arrived), so the accounts are read again (the reconciliation follows the account set).
      const { data } = await api.get<AccountDto[]>('/accounts')
      setAccounts(data)
    } catch (err) {
      // A refused erase (the name doesn't match, a refund elsewhere names a purchase in it, a
      // shared account would go below zero without a transfer from it) carries the reason.
      setEraseError(serverErrors(err) ?? 'Could not erase that account.')
    } finally {
      setErasing(false)
    }
  }, [])

  // Reconciliation reflects current balances + fund backing, so refresh it whenever
  // the account set changes (initial load and after any add/edit/delete).
  useEffect(() => {
    let cancelled = false
    api
      .get<AccountReconciliationDto[]>('/accounts/reconciliation')
      .then(({ data }) => !cancelled && setReconciliation(Array.isArray(data) ? data : []))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [accounts])

  const ownPersonal = !!memberId && holderIds.length === 1 && holderIds[0] === memberId

  const addAccount = useCallback(async () => {
    if (name.trim() === '') {
      setError('Give the account a name.')
      return
    }
    const openingBalance = parseOpeningBalance(opening)
    if (openingBalance === null) {
      setError(opening.trim().startsWith('-') ? 'An opening balance can’t be negative.' : 'Enter a valid opening balance.')
      return
    }
    if (tooPrecise(opening)) {
      setError(TOO_MANY_DECIMALS)
      return
    }
    if (!openingDate) {
      setError('Enter the date the opening balance applies from.')
      return
    }
    setAdding(true)
    setError(null)
    try {
      const { data } = await api.post<AccountDto>('/accounts', {
        name: name.trim(),
        type,
        // One currency for the whole budget: every new account uses the budget currency.
        currency: budgetCurrency,
        openingBalance,
        openingDate,
        ...identifiersPayload(ids),
        holderIds,
        ...(ownPersonal ? { isPrivate: keepPrivate } : {}),
      })
      // A row with this id (a save answered twice) is replaced, never listed twice.
      setAccounts((prev) => (prev.some((a) => a.id === data.id) ? prev.map((a) => (a.id === data.id ? data : a)) : [...prev, data]))
      track(EVENTS.accountCreated, { kind: ACCOUNT_TYPE_LABELS[type] ?? 'unknown' })
      setName('')
      setOpening('')
      setOpeningDate(todayIso())
      setIds(BLANK_IDS)
      setHolderIds([])
      setKeepPrivate(true)
      setShowAdd(false)
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not add that account.')
    } finally {
      setAdding(false)
    }
  }, [name, type, opening, openingDate, budgetCurrency, ids, holderIds, keepPrivate, ownPersonal])

  const startEdit = useCallback((a: AccountDto) => {
    setEditingId(a.id)
    setEName(a.name)
    setEType(a.type)
    setEOpening(toEditString(fromAmount(a.openingBalance)))
    setEOpeningDate(a.openingDate ?? '')
    setEIds(identifiersFrom(a))
    setEHolderIds((a.holders ?? []).map((h) => h.memberId))
    setEVersion(a.version ?? null)
  }, [])

  const saveEdit = useCallback(
    async (id: string) => {
      if (eName.trim() === '') {
        setError('Give the account a name.')
        return
      }
      const openingBalance = parseOpeningBalance(eOpening)
      if (openingBalance === null) {
        setError(eOpening.trim().startsWith('-') ? 'An opening balance can’t be negative.' : 'Enter a valid opening balance.')
        return
      }
      // A typed amount is whole cents (D1); the saved one goes back as it is.
      const saved = accounts.find((a) => a.id === id)
      if (tooPrecise(eOpening, saved ? fromAmount(saved.openingBalance) : null)) {
        setError(TOO_MANY_DECIMALS)
        return
      }
      if (!eOpeningDate) {
        setError('Enter the date the opening balance applies from.')
        return
      }
      setSavingId(id)
      setError(null)
      try {
        const { data } = await api.put<AccountDto>(`/accounts/${id}`, {
          name: eName.trim(),
          type: eType,
          openingBalance,
          openingDate: eOpeningDate,
          ...identifiersPayload(eIds),
          // Sent only once the people are known, so an unloaded list never clears the holders.
          ...(members.length > 0 ? { holderIds: eHolderIds } : {}),
          version: eVersion,
        })
        setAccounts((prev) => prev.map((a) => (a.id === id ? data : a)))
        track(EVENTS.accountEdited)
        setEditingId(null)
      } catch (err) {
        const conflict = editConflict(err)
        if (conflict) {
          // Someone else saved this account first (D11): show what they saved in the open form.
          const fresh = await api.get<AccountDto[]>('/accounts').then(({ data }) => data, () => null)
          const row = Array.isArray(fresh) ? fresh.find((a) => a.id === id) : undefined
          if (Array.isArray(fresh)) setAccounts(fresh)
          if (row) startEdit(row)
          else setEditingId(null)
          setError(conflict)
        } else {
          setError(serverErrors(err) ?? 'Could not save that account.')
        }
      } finally {
        setSavingId(null)
      }
    },
    [eName, eType, eOpening, eOpeningDate, eIds, eHolderIds, eVersion, members.length, accounts, startEdit],
  )

  // Rules 31/33: the holder's own choice of who sees their personal account.
  const setSharing = useCallback(async (a: AccountDto, isPrivate: boolean) => {
    setSavingId(a.id)
    setError(null)
    try {
      const { data } = await api.put<AccountDto>(`/accounts/${a.id}/sharing`, { isPrivate })
      setAccounts((prev) => prev.map((x) => (x.id === a.id ? data : x)))
    } catch (err) {
      setError(serverErrors(err) ?? 'Could not change who sees that account.')
    } finally {
      setSavingId(null)
    }
  }, [])

  const remove = useCallback(async (id: string) => {
    setSavingId(id)
    setError(null)
    try {
      await api.delete(`/accounts/${id}`)
      setAccounts((prev) => prev.filter((a) => a.id !== id))
    } catch (err) {
      // A refused delete (the account is a side of a transfer) carries the reason.
      setError(serverErrors(err) ?? 'Could not delete that account.')
    } finally {
      setSavingId(null)
    }
  }, [])

  // The whole budget uses one currency and the app never converts, so the hero totals count only
  // accounts in the budget currency. An account in another currency (legacy data) is left out
  // and called out; per-account figures always use the account's own currency.
  const inBudgetCurrency = useMemo(
    () => accounts.filter((a) => a.currency === budgetCurrency),
    [accounts, budgetCurrency],
  )
  const otherCurrencyCount = accounts.length - inBudgetCurrency.length
  // Net balance across those accounts whose balance is available, plus the hero's split of what
  // you hold (positive balances) vs what you owe (negative ones). An unavailable balance (no
  // opening date, rule 67) is left out and called out, never counted as zero.
  const known = useMemo(() => inBudgetCurrency.filter((a) => a.currentBalance !== null), [inBudgetCurrency])
  const unavailableCount = inBudgetCurrency.length - known.length
  const netMinor = useMemo(
    () => known.reduce((sum, a) => sum + fromAmount(a.currentBalance ?? 0), 0),
    [known],
  )
  const availableMinor = useMemo(
    () => known.reduce((sum, a) => sum + Math.max(0, fromAmount(a.currentBalance ?? 0)), 0),
    [known],
  )
  const pendingReviewCount = useMemo(
    () => accounts.reduce((n, a) => n + (a.pendingReceiptCount ?? 0), 0),
    [accounts],
  )

  const currencyById = useMemo(
    () => Object.fromEntries(accounts.map((a) => [a.id, a.currency])) as Record<string, string>,
    [accounts],
  )

  return (
    <AppShell active="accounts" title="Accounts">
      <Hero
        eyebrow="Total balance"
        amount={formatMoney(netMinor, budgetCurrency)}
        amountLabel={`Total balance: ${formatMoney(netMinor, budgetCurrency)}`}
        // Rule 74: no account is ever below zero, so there is nothing "owed" to show; the one
        // tile is the money the counted accounts hold.
        tiles={[{ label: 'Available', value: formatMoney(availableMinor, budgetCurrency) }]}
        footnote={
          otherCurrencyCount > 0 || unavailableCount > 0 || pendingReviewCount > 0 ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              {otherCurrencyCount > 0 && (
                <span className="inline-flex items-center rounded-full bg-black/[0.18] px-[15px] py-2 text-[13px] font-medium">
                  {otherCurrencyCount} account{otherCurrencyCount === 1 ? '' : 's'} in another currency {otherCurrencyCount === 1 ? 'is' : 'are'} not counted.
                </span>
              )}
              {unavailableCount > 0 && (
                <span className="inline-flex items-center rounded-full bg-black/[0.18] px-[15px] py-2 text-[13px] font-medium">
                  {unavailableCount} account{unavailableCount === 1 ? '' : 's'} with no balance before {unavailableCount === 1 ? 'its' : 'their'} opening date {unavailableCount === 1 ? 'is' : 'are'} not counted.
                </span>
              )}
              {pendingReviewCount > 0 && (
                <span className="inline-flex items-center rounded-full bg-black/[0.18] px-[15px] py-2 text-[13px] font-medium">
                  {pendingReviewCount} transfer receipt{pendingReviewCount === 1 ? '' : 's'} pending review.
                </span>
              )}
            </span>
          ) : undefined
        }
      />

      {error && !showAdd && <ErrorBanner>{error}</ErrorBanner>}

      {showAdd && canWrite && (
        <Modal title="Add an account" onClose={() => setShowAdd(false)}>
          {error && (
            <div className="mb-3">
              <ErrorBanner>{error}</ErrorBanner>
            </div>
          )}
          <div className="space-y-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Name
              <Input
                type="text"
                value={name}
                placeholder="e.g. Everyday current"
                aria-label="Account name"
                onChange={(e) => setName(e.target.value)}
                className="w-full"
              />
            </label>
            <HolderPicker members={members} value={holderIds} onChange={setHolderIds} />
            {ownPersonal && <PrivateCheckbox checked={keepPrivate} onChange={setKeepPrivate} />}
            <p className="text-xs text-slate-500">
              The account holds {budgetCurrency}, your budget currency.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                Type
                <Select value={type} aria-label="Account type" onChange={(e) => setType(Number(e.target.value))} className="w-full">
                  {TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                Opening balance
                <Input
                  type="text"
                  inputMode="decimal"
                  {...selectOnFocusProps}
                  value={opening}
                  placeholder="0.00"
                  aria-label="Opening balance"
                  onChange={(e) => setOpening(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addAccount()
                  }}
                  className="w-full text-right tabular-nums"
                />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Opening date
              <Input
                type="date"
                value={openingDate}
                aria-label="Opening date"
                onChange={(e) => setOpeningDate(e.target.value)}
                className="w-full text-slate-700"
              />
              <span className="font-normal text-slate-400">
                The balance at the start of this day. Earlier transactions stay as history and don’t change it.
              </span>
            </label>
            <fieldset className="grid grid-cols-2 gap-3">
              <legend className="mb-1 text-xs font-medium text-slate-500">
                Bank details <span className="font-normal text-slate-400">(optional — a piggy bank has none)</span>
              </legend>
              {ID_FIELDS.map((f) => (
                <label key={f.key} className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                  {f.label}
                  <Input
                    type="text"
                    value={ids[f.key]}
                    placeholder={f.placeholder}
                    aria-label={f.label}
                    autoComplete="off"
                    onChange={(e) => setIds((prev) => ({ ...prev, [f.key]: e.target.value }))}
                    className="w-full"
                  />
                </label>
              ))}
            </fieldset>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setShowAdd(false)}>
                Cancel
              </Button>
              <Button onClick={addAccount} disabled={adding} aria-label="Add account">
                Add account
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {confirmDeleteId && canWrite && (() => {
        const acct = accounts.find((a) => a.id === confirmDeleteId)
        if (!acct) return null
        return (
          <Modal title={`Delete ${acct.name}?`} onClose={() => setConfirmDeleteId(null)}>
            <p className="text-sm text-slate-600">
              The account is removed, but its transactions are kept — they simply become
              unassigned from any account. An account that is a side of a transfer can’t be
              deleted until those transfers are removed. This can’t be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmDeleteId(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const id = confirmDeleteId
                  setConfirmDeleteId(null)
                  remove(id)
                }}
                disabled={savingId === confirmDeleteId}
                aria-label={`Confirm delete ${acct.name}`}
              >
                Delete account
              </Button>
            </div>
          </Modal>
        )
      })()}

      {eraseId && canManageHousehold && (() => {
        const acct = unreachable.find((a) => a.id === eraseId)
        if (!acct) return null
        const matches = eraseName.trim().toLowerCase() === acct.name.trim().toLowerCase()
        return (
          <Modal
            title={`Erase ${acct.name}?`}
            onClose={() => {
              setEraseId(null)
              setEraseName('')
              setEraseError(null)
            }}
          >
            <p className="text-sm text-slate-600">
              This account is private to a login that is no longer in the household, so nobody can
              see it, change it or share it. Erasing removes the account and what only its holder could
              see for good ({acct.entryCount === 1 ? 'one entry' : `${acct.entryCount} entries`} touch it).
              Anything the household already saw stays and keeps counting without the account: an entry
              on a budget line, a refund of a shared purchase, and a shared account’s side of a transfer
              with it, with its bank reference and fee. Nothing in it is shown to you. This can’t be undone.
            </p>
            <label htmlFor="erase-name" className="mt-4 block text-sm font-medium text-slate-600">
              Type <span className="font-semibold text-slate-800">{acct.name}</span> to confirm
            </label>
            <Input
              id="erase-name"
              type="text"
              value={eraseName}
              autoComplete="off"
              onChange={(e) => setEraseName(e.target.value)}
              className="mt-1 w-full"
            />
            {eraseError && <ErrorBanner className="mt-3">{eraseError}</ErrorBanner>}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setEraseId(null)
                  setEraseName('')
                  setEraseError(null)
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => erase(acct.id, eraseName)}
                disabled={!matches || erasing}
                aria-label={`Confirm erase ${acct.name}`}
              >
                {erasing ? 'Erasing…' : 'Erase for good'}
              </Button>
            </div>
          </Modal>
        )
      })()}

      {loading && <p className="text-slate-500">Loading…</p>}

      {!loading && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-base font-bold tracking-[-0.01em] text-slate-900">Your accounts</h2>
            {canWrite && (
              <Button
                onClick={() => {
                  setError(null)
                  setShowAdd(true)
                }}
                aria-label="Add account"
              >
                <span aria-hidden className="text-base leading-none">+</span> Add account
              </Button>
            )}
          </div>

          {accounts.length === 0 ? (
            <EmptyState
              icon={<AccountsIcon className="h-6 w-6" />}
              title="No accounts yet"
              description="Use + Add account, then tag transactions to it to track its balance."
            />
          ) : (
            <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
              {accounts.map((a) => {
                const balanceMinor = a.currentBalance === null ? null : fromAmount(a.currentBalance)
                const inTransitOut = fromAmount(a.inTransitOut ?? 0)
                const inTransitIn = fromAmount(a.inTransitIn ?? 0)
                const pendingReceipts = a.pendingReceiptCount ?? 0
                const hue = hueForAccountType(a.type)
                if (editingId === a.id) {
                  return (
                    <Card key={a.id} className="flex flex-col gap-3 p-5">
                      <Input type="text" value={eName} aria-label={`Name for ${a.name}`} onChange={(e) => setEName(e.target.value)} className="w-full" />
                      <Select value={eType} aria-label={`Type for ${a.name}`} onChange={(e) => setEType(Number(e.target.value))}>
                        {typeOptionsFor(a.type).map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                      <Input type="text" inputMode="decimal" {...selectOnFocusProps} value={eOpening} aria-label={`Opening balance for ${a.name}`} onChange={(e) => setEOpening(e.target.value)} className="w-full text-right tabular-nums" />
                      <Input type="date" value={eOpeningDate} aria-label={`Opening date for ${a.name}`} onChange={(e) => setEOpeningDate(e.target.value)} className="w-full text-slate-700" />
                      {ID_FIELDS.map((f) => (
                        <Input
                          key={f.key}
                          type="text"
                          value={eIds[f.key]}
                          placeholder={f.label}
                          aria-label={`${f.label} for ${a.name}`}
                          autoComplete="off"
                          onChange={(e) => setEIds((prev) => ({ ...prev, [f.key]: e.target.value }))}
                          className="w-full"
                        />
                      ))}
                      <HolderPicker members={members} value={eHolderIds} onChange={setEHolderIds} accountName={a.name} />
                      {(multiCurrency || a.currency !== budgetCurrency) && (
                        <p className="text-xs text-slate-500">
                          Currency <span className="font-semibold text-slate-700">{a.currency}</span> — fixed once created.
                        </p>
                      )}
                      <div className="flex justify-end gap-2">
                        <Button size="sm" onClick={() => saveEdit(a.id)} disabled={savingId === a.id} aria-label={`Save ${a.name}`}>
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingId(null)} aria-label="Cancel edit">
                          Cancel
                        </Button>
                      </div>
                    </Card>
                  )
                }
                return (
                  <Card key={a.id} className="group relative flex flex-col gap-3 p-5 transition hover:shadow-hero">
                    {/* Overlay link makes the whole card open the account detail. */}
                    <Link
                      to={`/accounts/${a.id}`}
                      aria-label={`View ${a.name}`}
                      className="absolute inset-0 rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                    />
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex h-12 w-12 items-center justify-center rounded-2xl" style={{ background: hueTint(hue) }} aria-hidden>
                        <span className="h-5 w-5 rounded-lg" style={{ background: hueColor(hue) }} />
                      </div>
                      <div className="flex items-center gap-1.5">
                        {(multiCurrency || a.currency !== budgetCurrency) && (
                          <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                            {a.currency}
                          </span>
                        )}
                        {a.isPrivate && <Badge tone="violet">Private</Badge>}
                        {(a.holders?.length ?? 0) > 1 && <Badge tone="brand">Joint</Badge>}
                        <span className="rounded-full border border-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-500">
                          {ACCOUNT_TYPE_LABELS[a.type] ?? 'Other'}
                        </span>
                      </div>
                    </div>
                    <div>
                      <div className="text-[14.5px] font-semibold text-slate-900">{a.name}</div>
                      {(a.holders?.length ?? 0) > 0 && (
                        <div className="text-xs text-slate-500">Held by {holderNames(a)}</div>
                      )}
                      {balanceMinor === null ? (
                        <div className="mt-0.5">
                          <div className="text-[19px] font-bold text-slate-500">Not available</div>
                          <div className="text-xs text-amber-700 dark:text-amber-400">
                            {a.openingDateMissing ? 'Set an opening date to calculate the balance.' : 'Before the opening date.'}
                          </div>
                        </div>
                      ) : (
                        <div className={`mt-0.5 text-[25px] font-bold tabular-nums ${balanceMinor < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900'}`}>
                          {formatMoney(balanceMinor, a.currency)}
                        </div>
                      )}
                      <div className="mt-1 text-xs text-slate-500">
                        Opening {formatMoney(fromAmount(a.openingBalance), a.currency)}
                        {a.openingDate ? ` on ${formatDate(a.openingDate)}` : ''}
                      </div>
                      {(inTransitOut > 0 || inTransitIn > 0 || pendingReceipts > 0) && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {inTransitOut > 0 && (
                            <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-700 dark:border-sky-400/30 dark:bg-sky-400/10 dark:text-sky-300">
                              {formatMoney(inTransitOut, a.currency)} in transit out
                            </span>
                          )}
                          {inTransitIn > 0 && (
                            <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-700 dark:border-sky-400/30 dark:bg-sky-400/10 dark:text-sky-300">
                              {formatMoney(inTransitIn, a.currency)} in transit in
                            </span>
                          )}
                          {pendingReceipts > 0 && (
                            <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300">
                              {pendingReceipts} receipt{pendingReceipts === 1 ? '' : 's'} pending review
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    {a.canChangeSharing && (
                      <div className="relative z-10 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        {a.isPrivate ? (
                          <>
                            <span>Only you can see this account.</span>
                            <Button size="sm" variant="ghost" onClick={() => setSharing(a, false)} disabled={savingId === a.id} aria-label={`Share ${a.name} with the household`}>
                              Share with household
                            </Button>
                          </>
                        ) : a.sharingBlockedReason ? (
                          <span title={a.sharingBlockedReason}>Visible to the household: a jar uses it.</span>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => setSharing(a, true)} disabled={savingId === a.id} aria-label={`Make ${a.name} private`}>
                            Make private
                          </Button>
                        )}
                      </div>
                    )}
                    {canWrite && (
                      <div className="absolute bottom-3 right-3 z-10 flex gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                        <button
                          type="button"
                          onClick={() => startEdit(a)}
                          aria-label={`Edit ${a.name}`}
                          title="Edit account"
                          className="rounded-md bg-surface/80 px-2 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(a.id)}
                          disabled={savingId === a.id}
                          aria-label={`Delete ${a.name}`}
                          title="Delete account"
                          className="rounded-md bg-surface/80 px-2 py-1 text-slate-500 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </Card>
                )
              })}
            </div>
          )}
        </section>
      )}

      {!loading && canManageHousehold && unreachable.length > 0 && (
        <Card className="overflow-hidden" data-testid="unreachable-accounts">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-slate-700">Private accounts nobody can reach</h2>
            <p className="text-xs text-slate-500">
              Each is private to a login that is no longer in the household. Nobody can see or change
              them. If that person won’t be back, you can erase one for good; you never see what is in it.
            </p>
          </div>
          <ul className="divide-y divide-slate-100">
            {unreachable.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <div>
                  <span className="font-medium text-slate-700">{a.name}</span>
                  <span className="ml-2 text-xs text-slate-500">
                    {a.holderName ? `${a.holderName} · ` : ''}
                    {a.entryCount === 1 ? '1 entry' : `${a.entryCount} entries`} · {a.currency}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    setEraseError(null)
                    setEraseName('')
                    setEraseId(a.id)
                  }}
                  aria-label={`Erase ${a.name}`}
                >
                  Erase…
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {reconciliation.some((r) => r.backedJarCount > 0) && (
        <Card className="overflow-hidden">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-slate-700">Jar reconciliation</h2>
            <p className="text-xs text-slate-500">
              Each account’s balance against the jars it holds — unallocated is the money not in any jar.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 text-right font-medium">Balance</th>
                  <th className="px-4 py-2 text-right font-medium">In jars</th>
                  <th className="px-4 py-2 text-right font-medium">Unallocated</th>
                  {/* An sr-only span is absolutely positioned and escapes the scroll box's clip
                      (it widened the document at phone width), so the accessible name goes on the
                      cell itself. */}
                  <th className="px-4 py-2 font-medium" aria-label="Backing" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {reconciliation
                  .filter((r) => r.backedJarCount > 0)
                  .map((r) => (
                    <tr key={r.accountId} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-medium text-slate-700">{r.accountName}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                        {r.currentBalance === null ? 'Not available' : formatMoney(fromAmount(r.currentBalance), currencyById[r.accountId] ?? budgetCurrency)}
                        {r.requiresReview && <span className="ml-1 text-xs text-amber-700 dark:text-amber-400">(pending review)</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{formatMoney(fromAmount(r.backedJarsTotal), currencyById[r.accountId] ?? budgetCurrency)}</td>
                      <td className={`px-4 py-2.5 text-right font-semibold tabular-nums ${r.float !== null && fromAmount(r.float) < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800'}`}>
                        {r.float === null ? '—' : formatMoney(fromAmount(r.float), currencyById[r.accountId] ?? budgetCurrency)}
                      </td>
                      <td className="px-4 py-2.5">
                        {/* Rule 70: positive jars must be backed by the account's money. */}
                        {r.hasBackingDeficit && (
                          <span className="inline-flex flex-wrap items-center gap-1.5">
                            <Badge tone="rose">Jars exceed account money</Badge>
                            <span className="text-xs text-slate-500">Move money out of a jar to cover it.</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </AppShell>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { Button, Card, EmptyState, ErrorBanner, Input, Select } from '../components/ui'
import { Hero } from '../components/Hero'
import { Modal } from '../components/Modal'
import { AccountsIcon } from '../components/icons'
import { useAuth } from '../auth/AuthContext'
import { useFeatures } from '../features/FeatureContext'
import { api } from '../lib/api'
import { EVENTS, track } from '../analytics'
import type { AccountDto, AccountReconciliationDto } from '../types'
import { ACCOUNT_TYPE_LABELS, AccountType } from '../types'
import { CURRENCY_OPTIONS, formatMoney, fromAmount, parseMinor, toAmount, toEditString } from '../lib/money'
import { hueColor, hueForAccountType, hueTint } from '../lib/categoryColors'

const TYPE_OPTIONS = Object.entries(ACCOUNT_TYPE_LABELS).map(([value, label]) => ({
  value: Number(value),
  label,
}))

/** Parse a possibly-negative amount string into a wire decimal; '' → 0; null when invalid. */
function parseSignedAmount(input: string): number | null {
  const trimmed = input.trim()
  if (trimmed === '') return 0
  const negative = trimmed.startsWith('-')
  const magnitude = parseMinor(negative ? trimmed.slice(1) : trimmed)
  if (magnitude === null) return null
  return toAmount(negative ? -magnitude : magnitude)
}

export function AccountsPage() {
  // Managing accounts needs Admin+ (canWrite); others get a read-only register.
  const { canWrite, preferredCurrency } = useAuth()
  const { multiCurrency } = useFeatures()
  const [accounts, setAccounts] = useState<AccountDto[]>([])
  const [reconciliation, setReconciliation] = useState<AccountReconciliationDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // Add-account modal.
  const [showAdd, setShowAdd] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState<number>(AccountType.Current)
  const [opening, setOpening] = useState('')
  const [currency, setCurrency] = useState(preferredCurrency)
  const [adding, setAdding] = useState(false)

  // Inline (in-card) edit.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [eName, setEName] = useState('')
  const [eType, setEType] = useState<number>(AccountType.Current)
  const [eOpening, setEOpening] = useState('')

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

  const addAccount = useCallback(async () => {
    if (name.trim() === '') {
      setError('Give the account a name.')
      return
    }
    const openingBalance = parseSignedAmount(opening)
    if (openingBalance === null) {
      setError('Enter a valid opening balance.')
      return
    }
    setAdding(true)
    setError(null)
    try {
      const { data } = await api.post<AccountDto>('/accounts', {
        name: name.trim(),
        type,
        currency,
        openingBalance,
      })
      setAccounts((prev) => [...prev, data])
      track(EVENTS.accountCreated, { kind: ACCOUNT_TYPE_LABELS[type] ?? 'unknown' })
      setName('')
      setOpening('')
      setCurrency(preferredCurrency)
      setShowAdd(false)
    } catch {
      setError('Could not add that account.')
    } finally {
      setAdding(false)
    }
  }, [name, type, opening, currency, preferredCurrency])

  function startEdit(a: AccountDto) {
    setEditingId(a.id)
    setEName(a.name)
    setEType(a.type)
    setEOpening(toEditString(fromAmount(a.openingBalance)))
  }

  const saveEdit = useCallback(
    async (id: string) => {
      if (eName.trim() === '') {
        setError('Give the account a name.')
        return
      }
      const openingBalance = parseSignedAmount(eOpening)
      if (openingBalance === null) {
        setError('Enter a valid opening balance.')
        return
      }
      setSavingId(id)
      setError(null)
      try {
        const { data } = await api.put<AccountDto>(`/accounts/${id}`, {
          name: eName.trim(),
          type: eType,
          openingBalance,
        })
        setAccounts((prev) => prev.map((a) => (a.id === id ? data : a)))
        track(EVENTS.accountEdited)
        setEditingId(null)
      } catch {
        setError('Could not save that account.')
      } finally {
        setSavingId(null)
      }
    },
    [eName, eType, eOpening],
  )

  const remove = useCallback(async (id: string) => {
    setSavingId(id)
    setError(null)
    try {
      await api.delete(`/accounts/${id}`)
      setAccounts((prev) => prev.filter((a) => a.id !== id))
    } catch {
      setError('Could not delete that account.')
    } finally {
      setSavingId(null)
    }
  }, [])

  // Net balance across all accounts, plus the hero's split of what you hold
  // (positive balances) vs what you owe (negative ones).
  const netMinor = useMemo(
    () => accounts.reduce((sum, a) => sum + fromAmount(a.currentBalance), 0),
    [accounts],
  )
  const availableMinor = useMemo(
    () => accounts.reduce((sum, a) => sum + Math.max(0, fromAmount(a.currentBalance)), 0),
    [accounts],
  )
  const owedMinor = useMemo(
    () => accounts.reduce((sum, a) => sum + Math.min(0, fromAmount(a.currentBalance)), 0),
    [accounts],
  )

  // Each account is a single-currency ledger. When they all share a currency the hero
  // totals are shown in it (so a preference change never mislabels them); when they
  // diverge, the raw cross-currency sum is meaningless — we label it in the preferred
  // currency and flag it, deferring real FX conversion. Per-account rows always use
  // their own currency.
  const currencies = useMemo(() => Array.from(new Set(accounts.map((a) => a.currency))), [accounts])
  const heroCurrency = currencies.length === 1 ? currencies[0] : preferredCurrency
  const mixedCurrencies = currencies.length > 1
  const currencyById = useMemo(
    () => Object.fromEntries(accounts.map((a) => [a.id, a.currency])) as Record<string, string>,
    [accounts],
  )

  return (
    <AppShell active="accounts" title="Accounts">
      <Hero
        eyebrow="Total balance"
        amount={formatMoney(netMinor, heroCurrency)}
        amountLabel={`Total balance: ${formatMoney(netMinor, heroCurrency)}`}
        tiles={[
          { label: 'Available', value: formatMoney(availableMinor, heroCurrency) },
          { label: 'Owed', value: formatMoney(-owedMinor, heroCurrency) },
        ]}
        footnote={
          mixedCurrencies ? (
            <span className="inline-flex items-center rounded-full bg-black/[0.18] px-[15px] py-2 text-[13px] font-medium">
              Totals shown in {heroCurrency}; some accounts hold another currency.
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
            {multiCurrency && (
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                Currency
                <Select value={currency} aria-label="Account currency" onChange={(e) => setCurrency(e.target.value)} className="w-full">
                  {CURRENCY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                <span className="font-normal text-slate-400">An account’s currency is fixed once created.</span>
              </label>
            )}
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
              unassigned from any account. This can’t be undone.
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
                const balanceMinor = fromAmount(a.currentBalance)
                const hue = hueForAccountType(a.type)
                if (editingId === a.id) {
                  return (
                    <Card key={a.id} className="flex flex-col gap-3 p-5">
                      <Input type="text" value={eName} aria-label={`Name for ${a.name}`} onChange={(e) => setEName(e.target.value)} className="w-full" />
                      <Select value={eType} aria-label={`Type for ${a.name}`} onChange={(e) => setEType(Number(e.target.value))}>
                        {TYPE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                      <Input type="text" inputMode="decimal" value={eOpening} aria-label={`Opening balance for ${a.name}`} onChange={(e) => setEOpening(e.target.value)} className="w-full text-right tabular-nums" />
                      {multiCurrency && (
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
                        {multiCurrency && (
                          <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                            {a.currency}
                          </span>
                        )}
                        <span className="rounded-full border border-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-500">
                          {ACCOUNT_TYPE_LABELS[a.type] ?? 'Other'}
                        </span>
                      </div>
                    </div>
                    <div>
                      <div className="text-[14.5px] font-semibold text-slate-900">{a.name}</div>
                      <div className={`mt-0.5 text-[25px] font-bold tabular-nums ${balanceMinor < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900'}`}>
                        {formatMoney(balanceMinor, a.currency)}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">Opening {formatMoney(fromAmount(a.openingBalance), a.currency)}</div>
                    </div>
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

      {reconciliation.some((r) => r.backedJarCount > 0) && (
        <Card className="overflow-hidden">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-slate-700">Jar reconciliation</h2>
            <p className="text-xs text-slate-500">
              Each account’s balance against the jars it holds — the float is what’s not yet earmarked.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 text-right font-medium">Balance</th>
                  <th className="px-4 py-2 text-right font-medium">In jars</th>
                  <th className="px-4 py-2 text-right font-medium">Float</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {reconciliation
                  .filter((r) => r.backedJarCount > 0)
                  .map((r) => (
                    <tr key={r.accountId} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-medium text-slate-700">{r.accountName}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{formatMoney(fromAmount(r.currentBalance), currencyById[r.accountId] ?? heroCurrency)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{formatMoney(fromAmount(r.backedJarsTotal), currencyById[r.accountId] ?? heroCurrency)}</td>
                      <td className={`px-4 py-2.5 text-right font-semibold tabular-nums ${fromAmount(r.float) < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800'}`}>
                        {formatMoney(fromAmount(r.float), currencyById[r.accountId] ?? heroCurrency)}
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

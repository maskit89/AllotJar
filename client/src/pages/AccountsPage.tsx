import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppShell } from '../components/AppShell'
import { Badge, Button, Card, EmptyState, ErrorBanner, Input, PageHeader, Select } from '../components/ui'
import { Hero } from '../components/Hero'
import { AccountsIcon } from '../components/icons'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { EVENTS, track } from '../analytics'
import type { AccountDto, AccountReconciliationDto } from '../types'
import { ACCOUNT_TYPE_LABELS, AccountType } from '../types'
import { formatMoney, fromAmount, parseMinor, toAmount, toEditString } from '../lib/money'
import { hueColor, hueForAccountType, hueTint } from '../lib/categoryColors'

// Account type -> Badge tone (the redesign's account hues mapped to ui Badge tones).
const TYPE_TONE: Record<number, 'violet' | 'brand' | 'amber' | 'rose' | 'teal'> = {
  [AccountType.Current]: 'violet',
  [AccountType.Savings]: 'brand',
  [AccountType.Cash]: 'amber',
  [AccountType.CreditCard]: 'rose',
  [AccountType.Other]: 'teal',
}

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
  // The household's home currency drives the app-wide label and the new-account default;
  // an account may still hold a different currency, which is shown in its own currency.
  const { canWrite, preferredCurrency } = useAuth()
  const CURRENCY = preferredCurrency
  const [accounts, setAccounts] = useState<AccountDto[]>([])
  const [reconciliation, setReconciliation] = useState<AccountReconciliationDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)

  // Add-account form.
  const [name, setName] = useState('')
  const [type, setType] = useState<number>(AccountType.Current)
  const [opening, setOpening] = useState('')
  const [adding, setAdding] = useState(false)

  // Inline edit.
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
        currency: CURRENCY,
        openingBalance,
      })
      setAccounts((prev) => [...prev, data])
      track(EVENTS.accountCreated, { kind: ACCOUNT_TYPE_LABELS[type] ?? 'unknown' })
      setName('')
      setOpening('')
    } catch {
      setError('Could not add that account.')
    } finally {
      setAdding(false)
    }
  }, [name, type, opening])

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

  // Net balance across all accounts (single-currency), plus the hero's split of
  // what you hold (positive balances) vs what you owe (negative ones).
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

  return (
    <AppShell active="accounts">
        <PageHeader
          title="Accounts"
          subtitle="Where your money actually sits. Each balance is your opening balance plus every transaction assigned to the account — so the register stays the source of truth."
        />

        <Hero
          eyebrow="Total balance"
          amount={formatMoney(netMinor, CURRENCY)}
          amountLabel={`Total balance: ${formatMoney(netMinor, CURRENCY)}`}
          tiles={[
            { label: 'Available', value: formatMoney(availableMinor, CURRENCY) },
            { label: 'Owed', value: formatMoney(-owedMinor, CURRENCY) },
          ]}
        />

        {error && <ErrorBanner>{error}</ErrorBanner>}

        {/* Add-account form. Hidden unless you can manage accounts. */}
        {canWrite && (
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">Add an account</h3>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-slate-500">
              Name
              <Input
                type="text"
                value={name}
                placeholder="e.g. Everyday current"
                aria-label="Account name"
                onChange={(e) => setName(e.target.value)}
                className="min-w-32"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Type
              <Select
                value={type}
                aria-label="Account type"
                onChange={(e) => setType(Number(e.target.value))}
              >
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
                placeholder="0,00"
                aria-label="Opening balance"
                onChange={(e) => setOpening(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addAccount()
                }}
                className="w-32 text-right tabular-nums"
              />
            </label>
            <Button onClick={addAccount} disabled={adding} aria-label="Add account">
              Add
            </Button>
          </div>
        </Card>
        )}

        {loading && <p className="text-slate-500">Loading…</p>}

        {!loading && accounts.length === 0 && (
          <EmptyState
            icon={<AccountsIcon className="h-6 w-6" />}
            title="No accounts yet"
            description="Add one above, then tag transactions to it to track its balance."
          />
        )}

        {accounts.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-base font-bold tracking-[-0.01em] text-slate-900">Your accounts</h2>
            <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
              {accounts.map((a) => {
                const editing = editingId === a.id
                const balanceMinor = fromAmount(a.currentBalance)
                const hue = hueForAccountType(a.type)
                if (editing) {
                  return (
                    <Card key={a.id} className="flex flex-col gap-3 p-5">
                      <Input
                        type="text"
                        value={eName}
                        aria-label={`Name for ${a.name}`}
                        onChange={(e) => setEName(e.target.value)}
                        className="w-full"
                      />
                      <Select
                        value={eType}
                        aria-label={`Type for ${a.name}`}
                        onChange={(e) => setEType(Number(e.target.value))}
                      >
                        {TYPE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                      <Input
                        type="text"
                        inputMode="decimal"
                        value={eOpening}
                        aria-label={`Opening balance for ${a.name}`}
                        onChange={(e) => setEOpening(e.target.value)}
                        className="w-full text-right tabular-nums"
                      />
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
                  <Card key={a.id} className="flex flex-col gap-3 p-5">
                    <div className="flex items-start justify-between gap-2">
                      <div
                        className="flex h-12 w-12 items-center justify-center rounded-2xl"
                        style={{ background: hueTint(hue) }}
                        aria-hidden
                      >
                        <span className="h-5 w-5 rounded-lg" style={{ background: hueColor(hue) }} />
                      </div>
                      <Badge tone={TYPE_TONE[a.type] ?? 'teal'}>{ACCOUNT_TYPE_LABELS[a.type] ?? 'Other'}</Badge>
                    </div>
                    <div>
                      <div className="text-[14.5px] font-semibold text-slate-900">{a.name}</div>
                      <div
                        className={`mt-0.5 text-[25px] font-bold tabular-nums ${
                          balanceMinor < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900'
                        }`}
                      >
                        {formatMoney(balanceMinor, CURRENCY)}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        Opening {formatMoney(fromAmount(a.openingBalance), CURRENCY)}
                      </div>
                    </div>
                    {canWrite && (
                      <div className="mt-auto flex justify-end gap-1 pt-1">
                        <button
                          type="button"
                          onClick={() => startEdit(a)}
                          aria-label={`Edit ${a.name}`}
                          title="Edit account"
                          className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(a.id)}
                          disabled={savingId === a.id}
                          aria-label={`Delete ${a.name}`}
                          title="Delete account"
                          className="rounded-md px-2 py-1 text-slate-500 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </Card>
                )
              })}
            </div>
          </section>
        )}

        {reconciliation.some((r) => r.backedFundCount > 0) && (
          <Card className="overflow-hidden">
            <div className="border-b border-slate-100 bg-slate-50 px-4 py-2.5">
              <h2 className="text-sm font-semibold text-slate-700">Fund reconciliation</h2>
              <p className="text-xs text-slate-500">
                Each account’s balance against the sinking funds it holds — the float is what’s not yet earmarked.
              </p>
            </div>
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 text-right font-medium">Balance</th>
                  <th className="px-4 py-2 text-right font-medium">In funds</th>
                  <th className="px-4 py-2 text-right font-medium">Float</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {reconciliation
                  .filter((r) => r.backedFundCount > 0)
                  .map((r) => (
                    <tr key={r.accountId} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-medium text-slate-700">{r.accountName}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                        {formatMoney(fromAmount(r.currentBalance), CURRENCY)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">
                        {formatMoney(fromAmount(r.backedFundsTotal), CURRENCY)}
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right font-semibold tabular-nums ${
                          fromAmount(r.float) < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800'
                        }`}
                      >
                        {formatMoney(fromAmount(r.float), CURRENCY)}
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

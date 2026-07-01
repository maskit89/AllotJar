import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { Card, EmptyState } from '../components/ui'
import { Hero } from '../components/Hero'
import { TransactionsIcon } from '../components/icons'
import { api } from '../lib/api'
import type { AccountDto, BudgetMonthDto, TransactionDto } from '../types'
import { ACCOUNT_TYPE_LABELS, TransactionType } from '../types'
import { formatMoney, fromAmount } from '../lib/money'
import { shortDate } from '../lib/dates'
import { hueColor, hueForIndex, hueTint, type CategoryHue } from '../lib/categoryColors'
import { transactionTypeLabel } from '../lib/transactions'

/**
 * A single account's detail — reached by clicking an account card. A back link,
 * the account's balance hero (Type + Transactions tiles), and that account's
 * filtered register (Date · Payee · Category · Amount).
 */
export function AccountDetailPage() {
  const { id = '' } = useParams()
  const [account, setAccount] = useState<AccountDto | null>(null)
  const [transactions, setTransactions] = useState<TransactionDto[]>([])
  const [month, setMonth] = useState<BudgetMonthDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      api.get<AccountDto[]>('/accounts'),
      api.get<TransactionDto[]>('/transactions').catch(() => null),
      api.get<BudgetMonthDto>('/budget/current').catch(() => null),
    ])
      .then(([acc, tx, budget]) => {
        if (cancelled) return
        const found = (Array.isArray(acc.data) ? acc.data : []).find((a) => a.id === id) ?? null
        setAccount(found)
        setNotFound(found === null)
        setTransactions(Array.isArray(tx?.data) ? tx.data : [])
        setMonth(budget?.data ?? null)
      })
      .catch(() => !cancelled && setNotFound(true))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [id])

  // Map each budget line to its category's hue, so the category pills match the rest of the app.
  const itemHue = useMemo(() => {
    const map: Record<string, CategoryHue | 'income'> = {}
    if (!month || !Array.isArray(month.categories)) return map
    let expenseIdx = 0
    let fundIdx = 0
    for (const c of month.categories) {
      const hue: CategoryHue | 'income' =
        c.kind === 'Income' ? 'income' : c.kind === 'Savings' ? hueForIndex(fundIdx++) : hueForIndex(expenseIdx++)
      for (const it of c.items) map[it.id] = hue
    }
    return map
  }, [month])

  const rows = useMemo(
    () => transactions.filter((t) => t.accountId === id || t.transferAccountId === id),
    [transactions, id],
  )
  const currency = account?.currency ?? 'EUR'
  const balanceMinor = account ? fromAmount(account.currentBalance) : 0

  const dotColor = (h: CategoryHue | 'income' | undefined) =>
    h === undefined ? 'var(--color-slate-400)' : h === 'income' ? 'var(--color-brand-600)' : hueColor(h)
  const tintColor = (h: CategoryHue | 'income' | undefined) =>
    h === undefined
      ? 'var(--color-slate-100)'
      : h === 'income'
        ? 'color-mix(in srgb, var(--color-brand-600) 14%, transparent)'
        : hueTint(h)

  return (
    <AppShell active="accounts" title={account?.name ?? 'Account'}>
      <Link to="/accounts" className="text-sm font-medium text-slate-500 transition hover:text-slate-900">
        ‹ Accounts
      </Link>

      {loading && <p className="text-slate-500">Loading…</p>}

      {!loading && notFound && (
        <EmptyState
          icon={<TransactionsIcon className="h-6 w-6" />}
          title="Account not found"
          description="It may have been deleted. Head back to your accounts."
        />
      )}

      {!loading && account && (
        <>
          <Hero
            eyebrow={account.name}
            amount={formatMoney(balanceMinor, currency)}
            amountLabel={`${account.name} balance: ${formatMoney(balanceMinor, currency)}`}
            tiles={[
              { label: 'Type', value: ACCOUNT_TYPE_LABELS[account.type] ?? 'Other' },
              { label: 'Transactions', value: `${rows.length}` },
            ]}
          />

          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] table-fixed text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-[11px] font-bold uppercase tracking-[0.05em] text-slate-500">
                    <th className="w-[84px] px-4 py-3 font-bold">Date</th>
                    <th className="px-4 py-3 font-bold">Payee</th>
                    <th className="w-[184px] px-4 py-3 font-bold">Category</th>
                    <th className="w-[128px] px-4 py-3 text-right font-bold">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-slate-500">
                        No transactions on this account yet.
                      </td>
                    </tr>
                  )}
                  {rows.map((t) => {
                    const isIncome = transactionTypeLabel(t.type) === 'Income'
                    const isTransfer = t.type === TransactionType.Transfer
                    const hue = t.budgetItemId ? itemHue[t.budgetItemId] : undefined
                    return (
                      <tr key={t.id} className="hover:bg-slate-50">
                        <td className="whitespace-nowrap px-4 py-3.5 tabular-nums text-slate-500">{shortDate(t.date)}</td>
                        <td className="px-4 py-3.5">
                          <span className="block truncate font-semibold text-slate-900">
                            {t.payee || (isTransfer ? 'Transfer' : '—')}
                          </span>
                        </td>
                        <td className="px-4 py-3.5">
                          {isTransfer ? (
                            <span className="text-xs text-slate-500">
                              {t.accountName ?? '—'} → {t.transferAccountName ?? '—'}
                            </span>
                          ) : t.budgetItemId ? (
                            <span
                              className="inline-flex max-w-full items-center gap-2 rounded-full px-3 py-1 text-[12.5px] font-semibold text-slate-900"
                              style={{ background: tintColor(hue) }}
                            >
                              <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: dotColor(hue) }} aria-hidden />
                              <span className="truncate">{t.budgetItemName}</span>
                            </span>
                          ) : (
                            <span className="text-sm text-slate-500">—</span>
                          )}
                        </td>
                        <td
                          className={`whitespace-nowrap px-4 py-3.5 text-right font-semibold tabular-nums ${
                            isTransfer ? 'text-slate-500' : isIncome ? 'text-brand-700 dark:text-brand-200' : 'text-slate-900'
                          }`}
                        >
                          {isTransfer ? '' : isIncome ? '+' : '−'}
                          {formatMoney(fromAmount(t.amount), t.currency)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </AppShell>
  )
}

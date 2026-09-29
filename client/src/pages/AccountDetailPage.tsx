import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { Card, EmptyState } from '../components/ui'
import { FxPendingTag } from '../components/FxPendingTag'
import { Hero } from '../components/Hero'
import { TransactionsIcon } from '../components/icons'
import { api } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { formatForeign } from '../lib/conversion'
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
  const { budgetCurrency } = useAuth()
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

  // Map each current-month line NAME to its category hue. The register spans every
  // month, but /budget/current only knows this month's line ids — keying by name lets
  // a transaction keep its colour across months. Rows whose line isn't in this month
  // fall back to a stable hue derived from the name, so none render grey.
  const hueByName = useMemo(() => {
    const map: Record<string, CategoryHue | 'income'> = {}
    if (!month || !Array.isArray(month.categories)) return map
    let expenseIdx = 0
    let fundIdx = 0
    for (const c of month.categories) {
      const hue: CategoryHue | 'income' =
        c.kind === 'Income' ? 'income' : c.kind === 'Savings' ? hueForIndex(fundIdx++) : hueForIndex(expenseIdx++)
      for (const it of c.items) map[it.name] = hue
    }
    return map
  }, [month])

  const hueForName = (name: string | null): CategoryHue | 'income' | undefined => {
    if (!name) return undefined
    if (name in hueByName) return hueByName[name]
    let h = 0
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
    return hueForIndex(Math.abs(h))
  }

  const rows = useMemo(
    () => transactions.filter((t) => t.accountId === id || t.transferAccountId === id),
    [transactions, id],
  )
  const currency = account?.currency ?? 'EUR'
  // Optional bank identifiers (rule 76) — shown only when recorded.
  const identifiers: Array<[string, string]> = account
    ? (
        [
          ['IBAN', account.iban],
          ['BIC', account.bic],
          ['Sort code', account.sortCode],
          ['Account number', account.accountNumber],
        ] as Array<[string, string | null | undefined]>
      ).filter((row): row is [string, string] => typeof row[1] === 'string' && row[1].trim() !== '')
    : []
  // Null = unavailable (no opening date, rule 67): shown as such, never as zero.
  const balanceMinor = account && account.currentBalance !== null ? fromAmount(account.currentBalance) : null

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
            amount={balanceMinor === null ? 'Not available' : formatMoney(balanceMinor, currency)}
            amountLabel={`${account.name} balance: ${balanceMinor === null ? 'not available' : formatMoney(balanceMinor, currency)}`}
            tiles={[
              { label: 'Type', value: ACCOUNT_TYPE_LABELS[account.type] ?? 'Other' },
              { label: 'Transactions', value: `${rows.length}` },
              ...((account.inTransitOut ?? 0) > 0 || (account.inTransitIn ?? 0) > 0
                ? [{ label: 'In transit', value: formatMoney(fromAmount((account.inTransitOut ?? 0) + (account.inTransitIn ?? 0)), currency) }]
                : []),
              ...((account.pendingReceiptCount ?? 0) > 0
                ? [{ label: 'Pending review', value: formatMoney(fromAmount(account.pendingReceiptTotal ?? 0), currency) }]
                : []),
            ]}
            footnote={
              balanceMinor === null ? (
                <span className="inline-flex items-center rounded-full bg-black/[0.18] px-[15px] py-2 text-[13px] font-medium">
                  {account.openingDateMissing ? 'Set an opening date to calculate the balance.' : 'No balance before the opening date.'}
                </span>
              ) : undefined
            }
          />

          {identifiers.length > 0 && (
            <Card as="section" aria-labelledby="account-details-heading" className="p-5">
              <h2 id="account-details-heading" className="text-sm font-semibold text-slate-700">Account details</h2>
              <dl className="mt-2 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
                {identifiers.map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3 sm:block">
                    <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
                    <dd className="font-mono text-slate-800">{value}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}

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
                    const hue = hueForName(t.budgetItemName)
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
                              {t.accountName ?? '(removed account)'} → {t.transferAccountName ?? '(removed account)'}
                              {t.transferStatus === 'InTransit' && (
                                <span className="ml-1.5 rounded-[5px] border border-sky-200 bg-sky-50 px-1.5 py-px text-[9.5px] font-semibold text-sky-700 dark:border-sky-400/30 dark:bg-sky-400/10 dark:text-sky-300">
                                  In transit
                                </span>
                              )}
                              {t.transferStatus === 'PendingReview' && (
                                <span className="ml-1.5 rounded-[5px] border border-amber-200 bg-amber-50 px-1.5 py-px text-[9.5px] font-semibold text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300">
                                  Pending review
                                </span>
                              )}
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
                          {t.fxPending && <FxPendingTag budgetCurrency={budgetCurrency} className="mr-1.5" />}
                          {/* On a single-account register a transfer is signed by direction:
                              − when this account is the source, + when it's the destination. */}
                          {isTransfer ? (t.accountId === id ? '−' : '+') : isIncome ? '+' : '−'}
                          {formatMoney(fromAmount(t.amount), t.currency)}
                          {!t.fxPending && t.originalCurrency && t.originalAmount != null && (
                            <span className="mt-0.5 block text-[11px] font-normal text-slate-500" title={`Paid in ${t.originalCurrency}`}>
                              {formatForeign(t.originalAmount, t.originalCurrency)}
                            </span>
                          )}
                          {!t.fxPending && t.budgetAmount != null && (
                            <span className="mt-0.5 block text-[11px] font-normal text-slate-500">
                              Counts as {formatMoney(fromAmount(t.budgetAmount), budgetCurrency)} in the budget
                            </span>
                          )}
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

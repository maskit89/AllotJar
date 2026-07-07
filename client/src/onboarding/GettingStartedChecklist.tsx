import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { api } from '../lib/api'
import type { BudgetMonthDto, BudgetMonthSummaryDto, TransactionDto } from '../types'
import { fromDto, remainingToBudget, totalIncome } from '../budgetModel'
import { CheckIcon, ChevronDownIcon, CloseIcon } from '../components/icons'
import { useAuth } from '../auth/AuthContext'
import { currencyNoun } from '../lib/money'
import { useOnboarding } from './OnboardingContext'

interface Progress {
  monthExists: boolean
  hasIncome: boolean
  balanced: boolean
  hasTransaction: boolean
}

const EMPTY: Progress = { monthExists: false, hasIncome: false, balanced: false, hasTransaction: false }
const now = new Date()

/**
 * A small, dismissible "Getting started" panel pinned to the corner. Its steps
 * tick off automatically from the user's own data (refreshed on navigation), so
 * it doubles as a progress tracker without ever blocking the screen.
 */
export function GettingStartedChecklist() {
  const { dismissChecklist } = useOnboarding()
  const { preferredCurrency, households } = useAuth()
  const noun = currencyNoun(preferredCurrency)
  const location = useLocation()
  const [open, setOpen] = useState(true)
  const [progress, setProgress] = useState<Progress>(EMPTY)

  const refresh = useCallback(() => {
    let cancelled = false
    const set = (p: Partial<Progress>) => !cancelled && setProgress((prev) => ({ ...prev, ...p }))

    api
      .get<BudgetMonthSummaryDto[]>('/budget/months')
      .then(({ data }) => set({ monthExists: Array.isArray(data) && data.length > 0 }))
      .catch(() => {})

    api
      .get<BudgetMonthDto>(`/budget/${now.getFullYear()}/${now.getMonth() + 1}`)
      .then(({ data }) => {
        const vm = fromDto(data)
        const income = totalIncome(vm)
        set({ hasIncome: income > 0, balanced: income > 0 && remainingToBudget(vm) === 0 })
      })
      .catch(() => set({ hasIncome: false, balanced: false }))

    api
      .get<TransactionDto[]>('/transactions')
      .then(({ data }) => set({ hasTransaction: Array.isArray(data) && data.length > 0 }))
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [])

  // Re-check on mount, after every navigation (the user just did something), and
  // when the tab regains focus.
  useEffect(refresh, [refresh, location.pathname])
  useEffect(() => {
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  // The checklist walks an OWNER through building their first month. Someone viewing a household
  // they joined would see it pre-ticked (or nagging about a budget that isn't theirs) — skip it.
  // (After the hooks above, so hook order stays stable when the household list loads in.)
  const activeHousehold = households.find((h) => h.isActive)
  if (activeHousehold && !activeHousehold.isOwn) return null

  const steps = [
    { id: 'month', label: 'Create your first month', hint: 'Copy last month, start blank, or pick a template.', to: '/', done: progress.monthExists },
    { id: 'income', label: 'Plan your income', hint: 'Add what you expect to earn this month.', to: '/', done: progress.hasIncome },
    { id: 'balance', label: `Give every ${noun} a job`, hint: 'Assign it all until Remaining reaches zero.', to: '/', done: progress.balanced },
    { id: 'tx', label: 'Log your first transaction', hint: 'Record real spending and assign it to a line.', to: '/transactions', done: progress.hasTransaction },
  ]
  const doneCount = steps.filter((s) => s.done).length
  const allDone = doneCount === steps.length

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg transition hover:bg-brand-700"
      >
        <CheckIcon className="h-4 w-4" />
        Getting started · {doneCount}/{steps.length}
      </button>
    )
  }

  return (
    <section
      aria-label="Getting started"
      className="fixed bottom-4 right-4 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-200/70 bg-surface shadow-lg"
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-bold text-slate-900">Getting started</h2>
          <p className="text-xs text-slate-500">
            {doneCount} of {steps.length} done
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Collapse getting started"
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            <ChevronDownIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={dismissChecklist}
            aria-label="Dismiss getting started"
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="px-4 pt-3">
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
          role="progressbar"
          aria-valuenow={doneCount}
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-label="Onboarding progress"
        >
          <div
            className="h-full rounded-full bg-brand-600 transition-all"
            style={{ width: `${(doneCount / steps.length) * 100}%` }}
          />
        </div>
      </div>

      <ul className="space-y-1 p-3">
        {steps.map((s) => (
          <li key={s.id}>
            <Link to={s.to} className="flex items-start gap-3 rounded-lg px-2 py-2 transition hover:bg-slate-50">
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                  s.done ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 text-transparent'
                }`}
              >
                <CheckIcon className="h-3 w-3" />
                <span className="sr-only">{s.done ? 'Done:' : 'To do:'}</span>
              </span>
              <span>
                <span className={`block text-sm font-medium ${s.done ? 'text-slate-500 line-through' : 'text-slate-800'}`}>
                  {s.label}
                </span>
                <span className="block text-xs text-slate-500">{s.hint}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {allDone && (
        <div className="border-t border-slate-200 px-4 py-3 text-center">
          <p className="text-sm font-semibold text-brand-700 dark:text-brand-200">
            All set — every {noun} has a job! 🎉
          </p>
          <button
            type="button"
            onClick={dismissChecklist}
            className="mt-1 text-xs font-medium text-slate-500 transition hover:text-slate-700"
          >
            Hide this checklist
          </button>
        </div>
      )}
    </section>
  )
}

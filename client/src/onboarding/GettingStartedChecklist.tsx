import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ChevronUp } from 'lucide-react'
import { api } from '../lib/api'
import type { AccountDto, BudgetMonthDto, BudgetMonthSummaryDto, JarDto, MonthWrapUpDto, TransactionDto } from '../types'
import { fromDto, remainingToBudget, totalIncome } from '../budgetModel'
import { CheckIcon, ChevronDownIcon, CloseIcon } from '../components/icons'
import { InfoHint } from '../components/InfoHint'
import { StatusChip } from '../components/StatusChip'
import { ROW_HINT } from '../components/settings/parts'
import { useAuth } from '../auth/AuthContext'
import { currencyNoun, fromAmount } from '../lib/money'
import { currentMonth } from '../lib/dates'
import { useMediaQuery } from '../lib/useMediaQuery'
import { useFeatures } from '../features/FeatureContext'
import { useOnboarding } from './OnboardingContext'

interface Progress {
  hasAccount: boolean
  monthExists: boolean
  hasIncome: boolean
  hasJar: boolean
  balanced: boolean
  hasTransaction: boolean
}

const EMPTY: Progress = { hasAccount: false, monthExists: false, hasIncome: false, hasJar: false, balanced: false, hasTransaction: false }

/** The card's two small icon buttons (collapse, dismiss): 32px, 40px for a finger on a phone. */
const ICON_BUTTON =
  'grid size-8 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-surface-2 hover:text-slate-900 max-[699.98px]:size-10 dark:hover:bg-foreground/7'

/**
 * Where it sits: on a wide screen at the bottom right of the content column (the sidebar and its
 * Help item are on the left); on a phone (below 700px) above the tab bar (`--tabbar-h`, safe area
 * included), the card full width within the page's 16px gutter and the pill at the right.
 */
const PINNED =
  'fixed z-40 right-[max(1.5rem,env(safe-area-inset-right))] bottom-[max(calc(var(--tabbar-h)+12px),calc(env(safe-area-inset-bottom)+1.5rem))] max-[699.98px]:right-[max(1rem,env(safe-area-inset-right))]'

/**
 * A small, dismissible "Getting started" card pinned to the corner. Its steps
 * tick off automatically from the user's own data (refreshed on navigation), so
 * it doubles as a progress tracker without ever blocking the screen.
 *
 * The look (restyle PR 19): a compact off-white card with an eyebrow title, its (i) (what the steps
 * are for: the hints that once sat under every row), the count, a thin progress line and one row per
 * step, a check and a short name. Collapsed, it is a quiet pill (the title, a chip with the count and
 * a chevron), never a second green button. All done, one line under the rows, "Every euro has a
 * job.", with a quiet Dismiss. On a phone it starts collapsed, so the Dashboard's hero and budget
 * card stay in sight; opened, it is capped below the hero and its rows scroll inside it.
 */
export function GettingStartedChecklist() {
  const { dismissChecklist } = useOnboarding()
  const { budgetCurrency, households } = useAuth()
  const features = useFeatures()
  const noun = currencyNoun(budgetCurrency)
  const location = useLocation()
  const phone = useMediaQuery('(max-width: 699.98px)')
  // Untouched, it is open on a wide screen and collapsed on a phone; the user's choice then holds.
  const [chosen, setChosen] = useState<boolean | null>(null)
  const open = chosen ?? !phone
  const [progress, setProgress] = useState<Progress>(EMPTY)
  // Focus follows the toggle: to the pill after collapsing, to the collapse button after opening.
  const pillRef = useRef<HTMLButtonElement>(null)
  const collapseRef = useRef<HTMLButtonElement>(null)
  const toggled = useRef(false)
  useEffect(() => {
    if (!toggled.current) return
    toggled.current = false
    ;(open ? collapseRef : pillRef).current?.focus()
  }, [open])
  const toggle = (next: boolean) => {
    toggled.current = true
    setChosen(next)
  }

  // Only the latest check lands: a focus check and a navigation check in flight together answer in
  // either order, and an older "no income yet" must not overwrite a newer answer.
  const latestCheck = useRef(0)
  const refresh = useCallback(() => {
    let cancelled = false
    const checkNo = ++latestCheck.current
    const set = (p: Partial<Progress>) => !cancelled && checkNo === latestCheck.current && setProgress((prev) => ({ ...prev, ...p }))

    api
      .get<BudgetMonthSummaryDto[]>('/budget/months')
      .then(({ data }) => set({ monthExists: Array.isArray(data) && data.length > 0 }))
      .catch(() => {})

    // Today's month, read on every check: a tab left open over a month's end asks about the new one.
    const { year, month } = currentMonth(new Date())
    api
      .get<BudgetMonthDto>(`/budget/${year}/${month}`)
      .then(({ data }) => {
        const vm = fromDto(data)
        const income = totalIncome(vm)
        set({ hasIncome: income > 0 })
        if (income <= 0) return set({ balanced: false })
        // "Every euro has a job" counts the month's carry as the Dashboard does (rule 94): money
        // already in the accounts or left by last month needs a job too. Read only once there is
        // income, as nothing is balanced without it; unknown, it is not ticked.
        return api
          .get<MonthWrapUpDto>(`/budget/${year}/${month}/wrap-up`)
          .then(({ data: wrapUp }) => {
            const carry = typeof wrapUp?.toAllot === 'number' ? fromAmount(wrapUp.toAllot) : null
            set({ balanced: carry !== null && remainingToBudget(vm) + carry === 0 })
          })
          .catch(() => set({ balanced: false }))
      })
      .catch(() => set({ hasIncome: false, balanced: false }))

    api
      .get<AccountDto[]>('/accounts')
      .then(({ data }) => set({ hasAccount: Array.isArray(data) && data.length > 0 }))
      .catch(() => {})

    api
      .get<JarDto[]>('/jars')
      .then(({ data }) => set({ hasJar: Array.isArray(data) && data.length > 0 }))
      .catch(() => {})

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

  // The menu's order, the order a household sets up in: an account (a jar is held in one), a jar
  // (its contribution is planned onto each month created after it), the month, then spending.
  const steps = [
    // Each only where its page is on: the step links to it.
    ...(features.accounts ? [{ id: 'account', label: 'Add an account', to: '/accounts', done: progress.hasAccount }] : []),
    ...(features.jars ? [{ id: 'jar', label: 'Add a jar', to: '/jars', done: progress.hasJar }] : []),
    { id: 'month', label: 'Create your first month', to: '/', done: progress.monthExists },
    { id: 'income', label: 'Plan your income', to: '/', done: progress.hasIncome },
    { id: 'balance', label: `Give every ${noun} a job`, to: '/', done: progress.balanced },
    { id: 'tx', label: 'Log your first transaction', to: '/transactions', done: progress.hasTransaction },
  ]
  const setup = [features.accounts && 'an account', features.jars && 'a jar'].filter(Boolean).join(' and ')
  const doneCount = steps.filter((s) => s.done).length
  const allDone = doneCount === steps.length

  if (!open) {
    return (
      <button
        ref={pillRef}
        type="button"
        onClick={() => toggle(true)}
        aria-expanded={false}
        className={`${PINNED} onb-card flex h-10 items-center gap-2 rounded-full border border-slate-200/80 pr-3 pl-4 text-[13px] font-semibold text-slate-900 shadow-[var(--shadow-frame-lg)] transition hover:bg-surface-2 max-[699.98px]:h-11 dark:hover:bg-foreground/7`}
      >
        Getting started
        <StatusChip tone={allDone ? 'ok' : 'neutral'}>
          {doneCount} of {steps.length}
        </StatusChip>
        <ChevronUp aria-hidden strokeWidth={1.8} className="size-4 text-slate-500" />
      </button>
    )
  }

  return (
    <section
      aria-label="Getting started"
      className={`${PINNED} onb-card flex max-h-[calc(100dvh-48px)] w-80 max-w-[calc(100vw-var(--sidebar-w,0px)-3rem)] flex-col rounded-2xl border border-slate-200/80 text-sm shadow-[var(--shadow-frame-lg)] max-[699.98px]:left-[max(1rem,env(safe-area-inset-left))] max-[699.98px]:max-h-[calc(100dvh-var(--tabbar-h)-224px)] max-[699.98px]:w-auto max-[699.98px]:max-w-none`}
    >
      <div className="flex flex-none items-center gap-1.5 pt-2.5 pr-2 pb-2 pl-4 max-[699.98px]:pt-1.5 max-[699.98px]:pb-1">
        <h2 className="text-xs font-semibold tracking-[0.05em] text-slate-500 uppercase">Getting started</h2>
        <InfoHint fixed label="About getting started" buttonClassName={ROW_HINT}>
          Steps tick themselves off as you go. {setup ? `Add ${setup}, then start` : 'Start'} a month blank or from
          a template, add your income, assign it all until Remaining to budget reads zero, then log or import your
          spending.
        </InfoHint>
        <span className="ml-auto pr-1 text-xs font-semibold text-slate-500 tabular-nums">
          {doneCount} of {steps.length} done
        </span>
        <button
          ref={collapseRef}
          type="button"
          onClick={() => toggle(false)}
          aria-label="Collapse getting started"
          className={ICON_BUTTON}
        >
          <ChevronDownIcon className="h-4 w-4" />
        </button>
        {!allDone && (
          <button type="button" onClick={dismissChecklist} aria-label="Dismiss getting started" className={ICON_BUTTON}>
            <CloseIcon className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex-none px-4">
        <div
          className="h-[3px] w-full overflow-hidden rounded-full bg-track"
          role="progressbar"
          aria-valuenow={doneCount}
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-label="Onboarding progress"
        >
          <div
            className="h-full rounded-full bg-brand-600 transition-all dark:bg-brand-500"
            style={{ width: `${(doneCount / steps.length) * 100}%` }}
          />
        </div>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-1.5 pb-2">
        {steps.map((s) => (
          <li key={s.id}>
            <Link
              to={s.to}
              className="flex min-h-10 items-center gap-3 rounded-[10px] px-2 transition hover:bg-surface-2 max-[699.98px]:min-h-11 dark:hover:bg-foreground/7"
            >
              <span
                className={`grid size-5 shrink-0 place-items-center rounded-full ${
                  s.done
                    ? 'bg-brand-600 text-white'
                    : 'text-transparent shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--color-slate-400)_70%,transparent)]'
                }`}
              >
                <CheckIcon className="h-3 w-3" />
                <span className="sr-only">{s.done ? 'Done:' : 'To do:'}</span>
              </span>
              {/* The space keeps the row's name "Done: Create your first month", not "Done:Create…". */}{' '}
              <span className={`min-w-0 truncate font-medium ${s.done ? 'text-slate-500' : 'text-slate-900'}`}>{s.label}</span>
            </Link>
          </li>
        ))}
      </ul>

      {allDone && (
        <div className="flex flex-none items-center gap-2 border-t border-line py-1.5 pr-2 pl-4">
          <p className="min-w-0 flex-1 font-semibold text-slate-900">Every {noun} has a job.</p>
          <button
            type="button"
            onClick={dismissChecklist}
            className="h-8 shrink-0 rounded-lg px-2.5 text-[13px] font-semibold text-slate-500 transition hover:bg-surface-2 hover:text-slate-900 max-[699.98px]:h-10 dark:hover:bg-foreground/7"
          >
            Dismiss
          </button>
        </div>
      )}
    </section>
  )
}

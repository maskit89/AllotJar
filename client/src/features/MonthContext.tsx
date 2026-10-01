import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { EVENTS, track } from '../analytics'
import { currentMonth } from '../lib/dates'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * The app-wide "current month". The redesign's top bar drives it from every
 * screen (the `‹ June 2026 ›` navigator), and the month-scoped pages — Budget,
 * Transactions, Reports, People and Allocation — read it here so they all move
 * together. Stored as { year, month } where month is 1–12.
 */
export interface MonthState {
  year: number
  month: number
  /** e.g. "June 2026". */
  label: string
  goPrev: () => void
  goNext: () => void
  goToMonth: (year: number, month: number) => void
}

/** The current month is the UTC month, as on the server (rule 82, P14). */
const nowMonth = () => currentMonth()

/** Safe default so consumers (and page tests) render without a provider: the
 *  current month, with no-op navigation. The real provider supplies state. */
const DEFAULT: MonthState = {
  ...nowMonth(),
  get label() {
    const { year, month } = nowMonth()
    return `${MONTH_NAMES[month - 1]} ${year}`
  },
  goPrev: () => {},
  goNext: () => {},
  goToMonth: () => {},
}

const MonthContext = createContext<MonthState>(DEFAULT)

/** The app-wide current month. Defaults to the current month when no provider. */
export function useMonth(): MonthState {
  return useContext(MonthContext)
}

export function MonthProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState(nowMonth)

  const goPrev = useCallback(() => {
    track(EVENTS.monthNavigated, { direction: 'prev' })
    setView((v) => (v.month === 1 ? { year: v.year - 1, month: 12 } : { ...v, month: v.month - 1 }))
  }, [])
  const goNext = useCallback(() => {
    track(EVENTS.monthNavigated, { direction: 'next' })
    setView((v) => (v.month === 12 ? { year: v.year + 1, month: 1 } : { ...v, month: v.month + 1 }))
  }, [])
  const goToMonth = useCallback((year: number, month: number) => setView({ year, month }), [])

  const value = useMemo<MonthState>(
    () => ({
      year: view.year,
      month: view.month,
      label: `${MONTH_NAMES[view.month - 1]} ${view.year}`,
      goPrev,
      goNext,
      goToMonth,
    }),
    [view, goPrev, goNext, goToMonth],
  )

  return <MonthContext.Provider value={value}>{children}</MonthContext.Provider>
}

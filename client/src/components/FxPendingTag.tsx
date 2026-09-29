/**
 * Row-level marker for a transaction recorded in another currency that still waits for its
 * amount in the budget currency (server-side FxPending). The app never converts on its own, so
 * the row counts nowhere (budget, reports, people) until the user enters or confirms that amount.
 * Styled after the "Budgeted to" row tag.
 */
export function FxPendingTag({ budgetCurrency, className = '' }: { budgetCurrency: string; className?: string }) {
  return (
    <span
      title={`In another currency. Not counted anywhere until you enter the amount in ${budgetCurrency}.`}
      className={`inline-block rounded-[5px] border border-amber-200 bg-amber-50 px-1.5 py-px align-middle text-[9.5px] font-semibold text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300 ${className}`}
    >
      Needs {budgetCurrency} amount
    </span>
  )
}

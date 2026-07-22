/**
 * Row-level marker for a foreign-currency transaction whose exchange rate is still
 * unresolved (server-side FxPending): the amount counts at face value until a later
 * import reconciles the real rate, so the register must say so rather than present
 * the figure as settled. Styled after the "Budgeted to" row tag.
 */
export function FxPendingTag() {
  return (
    <span
      title="Exchange rate unavailable — this amount counts at face value until a later import resolves the rate"
      className="mr-1.5 inline-block rounded-[5px] border border-amber-200 bg-amber-50 px-1.5 py-px align-middle text-[9.5px] font-semibold text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300"
    >
      Rate pending
    </span>
  )
}

import { Fragment, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { useLocation, useNavigationType, useParams } from 'react-router-dom'
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, ShoppingBag, Split, Undo2, Wallet } from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { EmptyState } from '../components/ui'
import { KpiRow, KpiTile } from '../components/KpiTile'
import { InfoHint } from '../components/InfoHint'
import { MiniBar, StatusChip } from '../components/StatusChip'
import { CARD_TITLE, DASH_CARD, TITLE_HINT } from '../components/budget/card'
import { EYEBROW } from '../components/budget/BudgetGroup'
import { CategoryChip, NEUTRAL, TxTile } from '../components/transactions/TxParts'
import { HolderAvatars, TypeTile } from '../components/accounts/AccountParts'
import { accountJars, reconFromState } from '../lib/accountJars'
import { registerRows, type RegisterRow } from '../lib/accountRegister'
import { useJarLedgers } from '../lib/jarLedgers'
import { JarNavIcon, TransactionsIcon } from '../components/icons'
import { api } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { useHousehold } from '../features/HouseholdContext'
import { formatForeign } from '../lib/conversion'
import type { AccountDto, AccountReconciliationDto, BudgetMonthDto, TransactionDto } from '../types'
import { ACCOUNT_TYPE_LABELS, TransactionType } from '../types'
import { formatMoney, fromAmount } from '../lib/money'
import { formatDate, monthHeading, shortDate } from '../lib/dates'
import { hueColor, hueForIndex, type CategoryHue } from '../lib/categoryColors'
import { jarLinesOf, transactionTypeLabel } from '../lib/transactions'
import { useMediaQuery } from '../lib/useMediaQuery'
import { useProgressiveList } from '../lib/useProgressiveList'

/**
 * What the Balance hero's (i) says the number counts. Money from another account counts here once
 * its arrival is confirmed: neither a transfer still in transit nor a receipt in pending review
 * (which waits for its departure) is posted yet.
 */
const BALANCE_HINT =
  'The opening balance plus every transaction since. Money moved from another account counts once its arrival is confirmed.'

/** The count badge after a card title (the segmented control's badge: 18px, 12px, a 14% tint). */
const COUNT_BADGE =
  'inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-slate-500)_14%,var(--color-card))] px-[5px] text-xs font-semibold text-slate-500 tabular-nums'

/**
 * A label in the category's place that gives way when its line is short of room (an amount with a
 * chip under it on a narrow phone): it truncates, at most its cell wide, as on Transactions.
 */
const GIVES_WAY = 'max-w-full min-w-0 shrink!'

/** The small quiet lines under a row's amount (as on Transactions). */
const SMALL = 'text-xs font-normal whitespace-nowrap text-slate-400 tabular-nums'
/**
 * On a phone the same lines wrap within a capped width, so a long one ("Counts as €27.15 in the
 * budget") never squeezes the payee and the category chip beside it to nothing.
 */
const SMALL_PHONE = 'max-w-28 text-xs font-normal text-balance text-slate-400 tabular-nums'

/**
 * A single account's page (restyle PR 11, the approved "polished Warm" mock-up), reached from an
 * account's card on Accounts; the top bar's chevron goes back there. Read-only for everyone.
 *  - One KPI row on the body's three columns: the green hero Balance (with its reason when it
 *    can't be worked out, and what is in transit or pending review, as short lines under it), and,
 *    for an account that holds jars, what they hold of it (the Accounts card's bar and caption).
 *  - The account's transactions, every month, newest first, under one eyebrow per month: the date
 *    it posts here, the payee, the category (or the transfer's other account with the direction,
 *    and its status), the amount as this account sees it. An amount that never moved this balance
 *    (a transfer sent back, a row dated before the opening date) is struck through.
 *  - Account details: the type, who holds it, the opening balance and its date, and the bank
 *    identifiers that are recorded. Beside the list on a wide screen, after it on a narrow one.
 */
export function AccountDetailPage() {
  const { id = '' } = useParams()
  const { budgetCurrency } = useAuth()
  const { members } = useHousehold()
  // Phones: a row on two lines, the date after the category.
  const phone = useMediaQuery('(max-width: 699.98px)')
  // The narrowest phones (and 400% zoom): a "Needs EUR amount" tag joins the second line, so the
  // amount's column stays narrow and the payee and category keep their room.
  const narrow = useMediaQuery('(max-width: 359.98px)')
  const [account, setAccount] = useState<AccountDto | null>(null)
  const [transactions, setTransactions] = useState<TransactionDto[]>([])
  const [month, setMonth] = useState<BudgetMonthDto | null>(null)
  // The account's line of the reconciliation (what its jars hold of it), for the account it was
  // read for: null while unknown, `line` null when the answer had none (or the read failed).
  const [reconFor, setReconFor] = useState<{ id: string; line: AccountReconciliationDto | null } | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const listHeadingId = useId()
  const detailsHeadingId = useId()

  // The Accounts page hands over the account's line of the reconciliation it has just read (#344
  // P3-3) on an in-app open; a direct open, a reload, Back and Forward read it here instead.
  const location = useLocation()
  const navigationType = useNavigationType()
  const handed = useMemo(() => reconFromState(location.state, id, navigationType === 'PUSH'), [location.state, id, navigationType])
  const handedOver = !!handed

  // Which jars each account holds (GET /jars/ledger, as Transactions reads it): a payment on a
  // jar's line gets the jar chip when that jar sits in this account (#344 P3-2).
  const { byAccount: ledgerByAccount, loaded: ledgersLoaded } = useJarLedgers()

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
    // What the account's jars hold of it (the Accounts card's figures), when the Accounts page did
    // not hand it over: asked for at the same time but never waited on: the balance and the list
    // show without it, the In jars tile's room kept while it may come (see reserveJars), and the
    // tile joins them when it answers. A failure only leaves the tile out, as the Accounts page
    // leaves its jar lines out. A figure read for another account never shows for this one.
    if (!handedOver) {
      api
        .get<AccountReconciliationDto[]>('/accounts/reconciliation')
        .then((reconciliation) => {
          if (cancelled) return
          setReconFor({ id, line: (Array.isArray(reconciliation?.data) ? reconciliation.data : []).find((r) => r.accountId === id) ?? null })
        })
        .catch(() => !cancelled && setReconFor({ id, line: null }))
    }
    return () => {
      cancelled = true
    }
  }, [id, handedOver])

  // Each current-month line NAME to its category hue (the Transactions page's colours: income
  // emerald, savings and spending by their order). The register spans every month, but
  // /budget/current only knows this month's line ids, so keying by name lets a transaction keep its
  // colour across months; a line not in this month takes a stable hue from its name. The jars'
  // lines (a jar's savings line) are kept by id and by name, with the jar each belongs to.
  const { hueByName, jarByName } = useMemo(() => {
    const hues: Record<string, CategoryHue> = {}
    const jars = new Map<string, string>()
    if (!month || !Array.isArray(month.categories)) return { hueByName: hues, jarByName: jars }
    let expenseIdx = 0
    let fundIdx = 0
    for (const c of month.categories) {
      const hue: CategoryHue = c.kind === 'Income' ? 'emerald' : c.kind === 'Savings' ? hueForIndex(fundIdx++) : hueForIndex(expenseIdx++)
      for (const it of c.items) {
        hues[it.name] = hue
        if (it.savingsId) jars.set(it.name, it.savingsId)
      }
    }
    return { hueByName: hues, jarByName: jars }
  }, [month])
  const jarById = useMemo(() => jarLinesOf(Array.isArray(month?.categories) ? month : null), [month])

  /**
   * A payment's line is a jar's line for this account when it is a jar's savings line AND that jar
   * sits in this account, as on Transactions (its isJarLineFor; there by this month's line ids, here
   * by the line's name too, since the register spans every month).
   */
  const isJarLine = (t: TransactionDto): boolean => {
    const jarId = (t.budgetItemId ? jarById.get(t.budgetItemId) : undefined) ?? (t.budgetItemName ? jarByName.get(t.budgetItemName) : undefined)
    return !!jarId && (ledgerByAccount.get(id)?.jars.some((j) => j.jarId === jarId) ?? false)
  }

  const colorForName = (name: string | null | undefined): string => {
    if (!name) return NEUTRAL
    if (name in hueByName) return hueColor(hueByName[name])
    let h = 0
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
    return hueColor(hueForIndex(Math.abs(h)))
  }

  const shownAccount = account && account.id === id ? account : null
  // This account's rows (transfers into it included), newest first by the date each shows here;
  // the server's order is kept within a day.
  const rows = useMemo<RegisterRow[]>(
    () => registerRows(transactions, id, shownAccount?.openingDate),
    [transactions, id, shownAccount?.openingDate],
  )

  // Years of rows are drawn a batch at a time as the list scrolls (see useProgressiveList).
  const { shown, more, sentinelRef } = useProgressiveList(rows.length, { resetKey: id })
  // One group a month (the month a row shows in).
  const months = useMemo(() => {
    const groups: Array<{ key: string; rows: RegisterRow[] }> = []
    for (const r of rows.slice(0, shown)) {
      const key = r.shown.slice(0, 7)
      const last = groups[groups.length - 1]
      if (last && last.key === key) last.rows.push(r)
      else groups.push({ key, rows: [r] })
    }
    return groups
  }, [rows, shown])

  const currency = account?.currency ?? 'EUR'
  // Optional bank identifiers (rule 76): shown only when recorded, as stored.
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
  // What the account's jars hold of it, or null when it holds none (or the figures didn't load).
  const reconKnown = !!handed || reconFor?.id === id
  const recon = handed ? handed.line : reconFor?.id === id ? reconFor.line : null
  const jars = account ? accountJars(account, recon ?? undefined, balanceMinor) : null
  // While the figures are still on their way, the In jars tile's room is kept (#344 P3-6), so the
  // tile takes it in place instead of pushing the list down: unless the jar ledger has already
  // said this account holds no jar.
  const reserveJars =
    !reconKnown && (!ledgersLoaded || (ledgerByAccount.get(id)?.jars.some((j) => !j.isArchived) ?? false))

  /** The hero's short lines: why there is no balance, then what is in transit and pending review. */
  function heroSub(a: AccountDto): ReactNode {
    const lines: string[] = []
    if (balanceMinor === null) {
      lines.push(a.openingDateMissing ? 'Set an opening date to calculate the balance.' : 'No balance before the opening date.')
    }
    // One figure: what is on its way out of the account and into it, together.
    if ((a.inTransitOut ?? 0) > 0 || (a.inTransitIn ?? 0) > 0) {
      lines.push(`${formatMoney(fromAmount((a.inTransitOut ?? 0) + (a.inTransitIn ?? 0)), currency)} in transit`)
    }
    if ((a.pendingReceiptCount ?? 0) > 0) lines.push(`${formatMoney(fromAmount(a.pendingReceiptTotal ?? 0), currency)} pending review`)
    if (lines.length === 0) return undefined
    return (
      <span className="flex flex-col gap-1">
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </span>
    )
  }

  function renderRow({ t, shown, out, cameBack, beforeOpening, notCounted, sign }: RegisterRow, a: AccountDto) {
    const isTransfer = t.type === TransactionType.Transfer
    const isIncome = transactionTypeLabel(t.type) === 'Income'
    const isRefund = !!t.refundOfTransactionId
    // Rules 40/74 (lib/accountRegister): a row dated before the opening date is history only (the
    // opening balance already includes it), a transfer sent back never moved the balance, and one
    // that left before the opening date but came back after it moved it on its return, so it shows
    // on its return date as money in (`cameBack`, #344 P3-1).
    const payee = t.payee || (isTransfer ? 'Transfer' : '—')
    const date = shortDate(shown)
    const lineColor = colorForName(t.budgetItemName)
    // A payment on a jar's line draws from the jar, as on Transactions: when that jar sits in this
    // (the paying) account.
    const jarLine = !isTransfer && !t.isSplit && !!t.budgetItemName && isJarLine(t)

    // The leading tile: one glyph per kind of row (no category icons in the data), in its colour.
    const glyph = isTransfer ? (
      <ArrowLeftRight strokeWidth={1.8} />
    ) : isIncome && !isRefund ? (
      <Wallet strokeWidth={1.8} />
    ) : isRefund ? (
      <Undo2 strokeWidth={1.8} />
    ) : jarLine ? (
      <JarNavIcon strokeWidth={1.8} />
    ) : (
      <ShoppingBag strokeWidth={1.8} />
    )
    const tileColor = isTransfer
      ? hueColor('teal')
      : isIncome && !isRefund
        ? hueColor('emerald')
        : t.isSplit
          ? colorForName(t.splits[0]?.budgetItemName)
          : lineColor
    // Before the opening date only the decorative icon fades; the words step back a shade.
    const tile = (
      <span className={`block ${beforeOpening ? 'opacity-55' : ''}`}>
        <TxTile color={tileColor}>{glyph}</TxTile>
      </span>
    )

    // What the row is: the transfer's other account with the arrow of the money's direction (the
    // word is for screen readers only on a phone), a split, the line's chip, or Unassigned.
    let what: ReactNode
    if (isTransfer) {
      const other = out ? (t.transferAccountName ?? '(removed account)') : (t.accountName ?? '(removed account)')
      const Arrow = out ? ArrowUpRight : ArrowDownLeft
      what = (
        <span data-tx-route="" className="inline-flex min-w-0 items-center gap-[5px] text-[13px] whitespace-nowrap text-slate-400">
          <Arrow aria-hidden strokeWidth={1.8} className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            <span className={phone ? 'sr-only' : undefined}>{out ? 'To' : 'From'} </span>
            {other}
          </span>
        </span>
      )
    } else if (t.isSplit) {
      what = (
        <StatusChip tone="line" className={GIVES_WAY}>
          <Split aria-hidden strokeWidth={2} />
          <span className="min-w-0 truncate">Split</span>
        </StatusChip>
      )
    } else if (t.budgetItemId) {
      what = (
        <CategoryChip color={lineColor} line={jarLine} icon={jarLine ? <JarNavIcon strokeWidth={2} /> : undefined}>
          {t.budgetItemName}
        </CategoryChip>
      )
    } else {
      // A label, not a button: assigning happens on Transactions.
      what = (
        <StatusChip tone="line" className={GIVES_WAY}>
          <span className="min-w-0 truncate">Unassigned</span>
        </StatusChip>
      )
    }
    const status = !isTransfer ? null : t.transferStatus === 'InTransit' ? (
      <StatusChip tone="line">In transit</StatusChip>
    ) : t.transferStatus === 'Returned' && cameBack ? (
      // Shown on its return date: its (i) names the day it left as well.
      <span className="inline-flex items-center gap-0.5">
        <StatusChip tone="bad">Returned</StatusChip>
        <InfoHint
          label={`About ${payee} on ${date}: returned`}
          buttonClassName={TITLE_HINT}
          align={phone ? 'center' : 'end'}
          fixed
          className="whitespace-normal"
        >
          Left on {formatDate(t.departedOn ?? t.date)}, before the opening balance of {formatDate(a.openingDate!)}, and came back on{' '}
          {formatDate(t.returnedOn!)}: the return adds it to the balance.
        </InfoHint>
      </span>
    ) : t.transferStatus === 'Returned' ? (
      <StatusChip tone="bad">Returned</StatusChip>
    ) : t.transferStatus === 'PendingReview' ? (
      <StatusChip tone="warn">Pending review</StatusChip>
    ) : null

    // The amount as this account sees it, in the row's own currency (`sign`): a transfer − when the
    // money left it and + when it came in (muted: it moved between your own accounts), income + in
    // green, the rest −.
    // Still waiting for its amount in the budget currency: a tag, not a button (the amount is
    // entered on Transactions), explained behind its (i) as Before opening is. Under the amount;
    // on the narrowest phones on the second line, after the date.
    const fxLine = phone && narrow
    const fxTag = t.fxPending && (
      <span className={`inline-flex items-center gap-0.5 ${fxLine ? '' : '-mr-1'}`}>
        <StatusChip tone="warn">Needs {budgetCurrency} amount</StatusChip>
        <InfoHint
          label={`About ${payee} on ${date}: needs ${budgetCurrency} amount`}
          buttonClassName={TITLE_HINT}
          align={fxLine ? 'center' : 'end'}
          fixed
          className="whitespace-normal"
        >
          In another currency. Not counted anywhere until you enter the amount in {budgetCurrency}.
        </InfoHint>
      </span>
    )
    const amount = (
      <div data-tx-amount="" className="flex min-w-0 flex-col items-end gap-[3px] text-right">
        <span
          className={`text-sm whitespace-nowrap tabular-nums ${
            notCounted
              ? 'font-semibold text-slate-400 line-through decoration-[color-mix(in_srgb,var(--color-slate-400)_70%,transparent)]'
              : isTransfer || t.fxPending
                ? 'font-semibold text-slate-500'
                : isIncome
                  ? 'font-[650] text-ok'
                  : 'font-[650] text-slate-900'
          }`}
        >
          {sign}
          {formatMoney(fromAmount(t.amount), t.currency)}
        </span>
        {beforeOpening && (
          <span className="-mr-1 inline-flex items-center gap-0.5 text-xs whitespace-nowrap text-slate-400">
            Before opening
            <InfoHint
              label={`About ${payee} on ${date}: before opening`}
              buttonClassName={TITLE_HINT}
              align="end"
              fixed
              // Its text wraps, whatever the line it hangs from.
              className="whitespace-normal"
            >
              Dated before the opening balance of {formatDate(a.openingDate!)}, which already includes it: kept as history, it doesn’t
              change the balance.
            </InfoHint>
          </span>
        )}
        {!fxLine && fxTag}
        {!t.fxPending && t.originalCurrency && t.originalAmount != null && (
          <span className={phone ? SMALL_PHONE : SMALL} title={`Paid in ${t.originalCurrency}`}>
            {formatForeign(t.originalAmount, t.originalCurrency)}
          </span>
        )}
        {!t.fxPending && t.budgetAmount != null && (
          <span className={phone ? SMALL_PHONE : SMALL}>Counts as {formatMoney(fromAmount(t.budgetAmount), budgetCurrency)} in the budget</span>
        )}
      </div>
    )

    const payeeEl = (
      <span className={`min-w-0 truncate text-sm font-semibold ${beforeOpening ? 'text-slate-500' : 'text-slate-900'}`}>{payee}</span>
    )
    // Before the opening date the chips' words step back a shade too (a category chip keeps its
    // colours: its words are already tinted).
    const catClass = `flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 ${beforeOpening ? '[&>span:not([style])]:text-slate-400!' : ''}`
    const dateEl = <span className={`whitespace-nowrap text-slate-400 tabular-nums ${phone ? 'text-xs' : 'text-[13px]'}`}>{date}</span>

    return (
      <li
        key={t.id}
        data-testid="tx-row"
        data-tx-id={t.id}
        className={`grid items-center not-first:border-t not-first:border-line ${
          phone
            ? 'min-h-[60px] grid-cols-[30px_minmax(0,1fr)_auto] gap-x-3 gap-y-[5px] py-[11px]'
            : 'min-h-14 grid-cols-[52px_30px_minmax(0,0.85fr)_minmax(0,1.15fr)_128px] gap-x-3.5 py-3'
        }`}
      >
        {phone ? (
          // Two lines: the payee and the amount, then the category (or the transfer and its
          // status) with the date.
          <>
            <div className="col-start-1 row-span-2 row-start-1">{tile}</div>
            <div className="col-start-2 row-start-1 flex min-w-0">{payeeEl}</div>
            <div className={`col-start-2 row-start-2 ${catClass}`}>
              {what}
              {isTransfer ? (
                // The dot after a route goes with the date: a date that wraps takes it along.
                <span className="inline-flex items-center gap-2 whitespace-nowrap">
                  <span aria-hidden className="text-xs text-slate-400">
                    ·
                  </span>
                  {dateEl}
                </span>
              ) : (
                dateEl
              )}
              {status}
              {fxLine && fxTag}
            </div>
            <div className="col-start-3 row-span-2 row-start-1">{amount}</div>
          </>
        ) : (
          <>
            {dateEl}
            {tile}
            {payeeEl}
            <div className={catClass}>
              {what}
              {status}
            </div>
            {amount}
          </>
        )}
      </li>
    )
  }

  return (
    // On an in-app change of account the title reads Loading… until the new one is in, never the
    // name of the account left (#344 P3-6).
    <AppShell
      active="accounts"
      title={shownAccount?.name ?? (account && loading ? 'Loading…' : 'Account')}
      back={{ to: '/accounts', label: 'Accounts' }}
    >
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
          {/* On the body's three columns: the hero over the list's two, In jars over Account details. */}
          <KpiRow tiles={jars || reserveJars ? 1 : 0} onGrid>
            <KpiTile
              hero
              label="Balance"
              hint={BALANCE_HINT}
              value={balanceMinor === null ? 'Not available' : formatMoney(balanceMinor, currency)}
              valueLabel={`${account.name} balance: ${balanceMinor === null ? 'not available' : formatMoney(balanceMinor, currency)}`}
              sub={heroSub(account)}
              // Alone, the hero keeps to the list's two columns on a wide screen and fills a narrower row.
              className={jars || reserveJars ? '' : '@min-[640px]:col-span-2!'}
            />
            {!jars && reserveJars && (
              // The tile's room while its figures load: the same tile, its words and figures kept
              // invisible (and hidden from screen readers), so the real one takes its place exactly.
              <KpiTile
                aria-hidden
                data-testid="in-jars-pending"
                label={'\u00a0'}
                icon={<JarNavIcon strokeWidth={1.8} />}
                hue="teal"
                value={<span className="invisible">€0.00</span>}
                extra={balanceMinor !== null ? <MiniBar pct={0} hue="teal" size="lg" /> : undefined}
                sub={balanceMinor !== null ? <span className="invisible">€0.00 not in jars</span> : undefined}
                strip="bar-sub"
                className="animate-pulse"
              />
            )}
            {jars && (
              <KpiTile
                label="In jars"
                icon={<JarNavIcon strokeWidth={1.8} />}
                hue="teal"
                value={formatMoney(jars.backed, currency)}
                extra={balanceMinor !== null ? <MiniBar pct={jars.pct} hue="teal" over={jars.over} size="lg" /> : undefined}
                sub={
                  jars.rest && (
                    <span className={`inline-flex items-center gap-1 tabular-nums ${jars.over ? 'font-semibold text-bad' : ''}`}>
                      {jars.rest.text}
                      <InfoHint label={jars.rest.label} buttonClassName={TITLE_HINT} align="end" className="whitespace-normal">
                        {jars.rest.hint}
                      </InfoHint>
                    </span>
                  )
                }
                strip="bar-sub"
              />
            )}
          </KpiRow>

          <div className="@container">
            <div className="grid grid-cols-1 items-start gap-4 @min-[900px]:grid-cols-3 @min-[900px]:gap-6">
              {/* The list first, so a phone (and a screen reader) reaches the transactions first. */}
              <section aria-labelledby={listHeadingId} className={`dash-palette ${DASH_CARD} @min-[900px]:col-span-2`}>
                <h2 id={listHeadingId} className={`flex min-h-8 items-center gap-1.5 ${CARD_TITLE}`}>
                  Transactions
                  {/* No badge on an empty list: the line under the title already says so. The
                      heading reads "Transactions, 10" (#344 P3-6): the comma is for the ear only. */}
                  {rows.length > 0 && (
                    <>
                      <span className="sr-only">,</span>{' '}
                      <span data-testid="account-tx-count" className={COUNT_BADGE}>
                        {rows.length}
                      </span>
                    </>
                  )}
                </h2>
                {rows.length === 0 ? (
                  <p className="pt-4 pb-3 text-center text-sm text-slate-500">No transactions on this account yet.</p>
                ) : (
                  <>
                    {months.map((m, i) => (
                      <div key={m.key}>
                        <h3
                          className={`${EYEBROW} pb-0.5 max-[699.98px]:pb-0 ${
                            i === 0 ? 'pt-3 max-[699.98px]:pt-2' : 'pt-[22px] max-[699.98px]:pt-[18px]'
                          }`}
                        >
                          {monthHeading(`${m.key}-01`)}
                        </h3>
                        <ul>{m.rows.map((r) => renderRow(r, account))}</ul>
                      </div>
                    ))}
                    {more && <div ref={sentinelRef} aria-hidden className="h-px" />}
                  </>
                )}
              </section>

              <section aria-labelledby={detailsHeadingId} className={`${DASH_CARD} @min-[900px]:sticky @min-[900px]:top-[92px]`}>
                <h2 id={detailsHeadingId} className={`flex min-h-8 items-center ${CARD_TITLE}`}>
                  Account details
                </h2>
                <div className="mt-3.5 flex min-w-0 items-center gap-3.5">
                  <TypeTile type={account.type} detail />
                  <div className="flex min-w-0 flex-col items-start gap-1.5">
                    <p className="text-base leading-[1.25] font-[650] text-slate-900">{ACCOUNT_TYPE_LABELS[account.type] ?? 'Other'}</p>
                    <HolderAvatars account={account} members={members} avatarClassName="size-6 shrink-0 text-xs" />
                  </div>
                </div>
                <dl className="mt-[18px] max-[699.98px]:mt-3.5">
                  <DetailRow label="Opening balance">
                    {formatMoney(fromAmount(account.openingBalance), currency)}
                    {account.openingDate && <span className="text-xs font-medium text-slate-400">On {formatDate(account.openingDate)}</span>}
                  </DetailRow>
                  {identifiers.map(([label, value]) => (
                    <DetailRow key={label} label={label}>
                      {label === 'IBAN' ? <Iban value={value} /> : value}
                    </DetailRow>
                  ))}
                </dl>
              </section>
            </div>
          </div>
        </>
      )}
    </AppShell>
  )
}

/**
 * One line of Account details: the label at the left, the value (and its small line) at the right.
 * The value is 14px, as in the mock-up; one too long for the line (an IBAN in a narrow column)
 * wraps at its own spaces into balanced lines.
 */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 border-t border-line py-2.5 max-[699.98px]:min-h-11">
      <dt className="shrink-0 text-[13px] text-slate-500">{label}</dt>
      <dd className="flex min-w-0 flex-col items-end gap-0.5 text-right text-sm font-semibold text-balance [overflow-wrap:anywhere] text-slate-900 tabular-nums">
        {children}
      </dd>
    </div>
  )
}

/**
 * An IBAN in groups of four, as banks print it (#344 P3-5): display only. The groups are spaced
 * by a margin, not by spaces, and a line may break only between them, so selecting or copying the
 * IBAN gives the stored value. One stored with its own spaces shows as stored.
 */
function Iban({ value }: { value: string }) {
  if (/\s/.test(value)) return <>{value}</>
  const groups = value.match(/.{1,4}/g) ?? [value]
  return (
    <span data-iban="" className="[overflow-wrap:normal] break-normal">
      {groups.map((g, i) => (
        <Fragment key={i}>
          {i > 0 && <wbr />}
          <span className={i > 0 ? 'ml-[0.32em]' : undefined}>{g}</span>
        </Fragment>
      ))}
    </span>
  )
}

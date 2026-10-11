import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  Archive,
  ArrowLeftRight,
  Check,
  Coins,
  Ellipsis,
  Flag,
  Pencil,
  Plus,
  Receipt,
  Repeat,
  SkipForward,
  StepForward,
  Trash2,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { Button, EmptyState, ErrorBanner } from '../components/ui'
import { KpiRow, KpiTile } from '../components/KpiTile'
import { GlassJar } from '../components/GlassJar'
import { InfoHint } from '../components/InfoHint'
import { MiniBar, StatusChip } from '../components/StatusChip'
import { ActionSheet, ROW_MENU_TRIGGER, RowMenu, type RowAction } from '../components/RowActions'
import { CARD_TITLE, DASH_CARD } from '../components/budget/card'
import { JarFormModal } from '../components/JarFormModal'
import { MoveMoneyModal } from '../components/MoveMoneyModal'
import { MarkCyclePaidModal } from '../components/jars/MarkCyclePaidModal'
import { DismissCycleModal } from '../components/jars/DismissCycleModal'
import { CompleteJarModal } from '../components/jars/CompleteJarModal'
import { ReopenJarModal } from '../components/jars/ReopenJarModal'
import { JarsIcon } from '../components/icons'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { readLedgers } from '../lib/jarLedgers'
import { useMediaQuery } from '../lib/useMediaQuery'
import { hueForIndex, type CategoryHue } from '../lib/categoryColors'
import type { AccountDto, JarAccountLedgerDto, JarDto } from '../types'
import { formatMoney, fromAmount } from '../lib/money'
import { jarAccounts, jarExamples, type JarExample } from '../lib/jarForm'
import { monthYear } from '../lib/dates'
import {
  byAttention,
  cadenceLabel,
  JAR_CHIP_TONE,
  jarCardChip,
  jarDate,
  jarDueLabel,
  jarHorizonLabel,
  jarLastCycleLabel,
  jarMonthLabel,
} from '../lib/jarStatus'

/** The (i) beside a card title, as on the Dashboard's cards: a 22px target, the icon at 15px. */
const TITLE_HINT =
  "relative -my-1 inline-grid size-[22px] place-items-center rounded-full text-slate-500 opacity-85 transition after:absolute after:-inset-[9px] after:content-[''] hover:bg-slate-500/10 hover:opacity-100"

/**
 * The Jars page (restyle PR 4, the approved "polished Warm" mock-up): one KPI row (what the jars
 * hold, and what went into them this month of what was planned), then one card per jar, the ones
 * that need attention first, ending with a tile to add one. A card shows the jar, its name, a chip
 * only when its state is worth calling out, what it holds of its target and one line: where the
 * plan is heading, or what needs doing. Everything else about a jar (the account it is held in,
 * this month's plan, how its last cycle ended) and its actions sit behind its ⋯: a menu on wider
 * screens, a bottom sheet on phones. Below the jars, each jar-backed account's unallocated money.
 */
export function JarsPage() {
  // Managing jars needs Admin+ (canWrite); others see them read-only.
  const { canWrite, budgetCurrency } = useAuth()
  const CURRENCY = budgetCurrency
  // The top bar has room for the page's Move money from 900px (AppShell's own breakpoint); below
  // it the button sits under the KPI row, as in the mock-up.
  const desktop = useMediaQuery('(min-width: 900px)')
  // Phones (the mock-ups' 700px breakpoint, as on the Dashboard): a jar's ⋯ opens a bottom sheet.
  const phone = useMediaQuery('(max-width: 699.98px)')
  const [jars, setJars] = useState<JarDto[]>([])
  const [accounts, setAccounts] = useState<AccountDto[]>([])
  // Whether the accounts list loaded: only then can "no account can hold a jar" be known.
  const [accountsKnown, setAccountsKnown] = useState(false)
  // Whether a new jar has an account to be held in (the form's own list): with none, the form can't save.
  const canHold = !accountsKnown || jarAccounts(accounts, CURRENCY).length > 0
  // Each jar-backed account's ledger — what's unallocated and whether its jars are backed (rule 70).
  const [ledgers, setLedgers] = useState<JarAccountLedgerDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The add / edit form lives in a modal; editingId switches it between modes.
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  // A jar's ⋯ Archive or Delete opens its edit form with that step already asked for.
  const [formConfirm, setFormConfirm] = useState<'archive' | 'delete' | undefined>(undefined)
  // The example a new jar starts from (the empty page's examples); none for a blank form.
  const [example, setExample] = useState<JarExample | undefined>(undefined)
  // The jar whose "Move money" modal is open: from its ⋯, or into it from the page's own button.
  const [moving, setMoving] = useState<{ jarId: string; fromPage: boolean } | null>(null)
  // W03: the cycle being marked paid (a jar and the cycle's deadline), and the jar whose missed
  // deadline is being dismissed.
  const [markingPaid, setMarkingPaid] = useState<{ jarId: string; deadline: string } | null>(null)
  const [dismissingId, setDismissingId] = useState<string | null>(null)
  // W04: the Goal jar being marked completed (rule 55).
  const [completingId, setCompletingId] = useState<string | null>(null)
  // O3c: the completed Goal being reopened.
  const [reopeningId, setReopeningId] = useState<string | null>(null)
  const gridHeadingId = useId()
  const unallocatedHeadingId = useId()
  // The New jar tile (or, once the last jar has gone, the empty page's New jar button).
  const newJarId = useId()
  const gridRef = useRef<HTMLDivElement>(null)
  // Set when a jar leaves the list (archived or deleted): the jar whose ⋯ takes focus next, or
  // null for the New jar button. The dialog would give focus back to the removed card's ⋯.
  const refocusAfterRemoval = useRef<{ jarId: string | null } | null>(null)
  const editingJar = useMemo(
    () => (editingId ? jars.find((f) => f.id === editingId) ?? null : null),
    [editingId, jars],
  )
  const movingJar = useMemo(
    () => (moving ? jars.find((f) => f.id === moving.jarId) ?? null : null),
    [moving, jars],
  )
  const markingPaidJar = useMemo(
    () => (markingPaid ? jars.find((f) => f.id === markingPaid.jarId) ?? null : null),
    [markingPaid, jars],
  )
  const dismissingJar = useMemo(
    () => (dismissingId ? jars.find((f) => f.id === dismissingId) ?? null : null),
    [dismissingId, jars],
  )
  const completingJar = useMemo(
    () => (completingId ? jars.find((f) => f.id === completingId) ?? null : null),
    [completingId, jars],
  )
  const reopeningJar = useMemo(
    () => (reopeningId ? jars.find((f) => f.id === reopeningId) ?? null : null),
    [reopeningId, jars],
  )

  const loadLedgers = useCallback(() => {
    api
      .get<JarAccountLedgerDto[]>('/jars/ledger')
      .then(({ data }) => setLedgers(readLedgers(data)))
      .catch(() => setLedgers([]))
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      api.get<JarDto[]>('/jars'),
      api
        .get<AccountDto[]>('/accounts')
        .then(({ data }) => (Array.isArray(data) ? data : null))
        .catch(() => null),
    ])
      .then(([f, acc]) => {
        if (cancelled) return
        setJars(f.data)
        setAccounts(acc ?? [])
        setAccountsKnown(acc !== null)
      })
      .catch(() => !cancelled && setError('Could not load your jars.'))
      .finally(() => !cancelled && setLoading(false))
    loadLedgers()
    return () => {
      cancelled = true
    }
  }, [loadLedgers])

  // Balances are derived from the ledger, so after any money move re-read the list.
  const refreshJars = useCallback(async () => {
    try {
      const { data } = await api.get<JarDto[]>('/jars')
      if (Array.isArray(data)) setJars(data)
    } catch {
      // Keep what's shown; the next load will catch up.
    }
    loadLedgers()
  }, [loadLedgers])

  const closeForm = useCallback(() => {
    setShowForm(false)
    setEditingId(null)
    setFormConfirm(undefined)
  }, [])

  function openAdd(from?: JarExample) {
    setEditingId(null)
    setFormConfirm(undefined)
    setExample(from)
    setError(null)
    setShowForm(true)
  }

  function startEdit(f: JarDto, confirm?: 'archive' | 'delete') {
    setEditingId(f.id)
    setFormConfirm(confirm)
    setError(null)
    setShowForm(true)
  }

  const onSaved = useCallback(
    (saved: JarDto, mode: 'created' | 'updated') => {
      setJars((prev) => (mode === 'updated' ? prev.map((f) => (f.id === saved.id ? saved : f)) : [...prev, saved]))
      closeForm()
      loadLedgers()
    },
    [closeForm, loadLedgers],
  )

  // Archived or deleted (rules 25, 27): the jar leaves the list; its lines were cancelled or
  // removed server-side, so the ledgers are re-read. Focus moves on to the card that takes its
  // place (or the one before it), else the New jar button, once the dialog has gone.
  const onArchived = useCallback(
    (archived: JarDto) => {
      const shown = byAttention(jars)
      const at = shown.findIndex(({ jar }) => jar.id === archived.id)
      const next = at < 0 ? undefined : (shown[at + 1] ?? shown[at - 1])
      refocusAfterRemoval.current = { jarId: next?.jar.id ?? null }
      setJars((prev) => prev.filter((x) => x.id !== archived.id))
      closeForm()
      loadLedgers()
    },
    [jars, closeForm, loadLedgers],
  )

  // Runs after the dialog's own clean-up (which tries the removed card's ⋯), as an update
  // effect runs after an unmount's.
  useEffect(() => {
    const target = refocusAfterRemoval.current
    if (!target) return
    refocusAfterRemoval.current = null
    const card = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[data-jar-id]') ?? []).find(
      (el) => el.dataset.jarId === target.jarId,
    )
    ;(card?.querySelector<HTMLElement>('[data-row-trigger]') ?? document.getElementById(newJarId))?.focus()
  }, [jars, newJarId])

  // Completed (rule 55): the jar stays listed, as the server now returns it, and keeps its money.
  const onCompleted = useCallback(
    (completed: JarDto) => {
      setJars((prev) => prev.map((f) => (f.id === completed.id ? completed : f)))
      setCompletingId(null)
      loadLedgers()
    },
    [loadLedgers],
  )

  // Reopened (O3c): the jar saves again, its plan replanted by the server from what it holds.
  const onReopened = useCallback(
    (reopened: JarDto) => {
      setJars((prev) => prev.map((f) => (f.id === reopened.id ? reopened : f)))
      setReopeningId(null)
      loadLedgers()
    },
    [loadLedgers],
  )

  const onMoved = useCallback(() => {
    setMoving(null)
    void refreshJars()
  }, [refreshJars])

  // A cycle closed (paid or dismissed): the server returns the jar as it now reads; its lines
  // were replanted, so the ledgers are re-read too.
  const onCycleChanged = useCallback(
    (changed: JarDto) => {
      setJars((prev) => prev.map((f) => (f.id === changed.id ? changed : f)))
      setMarkingPaid(null)
      setDismissingId(null)
      loadLedgers()
    },
    [loadLedgers],
  )

  const accountName = useCallback(
    (id: string) => accounts.find((a) => a.id === id)?.name ?? ledgers.find((l) => l.accountId === id)?.accountName ?? null,
    [accounts, ledgers],
  )

  // The KPI row: what's saved across the jars whose balance is known, and what went into them
  // this month of what their plans set aside (rule 14). An unavailable balance (rule 67) is left
  // out and called out, never counted as zero.
  const money = (minor: number) => formatMoney(minor, CURRENCY)
  const totalSavedMinor = useMemo(
    () => jars.reduce((s, f) => s + (f.currentBalance === null ? 0 : fromAmount(f.currentBalance)), 0),
    [jars],
  )
  const unavailableCount = useMemo(() => jars.filter((f) => f.currentBalance === null).length, [jars])
  const plannedMinor = useMemo(() => jars.reduce((s, f) => s + fromAmount(f.plannedThisMonth), 0), [jars])
  const contributedMinor = useMemo(() => jars.reduce((s, f) => s + fromAmount(f.contributedThisMonth), 0), [jars])
  const backedLedgers = useMemo(() => ledgers.filter((l) => l.jars.some((j) => !j.isArchived)), [ledgers])
  // A completed goal (rule 55) is still listed but no longer active.
  const activeCount = useMemo(() => jars.filter((f) => f.completedOn === null).length, [jars])
  const completedCount = jars.length - activeCount
  // The accounts the jars' money sits in, for the hero's (i).
  const holders = useMemo(() => {
    const names: string[] = []
    for (const j of jars) {
      const name = accountName(j.fundingAccountId)
      if (name && !names.includes(name)) names.push(name)
    }
    return names
  }, [jars, accountName])

  // Attention first, each jar keeping the colour of its place in the household's list (as on the
  // Dashboard's shelf).
  const ordered = useMemo(() => byAttention(jars), [jars])

  // The page's own Move money (the mock-up's top-bar action): the move dialog works within one
  // account, so it is offered when every jar sits in the same one. It starts from that account's
  // unallocated money into the jar that needs it most (any jar, or the money, can be chosen there).
  const pageMoveJar =
    canWrite && !loading && jars.length > 0 && jars.every((j) => j.fundingAccountId === jars[0].fundingAccountId)
      ? (ordered.find(({ jar }) => jar.completedOn === null) ?? ordered[0]).jar
      : null
  const moveButton = pageMoveJar && (
    <Button
      variant="secondary"
      onClick={() => {
        setError(null)
        setMoving({ jarId: pageMoveJar.id, fromPage: true })
      }}
      className="h-[38px] gap-[7px] rounded-[10px] border-slate-200 py-0 text-slate-900 shadow-[var(--shadow-frame)] max-[899.98px]:h-10 max-[899.98px]:px-3.5 dark:hover:bg-foreground/7"
    >
      <ArrowLeftRight aria-hidden className="size-4" />
      Move money
    </Button>
  )

  const heroHint = (
    <>
      The money in all your jars ({activeCount} active{completedCount > 0 ? `, ${completedCount} completed` : ''}).
      {holders.length > 0 && ` It sits in ${listNames(holders)} until a jar pays for something.`}
    </>
  )

  return (
    <AppShell active="jars" title="Jars" actions={desktop ? moveButton || undefined : undefined}>
      {/* No jars (or none could be loaded): nothing to sum, so no KPI row of zeros above the empty card. */}
      {(loading || jars.length > 0) && (
        <KpiRow tiles={1} onGrid>
          <KpiTile
            hero
            label="Total saved"
            hint={heroHint}
            value={money(totalSavedMinor)}
            valueLabel={`Total saved: ${money(totalSavedMinor)}`}
            sub={
              unavailableCount > 0 && (
                <span className="inline-flex items-start gap-1.5">
                  <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    {unavailableCount} jar{unavailableCount === 1 ? '' : 's'} with an unavailable balance {unavailableCount === 1 ? 'is' : 'are'} not
                    counted.
                  </span>
                </span>
              )
            }
          />
          <KpiTile
            label="This month"
            icon={<Coins strokeWidth={1.8} />}
            hue="emerald"
            value={money(contributedMinor)}
            sub={`of ${money(plannedMinor)} planned`}
            extra={<MiniBar pct={plannedMinor > 0 ? (contributedMinor / plannedMinor) * 100 : contributedMinor > 0 ? 100 : 0} hue="emerald" />}
            strip="bar"
          />
        </KpiRow>
      )}

      {!desktop && moveButton && <div className="flex justify-end">{moveButton}</div>}

      {error && !showForm && <ErrorBanner>{error}</ErrorBanner>}

      {loading && <p className="text-slate-500">Loading…</p>}

      {!loading && jars.length === 0 ? (
        <EmptyState
          icon={<JarsIcon className="h-6 w-6" />}
          title="No jars yet"
          description={!canWrite ? undefined : canHold ? 'Start from one of these, or make your own.' : 'A jar is held in an account. Add one first.'}
        >
          {canWrite && !canHold && (
            // The form can't save without an account to hold the jar (#325 review P3-1), so send
            // a new household there first rather than into a filled form it can't add.
            <Link
              to="/accounts"
              className="inline-flex items-center justify-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700"
            >
              Add an account
            </Link>
          )}
          {canWrite && canHold && (
            <>
              {/* One of each shape the form makes (jar setup plan, PR 3); each opens the form filled in. */}
              <div className="dash-palette grid w-full max-w-2xl gap-3 sm:grid-cols-3">
                {jarExamples().map((e, i) => (
                  <button
                    key={e.name}
                    type="button"
                    onClick={() => openAdd(e)}
                    aria-label={`${e.name}, ${exampleLine(e, CURRENCY)}`}
                    className="flex items-center gap-3 rounded-[10px] border border-slate-200/70 bg-surface px-3 py-2.5 text-left shadow-[var(--shadow-frame)] transition hover:border-brand-300 hover:bg-surface-2"
                  >
                    <GlassJar pct={0} hue={hueForIndex(i)} width={24} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-slate-900">{e.name}</span>
                      <span className="block truncate text-xs text-slate-500">{exampleLine(e, CURRENCY)}</span>
                    </span>
                  </button>
                ))}
              </div>
              <Button id={newJarId} onClick={() => openAdd()} aria-label="New jar">
                <Plus aria-hidden className="size-4" /> New jar
              </Button>
            </>
          )}
        </EmptyState>
      ) : (
        !loading && (
          <section aria-labelledby={gridHeadingId} className="@container">
            {/* The cards say what they are; the heading names the list for assistive tech. */}
            <h2 id={gridHeadingId} className="sr-only">
              Your jars
            </h2>
            <div ref={gridRef} className="dash-palette grid grid-cols-2 gap-4 @min-[640px]:gap-6 @min-[900px]:grid-cols-3">
              {ordered.map(({ jar: f, index }) => (
                <JarCard
                  key={f.id}
                  jar={f}
                  hue={hueForIndex(index)}
                  currency={CURRENCY}
                  heldIn={accountName(f.fundingAccountId)}
                  phone={phone}
                  actions={
                    canWrite
                      ? jarActions(f, {
                          onEdit: (confirm) => startEdit(f, confirm),
                          onMove: () => {
                            setError(null)
                            setMoving({ jarId: f.id, fromPage: false })
                          },
                          onMarkPaid: (deadline) => {
                            setError(null)
                            setMarkingPaid({ jarId: f.id, deadline })
                          },
                          onDismiss: () => {
                            setError(null)
                            setDismissingId(f.id)
                          },
                          onComplete: () => {
                            setError(null)
                            setCompletingId(f.id)
                          },
                          onReopen: () => {
                            setError(null)
                            setReopeningId(f.id)
                          },
                        })
                      : []
                  }
                />
              ))}
              {canWrite && (
                <button
                  id={newJarId}
                  type="button"
                  onClick={() => openAdd()}
                  className="flex min-h-[120px] flex-col items-center justify-center gap-2.5 rounded-2xl border-[1.5px] border-dashed border-slate-500/40 bg-surface/40 p-4 text-sm font-semibold text-slate-500 transition hover:bg-surface/70 hover:text-slate-900 max-[699.98px]:rounded-[14px]"
                >
                  <span aria-hidden className="grid size-10 place-items-center rounded-full bg-surface text-brand-700 shadow-card dark:text-brand-200">
                    <Plus className="size-[18px]" />
                  </span>
                  New jar
                </button>
              )}
            </div>
          </section>
        )
      )}

      {!loading && backedLedgers.length > 0 && (
        // Quiet, under the jars: as wide as one jar column where the grid has room (so each
        // amount sits near its account's name), the whole width on a phone.
        <div className="@container">
          <section
            aria-labelledby={unallocatedHeadingId}
            className={`${DASH_CARD} @min-[640px]:w-[calc((100%-24px)/2)] @min-[900px]:w-[calc((100%-48px)/3)]`}
          >
            <div className="flex items-center gap-1.5">
              <h2 id={unallocatedHeadingId} className={CARD_TITLE}>
                Unallocated
              </h2>
              <InfoHint label="About unallocated money" buttonClassName={TITLE_HINT}>
                Money in each account that isn&rsquo;t in a jar yet. Use Move money to divide it up.
              </InfoHint>
            </div>
            <ul className="mt-1.5 -mb-2.5">
              {backedLedgers.map((l) => (
                <li
                  key={l.accountId}
                  className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-slate-200/70 py-2.5 text-sm first:border-t-0"
                >
                  <span className="min-w-0 font-semibold text-slate-900">{l.accountName}</span>
                  {l.hasBackingDeficit && (
                    <span className="inline-flex items-center gap-1">
                      <StatusChip tone="bad">Jars exceed account money</StatusChip>
                      <InfoHint label={`About the shortfall in ${l.accountName}`} buttonClassName={TITLE_HINT} align="center">
                        Its positive jars add up to more than the account holds — move money out of a jar to cover the shortfall.
                      </InfoHint>
                    </span>
                  )}
                  <span className="ml-auto text-right whitespace-nowrap text-slate-500 tabular-nums">
                    {l.unallocated === null ? (
                      'Not available'
                    ) : (
                      <>
                        <span className="font-semibold text-slate-900">{formatMoney(fromAmount(l.unallocated), l.currency || CURRENCY)}</span>{' '}
                        unallocated
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {/* Add / edit jar — the shared form, mounted only while open so its focus trap engages. */}
      {showForm && canWrite && (
        <JarFormModal
          jar={editingJar}
          example={editingJar ? undefined : example}
          accounts={accounts}
          currency={CURRENCY}
          onClose={closeForm}
          onSaved={onSaved}
          onArchived={onArchived}
          onDeleted={onArchived}
          confirm={editingJar ? formConfirm : undefined}
        />
      )}

      {movingJar && moving && canWrite && (
        <MoveMoneyModal
          jar={movingJar}
          fromPage={moving.fromPage}
          currency={CURRENCY}
          accounts={accounts}
          onClose={() => setMoving(null)}
          onMoved={onMoved}
        />
      )}

      {markingPaidJar && markingPaid && canWrite && (
        <MarkCyclePaidModal
          jar={markingPaidJar}
          deadline={markingPaid.deadline}
          currency={CURRENCY}
          onClose={() => setMarkingPaid(null)}
          onMarked={onCycleChanged}
        />
      )}

      {completingJar && canWrite && (
        <CompleteJarModal jar={completingJar} currency={CURRENCY} onClose={() => setCompletingId(null)} onCompleted={onCompleted} />
      )}

      {reopeningJar && canWrite && (
        <ReopenJarModal jar={reopeningJar} currency={CURRENCY} onClose={() => setReopeningId(null)} onReopened={onReopened} />
      )}

      {dismissingJar && !markingPaid && canWrite && (
        <DismissCycleModal
          jar={dismissingJar}
          currency={CURRENCY}
          onClose={() => setDismissingId(null)}
          onDismissed={onCycleChanged}
          onMarkPaidInstead={() => {
            if (dismissingJar.deadline) setMarkingPaid({ jarId: dismissingJar.id, deadline: dismissingJar.deadline })
            setDismissingId(null)
          }}
        />
      )}
    </AppShell>
  )
}

interface JarHandlers {
  /** Edit; with `confirm`, the form opens with Archive or Delete already asked for. */
  onEdit: (confirm?: 'archive' | 'delete') => void
  onMove: () => void
  /** W03: mark the cycle due on the given date paid (the open cycle, or the last closed one without a payment). */
  onMarkPaid: (deadline: string) => void
  /** W03: dismiss the Deadline-missed notice (rule 20). */
  onDismiss: () => void
  /** W04: mark a Goal jar completed (rule 55). */
  onComplete: () => void
  /** O3c: reopen a completed Goal. */
  onReopen: () => void
}

/**
 * A jar's actions, in its ⋯ menu (and phone sheet), each opening the dialog it always did: the
 * ending first (Mark completed, or Reopen), the cycle's (Mark paid, Record the payment, Dismiss),
 * then Move money and Edit, and after a divider Archive (and Delete, for a jar that never held
 * money), which open the edit form with that step asked for. Every one opens a dialog, which gives
 * focus back to the ⋯ when it closes.
 */
function jarActions(jar: JarDto, h: JarHandlers): RowAction[] {
  const balanceKnown = jar.currentBalance !== null
  // W03: a Recurring jar with an open cycle can be marked paid at any time (rule 83); the
  // missed-deadline notice can also be dismissed (rule 20). A last cycle that rolled forward
  // funded but never had its payment recorded, or one waiting for its deadline, can still be given one.
  const recurring = jar.recurMonths !== null && jar.deadline !== null && jar.status !== 'Unavailable'
  const missed = jar.status === 'DeadlineMissed' || jar.status === 'FundedLate'
  const unpaidLastCycle =
    jar.lastCycle && (jar.lastCycle.outcome === 'Funded' || jar.lastCycle.outcome === 'Waiting') ? jar.lastCycle : null
  // W04: a Goal can be marked completed (rule 55) while its balance is known; an overdrawn one
  // opens the dialog only to say how much to cover first (rule 56, P41; O3a). A completed jar
  // offers Reopen (O3c), Move money and Edit.
  const completed = jar.completedOn !== null
  const canComplete = !completed && jar.recurMonths === null && jar.status !== 'Unavailable' && balanceKnown
  const canReopen = completed && !jar.isArchived

  const actions: RowAction[] = []
  if (canComplete) actions.push({ key: 'complete', label: 'Mark completed', icon: <Check aria-hidden />, after: 'dialog', onSelect: h.onComplete })
  if (canReopen) actions.push({ key: 'reopen', label: 'Reopen', icon: <Undo2 aria-hidden />, after: 'dialog', onSelect: h.onReopen })
  if (recurring) {
    actions.push({ key: 'paid', label: 'Mark paid', icon: <Check aria-hidden />, after: 'dialog', onSelect: () => h.onMarkPaid(jar.deadline!) })
  }
  if (unpaidLastCycle) {
    actions.push({
      key: 'record',
      label: 'Record the payment',
      // Which cycle: the last one, whose deadline the visible words leave to the ⋯'s note.
      ariaLabel: `Record the payment for ${jar.name}'s cycle due ${jarDate(unpaidLastCycle.deadline, jar.monthOnly)}`,
      icon: <Receipt aria-hidden />,
      after: 'dialog',
      onSelect: () => h.onMarkPaid(unpaidLastCycle.deadline),
    })
  }
  if (recurring && missed) {
    actions.push({
      key: 'dismiss',
      label: 'Dismiss',
      // What is dismissed: the visible word leaves it to the chip and the ⋯'s note.
      ariaLabel: `Dismiss ${jar.name}'s missed deadline`,
      icon: <StepForward aria-hidden />,
      after: 'dialog',
      onSelect: h.onDismiss,
    })
  }
  actions.push({ key: 'move', label: 'Move money', icon: <ArrowLeftRight aria-hidden />, after: 'dialog', onSelect: h.onMove })
  actions.push({ key: 'edit', label: 'Edit', icon: <Pencil aria-hidden />, after: 'dialog', onSelect: () => h.onEdit() })
  actions.push({ key: 'archive', label: 'Archive', icon: <Archive aria-hidden />, after: 'dialog', separatorBefore: true, onSelect: () => h.onEdit('archive') })
  // Rule 27: only a jar that has never held money can be deleted (any other is archived).
  if (jar.canDelete) {
    actions.push({ key: 'delete', label: 'Delete', icon: <Trash2 aria-hidden />, danger: true, after: 'dialog', onSelect: () => h.onEdit('delete') })
  }
  return actions
}

/** The card's one line under the amount: where the plan is heading, or what needs doing. */
interface CardLine {
  Icon: LucideIcon
  text: string
  /** A missed deadline's shortfall, in the bad red. */
  bad?: boolean
}

/**
 * The card's line, in the words of lib/jarStatus, only what the chip doesn't already say: a
 * missed deadline's shortfall, what a completed jar still holds, a skipped month (rule 60), else
 * the horizon (Due … · yearly, Needed by …, €50.00 every month). None for an unavailable balance
 * (the amount says "Not available"), a jar that needs a plan or one funded late (their chips say
 * it; what to do and the deadline's date are in the ⋯'s note).
 */
function cardLine(jar: JarDto, currency: string, horizon: string | null): CardLine | null {
  switch (jar.status) {
    case 'Unavailable':
    case 'Unscheduled':
      return null
    case 'Completed': {
      // Rule 56: a completed jar keeps what it holds until the user moves it (the chip says Completed).
      const left = fromAmount(jar.currentBalance ?? 0)
      return left > 0 ? { Icon: ArrowLeftRight, text: `${formatMoney(left, currency)} left to move` } : null
    }
  }
  if (jar.skippedThisMonth) return { Icon: SkipForward, text: jarMonthLabel(jar, currency) }
  if (jar.status === 'DeadlineMissed' && jar.deadline) {
    return { Icon: TriangleAlert, text: `${formatMoney(fromAmount(jar.shortfall ?? 0), currency)} short`, bad: true }
  }
  if (jar.status === 'FundedLate') return null
  if (horizon) return { Icon: jar.recurMonths !== null || jar.status === 'Ongoing' ? Repeat : Flag, text: horizon }
  return null
}

/**
 * What the ⋯'s note (and the phone sheet's description) adds to the card, one fact a line and
 * none the card or its chip already shows: the account it is held in; the target, when the
 * amount reads "Not available"; the horizon when the card shows something else, or the exact day
 * a phone's card leaves out; a missed or late deadline's date; this month's plan (rule 14), what
 * would give a jar a plan, or a funded jar's surplus; and how its last cycle ended (W03).
 */
function noteLines(
  jar: JarDto,
  currency: string,
  heldIn: string | null,
  horizon: string | null,
  cardHorizon: string | null,
  line: CardLine | null,
): string[] {
  const lines: string[] = []
  if (heldIn) lines.push(`Held in ${heldIn}`)
  if (jar.currentBalance === null && jar.targetAmount > 0) lines.push(`Target ${formatMoney(fromAmount(jar.targetAmount), currency)}`)
  if (horizon && line?.text !== cardHorizon) lines.push(horizon)
  else if (horizon !== cardHorizon) lines.push(jarDueLabel(jar) ?? '')
  const late = (jar.status === 'DeadlineMissed' || jar.status === 'FundedLate') && jar.deadline
  if (late) lines.push(`Deadline ${jarDate(jar.deadline!, jar.monthOnly)}`)
  const month = monthNote(jar, currency, !!late)
  if (month) lines.push(month)
  const lastCycle = jarLastCycleLabel(jar, currency)
  if (lastCycle) lines.push(lastCycle)
  return lines.filter(Boolean)
}

/**
 * This month's line for the ⋯'s note, unless the card says it (an unavailable balance, a
 * completed jar, a skipped month) or the chip and the deadline line do (a missed or late
 * deadline). A funded jar with nothing to plan only adds its surplus, if any (the chip says
 * Funded); a jar that needs a plan says what would give it one.
 */
function monthNote(jar: JarDto, currency: string, late: boolean): string | null {
  if (jar.status === 'Unavailable' || jar.status === 'Completed' || late) return null
  if (jar.status === 'Unscheduled') return jarMonthLabel(jar, currency)
  if (jar.skippedThisMonth) return null
  if (jar.status === 'FullyFunded' && fromAmount(jar.plannedThisMonth) <= 0) {
    const excess = fromAmount(jar.currentBalance ?? 0) - fromAmount(jar.targetAmount)
    return excess > 0 ? `${formatMoney(excess, currency)} above target` : null
  }
  return jarMonthLabel(jar, currency)
}

function JarCard({
  jar,
  hue,
  currency,
  heldIn,
  phone,
  actions,
}: {
  jar: JarDto
  hue: CategoryHue
  currency: string
  heldIn: string | null
  /** A phone: the ⋯ opens a bottom sheet instead of a menu. */
  phone: boolean
  /** None for a read-only login: no ⋯, only an (i) with the note. */
  actions: RowAction[]
}) {
  const nameId = useId()
  const [sheetOpen, setSheetOpen] = useState(false)
  // Null = the account's balance is unavailable (rule 67): shown as such, never as zero.
  const balanceMinor = jar.currentBalance === null ? null : fromAmount(jar.currentBalance)
  const targetMinor = fromAmount(jar.targetAmount)
  const pct =
    targetMinor > 0 && balanceMinor !== null
      ? Math.min(100, Math.max(0, Math.round((balanceMinor / targetMinor) * 100)))
      : 0
  const chip = jarCardChip(jar)
  const horizon = jarHorizonLabel(jar, currency)
  // A phone's narrow card names the month the money is due, as the mock-up does ("Due Dec 2026 ·
  // yearly"), so the line fits; the exact day is in the ⋯'s note.
  const cardHorizon = phone ? jarHorizonLabel(jar, currency, { month: true }) : horizon
  const line = cardLine(jar, currency, cardHorizon)
  const notes = noteLines(jar, currency, heldIn, horizon, cardHorizon, line)
  const note: ReactNode =
    notes.length > 0 ? (
      <>
        {notes.map((t, i) => (
          // The space between the lines keeps them apart in the text a screen reader reads. In
          // the ⋯ menu a long line wraps, so the menu stays about the width of its items.
          <Fragment key={i}>
            {i > 0 && ' '}
            <span className={phone ? 'block' : 'block max-w-[216px] text-balance'}>{t}</span>
          </Fragment>
        ))}
      </>
    ) : undefined
  const menuLabel = `${jar.name}: more actions`

  let menu: ReactNode = null
  if (actions.length > 0) {
    menu = phone ? (
      <ActionSheet title={jar.name} description={note} actions={actions} open={sheetOpen} onOpenChange={setSheetOpen}>
        <button type="button" data-row-trigger="" aria-label={menuLabel} className={ROW_MENU_TRIGGER}>
          <Ellipsis aria-hidden strokeWidth={1.8} className="size-[18px]" />
        </button>
      </ActionSheet>
    ) : (
      <RowMenu label={menuLabel} actions={actions} note={note} />
    )
  } else if (note) {
    // A read-only login has no ⋯: what its note says sits behind an (i) in the same place.
    menu = (
      <span className="inline-grid size-8 place-items-center">
        <InfoHint label={`About ${jar.name}`} buttonClassName={TITLE_HINT} align="end">
          {note}
        </InfoHint>
      </span>
    )
  }

  // The card lays itself out by its own width: from 250px the jar stands at the left of the
  // text (desktop, a tablet), narrower it stands on top with the ⋯ in the corner (a phone's two
  // columns); from 340px the chip fits beside the name, narrower it takes a line of its own.
  // Beside the jar, the text starts at the top and the jar stays centred in the card, so the
  // names in a row line up whatever each card's line count (the name's line is the header's
  // 28px, whether or not the chip has wrapped under it).
  return (
    <article
      aria-labelledby={nameId}
      data-jar-id={jar.id}
      className="@container/jar relative grid min-w-0 rounded-2xl border border-slate-200/70 bg-surface shadow-card max-[699.98px]:rounded-[14px]"
    >
      <div className="grid grid-cols-1 content-start gap-3 px-3.5 py-4 @min-[250px]/jar:grid-cols-[64px_minmax(0,1fr)] @min-[250px]/jar:content-stretch @min-[250px]/jar:items-start @min-[250px]/jar:gap-[18px] @min-[250px]/jar:py-5 @min-[250px]/jar:pr-5 @min-[250px]/jar:pl-[18px]">
        {/* One name for the art: the progressbar says how full; the drawing itself is hidden. */}
        <div
          role="progressbar"
          aria-label={`${jar.name} funding progress`}
          aria-valuenow={pct}
          aria-valuetext={`${pct}% funded`}
          aria-valuemin={0}
          aria-valuemax={100}
          className="w-fit @min-[250px]/jar:self-center @min-[250px]/jar:justify-self-center"
        >
          <GlassJar pct={pct} hue={hue} width={60} />
        </div>
        <div className="flex min-w-0 flex-col items-start gap-1 @min-[250px]/jar:gap-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 self-stretch @min-[250px]/jar:min-h-7">
            <h3
              id={nameId}
              className="min-w-0 flex-1 text-sm leading-[1.3] font-[650] tracking-[-0.01em] text-slate-900 @min-[250px]/jar:truncate @min-[250px]/jar:text-base @min-[250px]/jar:leading-7"
            >
              {jar.name}
            </h3>
            {chip && (
              <span className="order-3 flex basis-full @min-[340px]/jar:order-none @min-[340px]/jar:basis-auto">
                <StatusChip tone={JAR_CHIP_TONE[chip.tone]}>{chip.label}</StatusChip>
              </span>
            )}
            {menu && (
              <div className="absolute top-1.5 right-1.5 @min-[250px]/jar:static @min-[250px]/jar:order-2 @min-[250px]/jar:-my-1 @min-[250px]/jar:-mr-2 @min-[250px]/jar:-ml-0.5 @min-[340px]/jar:order-none">
                {menu}
              </div>
            )}
          </div>
          <p className="flex flex-wrap items-baseline gap-x-[5px] tabular-nums @min-[250px]/jar:-mt-0.5 @min-[250px]/jar:gap-x-1.5">
            {balanceMinor === null ? (
              <span className="text-sm font-semibold text-slate-500 @min-[250px]/jar:text-base">Not available</span>
            ) : (
              <strong
                className={`text-lg leading-[1.4] font-bold tracking-[-0.02em] @min-[250px]/jar:text-[22px] ${
                  balanceMinor < 0 ? 'text-bad' : 'text-slate-900'
                }`}
              >
                {formatMoney(balanceMinor, currency)}
              </strong>
            )}
            {/* Without a balance there is nothing to measure against: the target is in the ⋯'s note. */}
            {targetMinor > 0 && balanceMinor !== null && <span className="text-[13px] text-slate-500">of {formatMoney(targetMinor, currency)}</span>}
          </p>
          {line && (
            <p
              className={`flex items-start gap-[5px] text-xs leading-[1.4] @min-[250px]/jar:gap-1.5 @min-[250px]/jar:text-[13px] ${
                line.bad ? 'font-semibold text-bad' : 'text-slate-500'
              }`}
            >
              <line.Icon aria-hidden strokeWidth={2} className={`mt-px size-[13px] shrink-0 @min-[250px]/jar:size-3.5 ${line.bad ? '' : 'text-slate-400'}`} />
              <span className="text-balance">{keepCadence(line.text)}</span>
            </p>
          )}
        </div>
      </div>
    </article>
  )
}

/**
 * A horizon line whose cadence is never left alone on a line of a narrow card: a one-word cadence
 * stays with its date ("Due Dec / 2026 · yearly"), a longer one stays whole ("Due Dec 2026 · /
 * every 6 months").
 */
function keepCadence(text: string): string {
  const at = text.lastIndexOf(' · ')
  if (at < 0) return text
  const cadence = text.slice(at + 3)
  return cadence.includes(' ')
    ? `${text.slice(0, at)}\u00a0· ${cadence.replaceAll(' ', '\u00a0')}`
    : `${text.slice(0, at)}\u00a0·\u00a0${cadence}`
}

/** "A", "A and B", "A, B and C". */
function listNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** An example jar in a few words: "€600.00 · yearly", "€1,500.00 · Jul 2027", "€50.00 a month". */
function exampleLine(e: JarExample, currency: string): string {
  if (e.fixedMonthly) return `${formatMoney(fromAmount(Number(e.monthly)), currency)} a month`
  const target = formatMoney(fromAmount(Number(e.target)), currency)
  return e.repeats > 0 ? `${target} · ${cadenceLabel(e.repeats)}` : `${target} · ${monthYear(e.month)}`
}

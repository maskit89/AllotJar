import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { Badge, Button, Card, EmptyState, ErrorBanner } from '../components/ui'
import { Hero } from '../components/Hero'
import { Jar } from '../components/Jar'
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
import { hueColor, hueForIndex, hueTint, type CategoryHue } from '../lib/categoryColors'
import type { AccountDto, JarAccountLedgerDto, JarDto } from '../types'
import { formatMoney, fromAmount } from '../lib/money'
import { jarAccounts, jarExamples, type JarExample } from '../lib/jarForm'
import { monthYear } from '../lib/dates'
import { cadenceLabel, jarDate, jarHorizonLabel, jarLastCycleLabel, jarMonthLabel, jarStatusChip } from '../lib/jarStatus'

export function JarsPage() {
  // Managing jars needs Admin+ (canWrite); others see them read-only.
  const { canWrite, budgetCurrency } = useAuth()
  const CURRENCY = budgetCurrency
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
  // The example a new jar starts from (the empty page's examples); none for a blank form.
  const [example, setExample] = useState<JarExample | undefined>(undefined)
  // The jar whose "Move money" modal is open.
  const [movingId, setMovingId] = useState<string | null>(null)
  // W03: the cycle being marked paid (a jar and the cycle's deadline), and the jar whose missed
  // deadline is being dismissed.
  const [markingPaid, setMarkingPaid] = useState<{ jarId: string; deadline: string } | null>(null)
  const [dismissingId, setDismissingId] = useState<string | null>(null)
  // W04: the Goal jar being marked completed (rule 55).
  const [completingId, setCompletingId] = useState<string | null>(null)
  // O3c: the completed Goal being reopened.
  const [reopeningId, setReopeningId] = useState<string | null>(null)
  const editingJar = useMemo(
    () => (editingId ? jars.find((f) => f.id === editingId) ?? null : null),
    [editingId, jars],
  )
  const movingJar = useMemo(
    () => (movingId ? jars.find((f) => f.id === movingId) ?? null : null),
    [movingId, jars],
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
  }, [])

  function openAdd(from?: JarExample) {
    setEditingId(null)
    setExample(from)
    setError(null)
    setShowForm(true)
  }

  function startEdit(f: JarDto) {
    setEditingId(f.id)
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
  // removed server-side, so the ledgers are re-read.
  const onArchived = useCallback(
    (archived: JarDto) => {
      setJars((prev) => prev.filter((x) => x.id !== archived.id))
      closeForm()
      loadLedgers()
    },
    [closeForm, loadLedgers],
  )

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
    setMovingId(null)
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

  // Hero totals — what's saved across the jars whose balance is known, and what their plans
  // set aside this month (rule 14). An unavailable balance (rule 67) is left out and called
  // out, never counted as zero.
  const totalSavedMinor = useMemo(
    () => jars.reduce((s, f) => s + (f.currentBalance === null ? 0 : fromAmount(f.currentBalance)), 0),
    [jars],
  )
  const unavailableCount = useMemo(() => jars.filter((f) => f.currentBalance === null).length, [jars])
  const monthlyMinor = useMemo(
    () => jars.reduce((s, f) => s + fromAmount(f.plannedThisMonth), 0),
    [jars],
  )
  const backedLedgers = useMemo(() => ledgers.filter((l) => l.jars.some((j) => !j.isArchived)), [ledgers])
  // A completed goal (rule 55) is still listed but no longer active.
  const activeCount = useMemo(() => jars.filter((f) => f.completedOn === null).length, [jars])

  return (
    <AppShell active="jars" title="Jars">
      <Hero
        eyebrow="Total saved"
        amount={formatMoney(totalSavedMinor, CURRENCY)}
        amountLabel={`Total saved: ${formatMoney(totalSavedMinor, CURRENCY)}`}
        tiles={[
          { label: 'This month', value: `+${formatMoney(monthlyMinor, CURRENCY)}` },
          { label: 'Active jars', value: `${activeCount}` },
        ]}
        footnote={
          unavailableCount > 0 ? (
            <span className="inline-flex items-center rounded-full bg-black/[0.18] px-[15px] py-2 text-[13px] font-medium">
              {unavailableCount} jar{unavailableCount === 1 ? '' : 's'} with an unavailable balance {unavailableCount === 1 ? 'is' : 'are'} not counted.
            </span>
          ) : undefined
        }
      />

      {error && !showForm && <ErrorBanner>{error}</ErrorBanner>}

      {loading && <p className="text-slate-500">Loading…</p>}

      {!loading && backedLedgers.length > 0 && (
        <Card as="section" aria-labelledby="unallocated-heading" className="p-5">
          <h2 id="unallocated-heading" className="text-base font-bold tracking-[-0.01em] text-slate-900">Unallocated</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Money in each account that isn&rsquo;t in a jar yet. Use Move money on a jar to divide it up.
          </p>
          <ul className="mt-3 space-y-1.5">
            {backedLedgers.map((l) => (
              <li key={l.accountId} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="tabular-nums text-slate-700">
                  <span className="font-semibold text-slate-900">{l.accountName}</span>:{' '}
                  {l.unallocated === null ? 'not available' : `${formatMoney(fromAmount(l.unallocated), l.currency || CURRENCY)} unallocated`}
                </span>
                {l.hasBackingDeficit && (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="rose">Jars exceed account money</Badge>
                    <span className="text-xs text-slate-500">
                      Its positive jars add up to more than the account holds — move money out of a jar to cover the shortfall.
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

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
              <div className="grid w-full max-w-2xl gap-3 sm:grid-cols-3">
                {jarExamples().map((e, i) => (
                  <button
                    key={e.name}
                    type="button"
                    onClick={() => openAdd(e)}
                    aria-label={`${e.name}, ${exampleLine(e, CURRENCY)}`}
                    className="flex items-center gap-3 rounded-xl border border-slate-200 bg-surface px-3 py-3 text-left transition hover:border-brand-300 hover:bg-slate-50"
                  >
                    <span aria-hidden className="h-8 w-2 shrink-0 rounded-full" style={{ background: hueColor(hueForIndex(i)) }} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-slate-800">{e.name}</span>
                      <span className="block truncate text-xs text-slate-500">{exampleLine(e, CURRENCY)}</span>
                    </span>
                  </button>
                ))}
              </div>
              <Button onClick={() => openAdd()} aria-label="New jar">
                <span aria-hidden className="text-base leading-none">+</span> New jar
              </Button>
            </>
          )}
        </EmptyState>
      ) : (
        !loading && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-base font-bold tracking-[-0.01em] text-slate-900">Your jars</h2>
              {canWrite && (
                <Button onClick={() => openAdd()} aria-label="New jar">
                  <span aria-hidden className="text-base leading-none">+</span> New jar
                </Button>
              )}
            </div>
            <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))]">
              {jars.map((f, i) => (
                <JarCard
                  key={f.id}
                  jar={f}
                  hue={hueForIndex(i)}
                  currency={CURRENCY}
                  heldIn={accountName(f.fundingAccountId)}
                  onEdit={() => startEdit(f)}
                  onMove={() => {
                    setError(null)
                    setMovingId(f.id)
                  }}
                  onMarkPaid={(deadline) => {
                    setError(null)
                    setMarkingPaid({ jarId: f.id, deadline })
                  }}
                  onDismiss={() => {
                    setError(null)
                    setDismissingId(f.id)
                  }}
                  onComplete={() => {
                    setError(null)
                    setCompletingId(f.id)
                  }}
                  onReopen={() => {
                    setError(null)
                    setReopeningId(f.id)
                  }}
                  canManage={canWrite}
                />
              ))}
            </div>
          </section>
        )
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
        />
      )}

      {movingJar && canWrite && (
        <MoveMoneyModal jar={movingJar} currency={CURRENCY} accounts={accounts} onClose={() => setMovingId(null)} onMoved={onMoved} />
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

function JarCard({
  jar,
  hue,
  currency,
  heldIn,
  onEdit,
  onMove,
  onMarkPaid,
  onDismiss,
  onComplete,
  onReopen,
  canManage,
}: {
  jar: JarDto
  hue: CategoryHue
  currency: string
  heldIn: string | null
  onEdit: () => void
  onMove: () => void
  /** W03: mark the cycle due on the given date paid (the open cycle, or the last closed one without a payment). */
  onMarkPaid: (deadline: string) => void
  /** W03: dismiss the Deadline-missed notice (rule 20). */
  onDismiss: () => void
  /** W04: mark a Goal jar completed (rule 55). */
  onComplete: () => void
  /** O3c: reopen a completed Goal. */
  onReopen: () => void
  canManage: boolean
}) {
  // Null = the account's balance is unavailable (rule 67): shown as such, never as zero.
  const balanceMinor = jar.currentBalance === null ? null : fromAmount(jar.currentBalance)
  const targetMinor = fromAmount(jar.targetAmount)
  const pct =
    targetMinor > 0 && balanceMinor !== null
      ? Math.min(100, Math.max(0, Math.round((balanceMinor / targetMinor) * 100)))
      : 0
  const chip = jarStatusChip(jar.status)
  const horizon = jarHorizonLabel(jar, currency)
  const lastCycle = jarLastCycleLabel(jar, currency)
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
  const canComplete = !completed && jar.recurMonths === null && jar.status !== 'Unavailable' && balanceMinor !== null
  const canReopen = completed && !jar.isArchived

  return (
    <Card className="flex gap-4 p-5">
      <Jar hue={hue} pct={pct} size="card" showPct={false} label={`${jar.name}: ${pct}% funded`} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate text-[15px] font-semibold text-slate-900">{jar.name}</h3>
          <div className="flex shrink-0 items-center gap-1.5">
            {chip && <Badge tone={chip.tone}>{chip.label}</Badge>}
            {/* The % pill is redundant next to "Funded" and meaningless without a balance. */}
            {targetMinor > 0 && balanceMinor !== null && jar.status !== 'FullyFunded' && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-600">
                {pct}%
              </span>
            )}
          </div>
        </div>

        <div className="mt-1 flex items-baseline gap-1.5 tabular-nums">
          {balanceMinor === null ? (
            <span className="text-[19px] font-bold text-slate-500">Not available</span>
          ) : (
            <span className="text-[19px] font-bold text-slate-900">{formatMoney(balanceMinor, currency)}</span>
          )}
          {targetMinor > 0 && <span className="text-[13px] text-slate-500">of {formatMoney(targetMinor, currency)}</span>}
        </div>
        {heldIn && <div className="mt-0.5 text-xs text-slate-500">Held in {heldIn}</div>}

        <div
          role="progressbar"
          aria-label={`${jar.name} funding progress`}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          className="mt-2.5 h-2 overflow-hidden rounded-full"
          style={{ background: hueTint(hue) }}
        >
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: hueColor(hue) }} />
        </div>

        {/* The lines run the card's full width, the actions sit in a row underneath. */}
        <div className="mt-3 flex flex-col gap-2.5">
          <span className="min-w-0 text-[12.5px] font-medium tabular-nums text-slate-500">
            <span className={`block ${missed ? 'text-rose-700 dark:text-rose-300' : ''}`}>{jarMonthLabel(jar, currency)}</span>
            {horizon && <span className="block text-[11.5px] font-normal">{horizon}</span>}
            {lastCycle && <span className="block text-[11.5px] font-normal">{lastCycle}</span>}
            {unpaidLastCycle && canManage && (
              <button
                type="button"
                onClick={() => onMarkPaid(unpaidLastCycle.deadline)}
                aria-label={`Record the payment for ${jar.name}'s cycle due ${jarDate(unpaidLastCycle.deadline, jar.monthOnly)}`}
                className="block text-[11.5px] font-semibold text-slate-500 underline transition hover:text-brand-700 dark:hover:text-brand-200"
              >
                Record the payment
              </button>
            )}
          </span>
          {canManage && (
            <span className="flex flex-wrap justify-end gap-x-4 gap-y-1">
              {recurring && missed && (
                <button
                  type="button"
                  onClick={onDismiss}
                  aria-label={`Dismiss ${jar.name}'s missed deadline`}
                  className="text-[12.5px] font-semibold text-slate-500 transition hover:text-brand-700 dark:hover:text-brand-200"
                >
                  Dismiss
                </button>
              )}
              {canComplete && (
                <button
                  type="button"
                  onClick={onComplete}
                  aria-label={`Mark ${jar.name} completed`}
                  className="text-[12.5px] font-semibold text-slate-500 transition hover:text-brand-700 dark:hover:text-brand-200"
                >
                  Mark completed
                </button>
              )}
              {canReopen && (
                <button
                  type="button"
                  onClick={onReopen}
                  aria-label={`Reopen ${jar.name}`}
                  className="text-[12.5px] font-semibold text-slate-500 transition hover:text-brand-700 dark:hover:text-brand-200"
                >
                  Reopen
                </button>
              )}
              {recurring && (
                <button
                  type="button"
                  onClick={() => onMarkPaid(jar.deadline!)}
                  aria-label={`Mark ${jar.name} paid`}
                  className="text-[12.5px] font-semibold text-slate-500 transition hover:text-brand-700 dark:hover:text-brand-200"
                >
                  Mark paid
                </button>
              )}
              <button
                type="button"
                onClick={onMove}
                aria-label={`Move money from ${jar.name}`}
                className="text-[12.5px] font-semibold text-slate-500 transition hover:text-brand-700 dark:hover:text-brand-200"
              >
                Move money
              </button>
              <button
                type="button"
                onClick={onEdit}
                aria-label={`Edit ${jar.name}`}
                className="text-[12.5px] font-semibold text-slate-500 transition hover:text-brand-700 dark:hover:text-brand-200"
              >
                Edit
              </button>
            </span>
          )}
        </div>
      </div>
    </Card>
  )
}

/** An example jar in a few words: "€600.00 · yearly", "€1,500.00 · Jul 2027", "€50.00 a month". */
function exampleLine(e: JarExample, currency: string): string {
  if (e.fixedMonthly) return `${formatMoney(fromAmount(Number(e.monthly)), currency)} a month`
  const target = formatMoney(fromAmount(Number(e.target)), currency)
  return e.repeats > 0 ? `${target} · ${cadenceLabel(e.repeats)}` : `${target} · ${monthYear(e.month)}`
}

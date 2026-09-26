import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppShell } from '../components/AppShell'
import { Badge, Button, Card, EmptyState, ErrorBanner } from '../components/ui'
import { Hero } from '../components/Hero'
import { Jar } from '../components/Jar'
import { JarFormModal } from '../components/JarFormModal'
import { MoveMoneyModal } from '../components/MoveMoneyModal'
import { JarsIcon } from '../components/icons'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { hueColor, hueForIndex, hueTint, type CategoryHue } from '../lib/categoryColors'
import type { AccountDto, JarAccountLedgerDto, JarDto } from '../types'
import { formatMoney, fromAmount } from '../lib/money'
import { jarPaceLabel, jarStatusChip } from '../lib/jarStatus'

export function JarsPage() {
  // Managing jars needs Admin+ (canWrite); others see them read-only.
  const { canWrite, preferredCurrency } = useAuth()
  const CURRENCY = preferredCurrency
  const [jars, setJars] = useState<JarDto[]>([])
  const [accounts, setAccounts] = useState<AccountDto[]>([])
  // Each jar-backed account's ledger — what's unallocated and whether its jars are backed (rule 70).
  const [ledgers, setLedgers] = useState<JarAccountLedgerDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The add / edit form lives in a modal; editingId switches it between modes.
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  // The jar whose "Move money" modal is open.
  const [movingId, setMovingId] = useState<string | null>(null)
  const editingJar = useMemo(
    () => (editingId ? jars.find((f) => f.id === editingId) ?? null : null),
    [editingId, jars],
  )
  const movingJar = useMemo(
    () => (movingId ? jars.find((f) => f.id === movingId) ?? null : null),
    [movingId, jars],
  )

  const loadLedgers = useCallback(() => {
    api
      .get<JarAccountLedgerDto[]>('/jars/ledger')
      .then(({ data }) => setLedgers(Array.isArray(data) ? data.filter((l) => l && typeof l.accountId === 'string' && Array.isArray(l.jars)) : []))
      .catch(() => setLedgers([]))
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      api.get<JarDto[]>('/jars'),
      api.get<AccountDto[]>('/accounts').catch(() => ({ data: [] })),
    ])
      .then(([f, acc]) => {
        if (cancelled) return
        setJars(f.data)
        setAccounts(Array.isArray(acc?.data) ? acc.data : [])
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

  function openAdd() {
    setEditingId(null)
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

  const onArchived = useCallback(
    (archived: JarDto) => {
      setJars((prev) => prev.filter((x) => x.id !== archived.id))
      closeForm()
      loadLedgers()
    },
    [closeForm, loadLedgers],
  )

  const onMoved = useCallback(() => {
    setMovingId(null)
    void refreshJars()
  }, [refreshJars])

  const accountName = useCallback(
    (id: string) => accounts.find((a) => a.id === id)?.name ?? ledgers.find((l) => l.accountId === id)?.accountName ?? null,
    [accounts, ledgers],
  )

  // Hero totals — what's saved across the jars whose balance is known, and the monthly
  // contribution they need. An unavailable balance (rule 67) is left out and called out,
  // never counted as zero.
  const totalSavedMinor = useMemo(
    () => jars.reduce((s, f) => s + (f.currentBalance === null ? 0 : fromAmount(f.currentBalance)), 0),
    [jars],
  )
  const unavailableCount = useMemo(() => jars.filter((f) => f.currentBalance === null).length, [jars])
  const monthlyMinor = useMemo(
    () => jars.reduce((s, f) => s + fromAmount(f.requiredMonthlyContribution), 0),
    [jars],
  )
  const backedLedgers = useMemo(() => ledgers.filter((l) => l.jars.some((j) => !j.isArchived)), [ledgers])

  return (
    <AppShell active="jars" title="Jars">
      <Hero
        eyebrow="Total saved"
        amount={formatMoney(totalSavedMinor, CURRENCY)}
        amountLabel={`Total saved: ${formatMoney(totalSavedMinor, CURRENCY)}`}
        tiles={[
          { label: 'Monthly', value: `+${formatMoney(monthlyMinor, CURRENCY)}` },
          { label: 'Active jars', value: `${jars.length}` },
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
          description="Add a jar — give it a target and a date, and we'll work out what to set aside each month."
        >
          {canWrite && (
            <Button onClick={openAdd} aria-label="New jar">
              <span aria-hidden className="text-base leading-none">+</span> New jar
            </Button>
          )}
        </EmptyState>
      ) : (
        !loading && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-base font-bold tracking-[-0.01em] text-slate-900">Your jars</h2>
              {canWrite && (
                <Button onClick={openAdd} aria-label="New jar">
                  <span aria-hidden className="text-base leading-none">+</span> New jar
                </Button>
              )}
            </div>
            <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
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
          accounts={accounts}
          currency={CURRENCY}
          onClose={closeForm}
          onSaved={onSaved}
          onArchived={onArchived}
        />
      )}

      {movingJar && canWrite && (
        <MoveMoneyModal jar={movingJar} currency={CURRENCY} onClose={() => setMovingId(null)} onMoved={onMoved} />
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
  canManage,
}: {
  jar: JarDto
  hue: CategoryHue
  currency: string
  heldIn: string | null
  onEdit: () => void
  onMove: () => void
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

        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[12.5px] font-medium tabular-nums text-slate-500">
            {jarPaceLabel(jar, currency)}
          </span>
          {canManage && (
            <span className="flex gap-3">
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

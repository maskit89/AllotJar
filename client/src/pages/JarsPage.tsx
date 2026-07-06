import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppShell } from '../components/AppShell'
import { Button, Card, EmptyState, ErrorBanner, Input, Select } from '../components/ui'
import { Hero } from '../components/Hero'
import { Modal } from '../components/Modal'
import { Jar } from '../components/Jar'
import { JarsIcon } from '../components/icons'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { EVENTS, track } from '../analytics'
import { hueColor, hueForIndex, hueTint, type CategoryHue } from '../lib/categoryColors'
import type { AccountDto, JarDto } from '../types'
import {
  AccrualMethod,
  ACCRUAL_METHOD_LABELS,
  JarKind,
  JAR_KIND_LABELS,
} from '../types'
import { formatMoney, fromAmount, parseMinor, toAmount, toEditString } from '../lib/money'

const KIND_OPTIONS = Object.entries(JAR_KIND_LABELS).map(([value, label]) => ({ value: Number(value), label }))
const ACCRUAL_OPTIONS = Object.entries(ACCRUAL_METHOD_LABELS).map(([value, label]) => ({ value: Number(value), label }))

/** Parse a non-negative amount string into a wire decimal; '' → 0; null when invalid. */
function parseAmount(input: string): number | null {
  if (input.trim() === '') return 0
  const minor = parseMinor(input)
  return minor === null ? null : toAmount(minor)
}

interface FormState {
  name: string
  kind: number
  target: string
  targetDate: string
  accrual: number
  opening: string
  fundingAccountId: string
}

const BLANK_FORM: FormState = {
  name: '',
  kind: JarKind.Recurring,
  target: '',
  targetDate: '',
  accrual: AccrualMethod.TargetByDate,
  opening: '',
  fundingAccountId: '',
}

export function JarsPage() {
  // Managing jars needs Admin+ (canWrite); others see them read-only.
  const { canWrite, preferredCurrency } = useAuth()
  const CURRENCY = preferredCurrency
  const [jars, setJars] = useState<JarDto[]>([])
  const [accounts, setAccounts] = useState<AccountDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // The add / edit form lives in a modal; editingId switches it between modes.
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(BLANK_FORM)
  // The jar behind the edit modal — one lookup shared by submit (echoing stored
  // fields) and the footer's Archive affordance.
  const editingJar = useMemo(
    () => (editingId ? jars.find((f) => f.id === editingId) ?? null : null),
    [editingId, jars],
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
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
    return () => {
      cancelled = true
    }
  }, [])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  // Close the modal and clear the form (used after a save / cancel / archive).
  const closeForm = useCallback(() => {
    setShowForm(false)
    setEditingId(null)
    setForm(BLANK_FORM)
  }, [])

  function openAdd() {
    setEditingId(null)
    setForm(BLANK_FORM)
    setError(null)
    setShowForm(true)
  }

  function startEdit(f: JarDto) {
    setEditingId(f.id)
    setForm({
      name: f.name,
      kind: f.kind,
      target: toEditString(fromAmount(f.targetAmount)),
      targetDate: f.targetDate ?? '',
      accrual: f.accrual,
      opening: toEditString(fromAmount(f.openingBalance)),
      fundingAccountId: f.fundingAccountId ?? '',
    })
    setError(null)
    setShowForm(true)
  }

  const submit = useCallback(async () => {
    if (form.name.trim() === '') {
      setError('Give the jar a name.')
      return
    }
    const targetAmount = parseAmount(form.target)
    const openingBalance = parseAmount(form.opening)
    if (targetAmount === null || openingBalance === null) {
      setError('Enter valid amounts.')
      return
    }

    // The form doesn't surface the cover window or opening as-of, so on edit the
    // jar's stored values are echoed back rather than wiped — importer-set cover
    // windows survive an unrelated rename (PUT replaces the whole resource).
    const body = {
      name: form.name.trim(),
      kind: form.kind,
      targetAmount,
      targetDate: form.targetDate || null,
      coverStart: editingJar?.coverStart ?? null,
      coverEnd: editingJar?.coverEnd ?? null,
      accrual: form.accrual,
      openingBalance,
      openingAsOf: editingJar?.openingAsOf ?? null,
      fundingAccountId: form.fundingAccountId || null,
    }

    setSaving(true)
    setError(null)
    try {
      if (editingId) {
        const { data } = await api.put<JarDto>(`/jars/${editingId}`, body)
        setJars((prev) => prev.map((f) => (f.id === editingId ? data : f)))
        track(EVENTS.fundEdited, { kind: form.kind })
      } else {
        const { data } = await api.post<JarDto>('/jars', body)
        setJars((prev) => [...prev, data])
        track(EVENTS.fundCreated, { kind: form.kind })
      }
      closeForm()
    } catch {
      setError(editingId ? 'Could not save that jar.' : 'Could not add that jar.')
    } finally {
      setSaving(false)
    }
  }, [form, editingId, editingJar, closeForm])

  const archive = useCallback(
    async (f: JarDto) => {
      setSaving(true)
      setError(null)
      try {
        await api.put(`/jars/${f.id}/archive`, { archived: true })
        setJars((prev) => prev.filter((x) => x.id !== f.id))
        track(EVENTS.fundArchived)
        closeForm()
      } catch {
        setError('Could not archive that jar.')
      } finally {
        setSaving(false)
      }
    },
    [closeForm],
  )

  // Hero totals — what's saved across the jars, the monthly contribution they need.
  const totalSavedMinor = useMemo(() => jars.reduce((s, f) => s + fromAmount(f.currentBalance), 0), [jars])
  const monthlyMinor = useMemo(
    () => jars.reduce((s, f) => s + fromAmount(f.requiredMonthlyContribution), 0),
    [jars],
  )

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
      />

      {error && !showForm && <ErrorBanner>{error}</ErrorBanner>}

      {loading && <p className="text-slate-500">Loading…</p>}

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
                  onEdit={() => startEdit(f)}
                  canManage={canWrite}
                />
              ))}
            </div>
          </section>
        )
      )}

      {/* Add / edit jar — a modal, mounted only while open so its focus trap engages. */}
      {showForm && canWrite && (
        <Modal title={editingId ? 'Edit jar' : 'New jar'} onClose={closeForm} size="lg">
          {error && (
            <div className="mb-3">
              <ErrorBanner>{error}</ErrorBanner>
            </div>
          )}
          <div className="space-y-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Name
              <Input
                type="text"
                value={form.name}
                placeholder="e.g. Home insurance"
                aria-label="Jar name"
                onChange={(e) => set('name', e.target.value)}
                className="w-full"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                Type
                <Select value={form.kind} aria-label="Jar type" onChange={(e) => set('kind', Number(e.target.value))} className="w-full">
                  {KIND_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                Accrual
                <Select value={form.accrual} aria-label="Accrual method" onChange={(e) => set('accrual', Number(e.target.value))} className="w-full">
                  {ACCRUAL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                Target
                <Input
                  type="text"
                  inputMode="decimal"
                  value={form.target}
                  placeholder="0.00"
                  aria-label="Target amount"
                  onChange={(e) => set('target', e.target.value)}
                  className="w-full text-right tabular-nums"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                {/* At creation the opening IS what's saved so far; once contributions
                    are recorded on top of it, calling it "saved so far" invites
                    retyping the card's live balance — which would double-count. */}
                {editingId ? 'Opening balance' : 'Saved so far'}
                <Input
                  type="text"
                  inputMode="decimal"
                  value={form.opening}
                  placeholder="0.00"
                  aria-label="Opening balance"
                  onChange={(e) => set('opening', e.target.value)}
                  className="w-full text-right tabular-nums"
                />
                {editingId && (
                  <span className="text-[11px] font-normal text-slate-400">
                    Before tracking began — the card shows the live total.
                  </span>
                )}
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                Target date
                <Input
                  type="date"
                  value={form.targetDate}
                  aria-label="Target date"
                  onChange={(e) => set('targetDate', e.target.value)}
                  className="w-full"
                />
              </label>
              {accounts.length > 0 && (
                <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                  Held in
                  <Select
                    value={form.fundingAccountId}
                    aria-label="Funding account"
                    onChange={(e) => set('fundingAccountId', e.target.value)}
                    className="w-full"
                  >
                    <option value="">No account</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              {editingJar ? (
                <button
                  type="button"
                  onClick={() => archive(editingJar)}
                  disabled={saving}
                  aria-label={`Archive ${editingJar.name}`}
                  className="rounded-lg px-2 py-1.5 text-sm font-semibold text-slate-500 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                >
                  Archive jar
                </button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <Button variant="ghost" onClick={closeForm} aria-label="Cancel edit">
                  Cancel
                </Button>
                <Button onClick={submit} disabled={saving} aria-label={editingId ? 'Save jar' : 'Add jar'}>
                  {editingId ? 'Save' : 'Add jar'}
                </Button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </AppShell>
  )
}

function JarCard({
  jar,
  hue,
  currency,
  onEdit,
  canManage,
}: {
  jar: JarDto
  hue: CategoryHue
  currency: string
  onEdit: () => void
  canManage: boolean
}) {
  const balanceMinor = fromAmount(jar.currentBalance)
  const targetMinor = fromAmount(jar.targetAmount)
  const pct = targetMinor > 0 ? Math.min(100, Math.max(0, Math.round((balanceMinor / targetMinor) * 100))) : 0
  const monthlyMinor = fromAmount(jar.requiredMonthlyContribution)

  return (
    <Card className="flex gap-4 p-5">
      <Jar hue={hue} pct={pct} size="card" showPct={false} label={`${jar.name}: ${pct}% funded`} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate text-[15px] font-semibold text-slate-900">{jar.name}</h3>
          {targetMinor > 0 && (
            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-600">
              {pct}%
            </span>
          )}
        </div>

        <div className="mt-1 flex items-baseline gap-1.5 tabular-nums">
          <span className="text-[19px] font-bold text-slate-900">{formatMoney(balanceMinor, currency)}</span>
          {targetMinor > 0 && <span className="text-[13px] text-slate-500">of {formatMoney(targetMinor, currency)}</span>}
        </div>

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
            {monthlyMinor > 0 ? `+${formatMoney(monthlyMinor, currency)}/mo` : '—'}
          </span>
          {canManage && (
            <button
              type="button"
              onClick={onEdit}
              aria-label={`Edit ${jar.name}`}
              className="text-[12.5px] font-semibold text-slate-500 transition hover:text-brand-700 dark:hover:text-brand-200"
            >
              Edit
            </button>
          )}
        </div>
      </div>
    </Card>
  )
}

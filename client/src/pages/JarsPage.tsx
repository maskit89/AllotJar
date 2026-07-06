import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppShell } from '../components/AppShell'
import { Button, Card, EmptyState, ErrorBanner, Input, Select } from '../components/ui'
import { Hero } from '../components/Hero'
import { Modal } from '../components/Modal'
import { Jar } from '../components/Jar'
import { InfoHint } from '../components/InfoHint'
import { JarsIcon } from '../components/icons'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { EVENTS, track } from '../analytics'
import { hueColor, hueForIndex, hueTint, type CategoryHue } from '../lib/categoryColors'
import type { AccountDto, JarDto } from '../types'
import {
  AccrualMethod,
  JarKind,
  JAR_KIND_LABELS,
  RECUR_MONTHS_OPTIONS,
} from '../types'
import { formatMoney, fromAmount, parseMinor, toAmount, toEditString } from '../lib/money'
import { formatDate } from '../lib/dates'

const KIND_OPTIONS = Object.entries(JAR_KIND_LABELS).map(([value, label]) => ({ value: Number(value), label }))

/** Parse a non-negative amount string into a wire decimal; '' → 0; null when invalid. */
function parseAmount(input: string): number | null {
  if (input.trim() === '') return 0
  const minor = parseMinor(input)
  return minor === null ? null : toAmount(minor)
}

/** Whole calendar months from today to an ISO date (yyyy-MM-dd) — day-of-month ignored, like the server. */
function monthsFromNow(iso: string): number {
  const now = new Date()
  const [y, m] = iso.split('-').map(Number)
  return (y - now.getFullYear()) * 12 + (m - (now.getMonth() + 1))
}

interface FormState {
  name: string
  kind: number
  target: string
  targetDate: string
  recurMonths: number
  opening: string
  fundingAccountId: string
}

const BLANK_FORM: FormState = {
  name: '',
  kind: JarKind.Recurring,
  target: '',
  targetDate: '',
  recurMonths: 12,
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
  // One deliberate step between "Archive jar" and it actually happening.
  const [confirmArchive, setConfirmArchive] = useState(false)

  // Live preview of the monthly set-aside, mirroring the server's by-target-date
  // math (remaining ÷ whole months, floored at one). Hidden while the target
  // doesn't parse or is 0, and for imported jars on other accrual methods, where
  // this math wouldn't match the server's figure.
  const preview = useMemo(() => {
    if (editingJar && editingJar.accrual !== AccrualMethod.TargetByDate) return null
    const targetMinor = form.target.trim() === '' ? 0 : parseMinor(form.target)
    if (targetMinor === null || targetMinor <= 0) return null
    const baseMinor = editingJar
      ? fromAmount(editingJar.currentBalance)
      : form.opening.trim() === ''
        ? 0
        : parseMinor(form.opening) ?? 0
    const remaining = targetMinor - baseMinor
    if (remaining <= 0) return 0
    const months = form.targetDate ? Math.max(1, monthsFromNow(form.targetDate)) : 12
    return Math.round(remaining / months)
  }, [form.target, form.opening, form.targetDate, editingJar])

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
    setConfirmArchive(false)
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
      recurMonths: f.recurMonths ?? 12,
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
    // A recurring jar rolls its date forward each cycle, so it needs a date (and a
    // real target) to roll — mirrors the server's validation, but caught here with
    // friendlier wording.
    if (form.kind === JarKind.Recurring) {
      if (targetAmount <= 0) {
        setError('Give the recurring jar a target amount.')
        return
      }
      if (!form.targetDate) {
        setError('Give the recurring jar its next due date.')
        return
      }
    }
    // A brand-new jar due in the past would demand its whole remainder this month
    // (months-to-date floors at one) — almost never what was meant.
    if (!editingId && form.targetDate && monthsFromNow(form.targetDate) < 0) {
      setError('The date has already passed — pick an upcoming one.')
      return
    }

    // The form doesn't surface the cover window, opening as-of or accrual method, so
    // on edit the jar's stored values are echoed back rather than wiped — importer-set
    // cover windows and StraightLine/DailyRate accruals survive an unrelated rename
    // (PUT replaces the whole resource). New jars save by target date.
    const body = {
      name: form.name.trim(),
      kind: form.kind,
      targetAmount,
      targetDate: form.targetDate || null,
      coverStart: editingJar?.coverStart ?? null,
      coverEnd: editingJar?.coverEnd ?? null,
      accrual: editingJar?.accrual ?? AccrualMethod.TargetByDate,
      openingBalance,
      openingAsOf: editingJar?.openingAsOf ?? null,
      fundingAccountId: form.fundingAccountId || null,
      recurMonths: form.kind === JarKind.Recurring ? form.recurMonths : null,
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
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-1 text-xs font-medium text-slate-500">
                <label htmlFor="jar-type">Type</label>
                <InfoHint label="About jar types">
                  <span className="block font-semibold text-slate-700">Recurring</span>
                  Saves toward a due date, then repeats: when the date passes, it rolls
                  forward a cycle and keeps going (insurance, road tax, holiday).
                  <span className="mt-2 block font-semibold text-slate-700">Goal</span>
                  A one-off savings target — once it&rsquo;s funded, it&rsquo;s done (new kitchen,
                  sofa, wedding).
                </InfoHint>
              </span>
              <Select id="jar-type" value={form.kind} aria-label="Jar type" onChange={(e) => set('kind', Number(e.target.value))} className="w-full">
                {KIND_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
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
              {form.kind === JarKind.Recurring ? (
                <>
                  <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                    Next due
                    <Input
                      type="date"
                      value={form.targetDate}
                      aria-label="Next due date"
                      onChange={(e) => set('targetDate', e.target.value)}
                      className="w-full"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                    Repeats
                    <Select
                      value={form.recurMonths}
                      aria-label="Repeat cycle"
                      onChange={(e) => set('recurMonths', Number(e.target.value))}
                      className="w-full"
                    >
                      {RECUR_MONTHS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </label>
                </>
              ) : (
                <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                  Target date (optional)
                  <Input
                    type="date"
                    value={form.targetDate}
                    aria-label="Target date"
                    onChange={(e) => set('targetDate', e.target.value)}
                    className="w-full"
                  />
                </label>
              )}
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                Held in
                <Select
                  value={form.fundingAccountId}
                  aria-label="Funding account"
                  onChange={(e) => set('fundingAccountId', e.target.value)}
                  disabled={accounts.length === 0}
                  className="w-full"
                >
                  <option value="">{accounts.length === 0 ? 'No accounts yet' : 'No account'}</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            {preview !== null && (
              <p
                aria-live="polite"
                className="rounded-lg bg-slate-100 px-3 py-2 text-[12.5px] font-medium tabular-nums text-slate-600"
              >
                Sets aside <span className="font-bold text-slate-900">≈ {formatMoney(preview, CURRENCY)}/mo</span>
                {form.targetDate
                  ? form.kind === JarKind.Recurring
                    ? ` until ${formatDate(form.targetDate)}, then the date rolls forward and it keeps going`
                    : ` until ${formatDate(form.targetDate)}`
                  : ' (no date — the remainder spreads over 12 months)'}
              </p>
            )}
            <div className="flex items-center justify-between gap-2 pt-1">
              {editingJar ? (
                // Two clicks to archive: the first arms the button, the second acts.
                <button
                  type="button"
                  onClick={() => (confirmArchive ? archive(editingJar) : setConfirmArchive(true))}
                  disabled={saving}
                  aria-label={confirmArchive ? `Confirm archive ${editingJar.name}` : `Archive ${editingJar.name}`}
                  className={`rounded-lg px-2 py-1.5 text-sm font-semibold transition disabled:opacity-50 ${
                    confirmArchive
                      ? 'bg-rose-50 text-rose-600 hover:bg-rose-100'
                      : 'text-slate-500 hover:bg-rose-50 hover:text-rose-600'
                  }`}
                >
                  {confirmArchive ? 'Really archive?' : 'Archive jar'}
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

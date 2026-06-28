import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppShell } from '../components/AppShell'
import { Button, Card, EmptyState, ErrorBanner, Input, Select } from '../components/ui'
import { Hero } from '../components/Hero'
import { Modal } from '../components/Modal'
import { Jar } from '../components/Jar'
import { FundsIcon } from '../components/icons'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { EVENTS, track } from '../analytics'
import { hueColor, hueForIndex, hueTint, type CategoryHue } from '../lib/categoryColors'
import type { AccountDto, SinkingFundDto } from '../types'
import {
  AccrualMethod,
  ACCRUAL_METHOD_LABELS,
  FundKind,
  FUND_KIND_LABELS,
} from '../types'
import { formatMoney, fromAmount, parseMinor, toAmount, toEditString } from '../lib/money'

const KIND_OPTIONS = Object.entries(FUND_KIND_LABELS).map(([value, label]) => ({ value: Number(value), label }))
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
  recurAnnually: boolean
  fundingAccountId: string
}

const BLANK_FORM: FormState = {
  name: '',
  kind: FundKind.Annual,
  target: '',
  targetDate: '',
  accrual: AccrualMethod.TargetByDate,
  opening: '',
  recurAnnually: false,
  fundingAccountId: '',
}

export function FundsPage() {
  // Managing sinking funds needs Admin+ (canWrite); others see them read-only.
  const { canWrite, preferredCurrency } = useAuth()
  const CURRENCY = preferredCurrency
  const [funds, setFunds] = useState<SinkingFundDto[]>([])
  const [accounts, setAccounts] = useState<AccountDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // The add / edit form lives in a modal; editingId switches it between modes.
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(BLANK_FORM)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      api.get<SinkingFundDto[]>('/sinkingfunds'),
      api.get<AccountDto[]>('/accounts').catch(() => ({ data: [] })),
    ])
      .then(([f, acc]) => {
        if (cancelled) return
        setFunds(f.data)
        setAccounts(Array.isArray(acc?.data) ? acc.data : [])
      })
      .catch(() => !cancelled && setError('Could not load your sinking funds.'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  const accountName = (id: string | null) => (id ? accounts.find((a) => a.id === id)?.name ?? null : null)

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

  function startEdit(f: SinkingFundDto) {
    setEditingId(f.id)
    setForm({
      name: f.name,
      kind: f.kind,
      target: toEditString(fromAmount(f.targetAmount)),
      targetDate: f.targetDate ?? '',
      accrual: f.accrual,
      opening: toEditString(fromAmount(f.openingBalance)),
      recurAnnually: f.recurAnnually,
      fundingAccountId: f.fundingAccountId ?? '',
    })
    setError(null)
    setShowForm(true)
  }

  const submit = useCallback(async () => {
    if (form.name.trim() === '') {
      setError('Give the fund a name.')
      return
    }
    const targetAmount = parseAmount(form.target)
    const openingBalance = parseAmount(form.opening)
    if (targetAmount === null || openingBalance === null) {
      setError('Enter valid amounts.')
      return
    }

    const body = {
      name: form.name.trim(),
      kind: form.kind,
      targetAmount,
      targetDate: form.targetDate || null,
      coverStart: null,
      coverEnd: null,
      accrual: form.accrual,
      recurAnnually: form.recurAnnually,
      openingBalance,
      openingAsOf: null,
      fundingAccountId: form.fundingAccountId || null,
    }

    setSaving(true)
    setError(null)
    try {
      if (editingId) {
        const { data } = await api.put<SinkingFundDto>(`/sinkingfunds/${editingId}`, body)
        setFunds((prev) => prev.map((f) => (f.id === editingId ? data : f)))
        track(EVENTS.fundEdited, { kind: form.kind })
      } else {
        const { data } = await api.post<SinkingFundDto>('/sinkingfunds', body)
        setFunds((prev) => [...prev, data])
        track(EVENTS.fundCreated, { kind: form.kind })
      }
      closeForm()
    } catch {
      setError(editingId ? 'Could not save that fund.' : 'Could not add that fund.')
    } finally {
      setSaving(false)
    }
  }, [form, editingId, closeForm])

  const archive = useCallback(
    async (f: SinkingFundDto) => {
      setSaving(true)
      setError(null)
      try {
        await api.put(`/sinkingfunds/${f.id}/archive`, { archived: true })
        setFunds((prev) => prev.filter((x) => x.id !== f.id))
        track(EVENTS.fundArchived)
        closeForm()
      } catch {
        setError('Could not archive that fund.')
      } finally {
        setSaving(false)
      }
    },
    [closeForm],
  )

  // Hero totals — what's saved across the jars, the monthly contribution they need.
  const totalSavedMinor = useMemo(() => funds.reduce((s, f) => s + fromAmount(f.currentBalance), 0), [funds])
  const monthlyMinor = useMemo(
    () => funds.reduce((s, f) => s + fromAmount(f.requiredMonthlyContribution), 0),
    [funds],
  )

  const editingFund = editingId ? funds.find((f) => f.id === editingId) ?? null : null

  return (
    <AppShell active="funds">
      <Hero
        eyebrow="Total saved"
        amount={formatMoney(totalSavedMinor, CURRENCY)}
        amountLabel={`Total saved: ${formatMoney(totalSavedMinor, CURRENCY)}`}
        tiles={[
          { label: 'Monthly', value: `+${formatMoney(monthlyMinor, CURRENCY)}` },
          { label: 'Active jars', value: `${funds.length}` },
        ]}
      />

      {error && !showForm && <ErrorBanner>{error}</ErrorBanner>}

      {loading && <p className="text-slate-500">Loading…</p>}

      {!loading && funds.length === 0 ? (
        <EmptyState
          icon={<FundsIcon className="h-6 w-6" />}
          title="No sinking funds yet"
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
              {funds.map((f, i) => (
                <FundCard
                  key={f.id}
                  fund={f}
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
                aria-label="Fund name"
                onChange={(e) => set('name', e.target.value)}
                className="w-full"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
                Kind
                <Select value={form.kind} aria-label="Fund kind" onChange={(e) => set('kind', Number(e.target.value))} className="w-full">
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
                Saved so far
                <Input
                  type="text"
                  inputMode="decimal"
                  value={form.opening}
                  placeholder="0.00"
                  aria-label="Opening balance"
                  onChange={(e) => set('opening', e.target.value)}
                  className="w-full text-right tabular-nums"
                />
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
            <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
              <input
                type="checkbox"
                checked={form.recurAnnually}
                aria-label="Renews each year"
                onChange={(e) => set('recurAnnually', e.target.checked)}
                className="h-4 w-4 rounded border-slate-400"
              />
              Renews yearly
            </label>
            <div className="flex items-center justify-between gap-2 pt-1">
              {editingFund ? (
                <button
                  type="button"
                  onClick={() => archive(editingFund)}
                  disabled={saving}
                  aria-label={`Archive ${editingFund.name}`}
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
                <Button onClick={submit} disabled={saving} aria-label={editingId ? 'Save fund' : 'Add fund'}>
                  {editingId ? 'Save' : 'Add fund'}
                </Button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </AppShell>
  )
}

function FundCard({
  fund,
  hue,
  currency,
  onEdit,
  canManage,
}: {
  fund: SinkingFundDto
  hue: CategoryHue
  currency: string
  onEdit: () => void
  canManage: boolean
}) {
  const balanceMinor = fromAmount(fund.currentBalance)
  const targetMinor = fromAmount(fund.targetAmount)
  const pct = targetMinor > 0 ? Math.min(100, Math.max(0, Math.round((balanceMinor / targetMinor) * 100))) : 0
  const monthlyMinor = fromAmount(fund.requiredMonthlyContribution)

  return (
    <Card className="flex gap-4 p-5">
      <Jar hue={hue} pct={pct} size="card" showPct={false} label={`${fund.name}: ${pct}% funded`} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate text-[15px] font-semibold text-slate-900">{fund.name}</h3>
          {targetMinor > 0 && (
            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-500">
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
          aria-label={`${fund.name} funding progress`}
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
              aria-label={`Edit ${fund.name}`}
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

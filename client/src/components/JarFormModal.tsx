import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, ErrorBanner, Input, Select } from './ui'
import { Modal } from './Modal'
import { InfoHint } from './InfoHint'
import { api } from '../lib/api'
import { EVENTS, track } from '../analytics'
import type { AccountDto, JarDto } from '../types'
import { AccrualMethod, JarKind, JAR_KIND_LABELS, RECUR_MONTHS_OPTIONS } from '../types'
import { formatMoney, fromAmount, parseMinor, toAmount, toEditString } from '../lib/money'
import { selectOnFocusProps } from '../lib/selectOnFocus'
import { formatDate, todayIso } from '../lib/dates'
import { serverErrors } from '../lib/serverErrors'
import { effectiveDueIso, jarAccounts, monthsToEffectiveDue } from '../lib/jarForm'

const KIND_OPTIONS = Object.entries(JAR_KIND_LABELS).map(([value, label]) => ({ value: Number(value), label }))

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
  recurMonths: number
  /** Create only: money already in the account to divide into this jar (rule 77). */
  initialAllocation: string
  initialAllocationDate: string
  fundingAccountId: string
}

function initialForm(jar: JarDto | null, accounts: AccountDto[]): FormState {
  if (jar) {
    return {
      name: jar.name,
      kind: jar.kind,
      target: toEditString(fromAmount(jar.targetAmount)),
      targetDate: jar.targetDate ?? '',
      recurMonths: jar.recurMonths ?? 12,
      initialAllocation: '',
      initialAllocationDate: todayIso(),
      fundingAccountId: jar.fundingAccountId,
    }
  }
  return {
    name: '',
    kind: JarKind.Recurring,
    target: '',
    targetDate: '',
    recurMonths: 12,
    initialAllocation: '',
    initialAllocationDate: todayIso(),
    // The select has no blank option, so the form starts on the first eligible account.
    fundingAccountId: accounts[0]?.id ?? '',
  }
}

export interface JarFormModalProps {
  /** The jar being edited, or null to create one. */
  jar: JarDto | null
  /** Every account the household has; the form itself drops credit cards. */
  accounts: AccountDto[]
  currency: string
  onClose: () => void
  /** The saved jar (POST /jars on create, PUT /jars/{id} on edit). */
  onSaved: (jar: JarDto, mode: 'created' | 'updated') => void
  /** Edit only: called after PUT /jars/{id}/archive succeeds. Omit to hide the Archive affordance. */
  onArchived?: (jar: JarDto) => void
}

/**
 * The one jar form (rule 73): the Jars page and a Budget-page Savings group open this
 * same modal, so a jar is always created with its designated account and, on create,
 * an optional initial allocation of money already held there (rule 77). `role="dialog"`
 * comes from Modal; mount it conditionally so the focus trap engages.
 */
export function JarFormModal({ jar, accounts, currency, onClose, onSaved, onArchived }: JarFormModalProps) {
  const editing = jar !== null
  const eligible = useMemo(() => jarAccounts(accounts), [accounts])
  const [form, setForm] = useState<FormState>(() => initialForm(jar, eligible))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // One deliberate step between "Archive jar" and it actually happening.
  const [confirmArchive, setConfirmArchive] = useState(false)

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const heldIn = useMemo(
    () => eligible.find((a) => a.id === form.fundingAccountId) ?? null,
    [eligible, form.fundingAccountId],
  )

  // The cycle dropdown offers the common cadences; if an edited jar carries a value
  // set via the API that isn't one of them (e.g. 24), keep it as an option so the
  // select shows it rather than silently rewriting it on the next save.
  const recurOptions = useMemo(() => {
    if (RECUR_MONTHS_OPTIONS.some((o) => o.value === form.recurMonths)) return RECUR_MONTHS_OPTIONS
    return [...RECUR_MONTHS_OPTIONS, { value: form.recurMonths, label: `Every ${form.recurMonths} months` }]
  }, [form.recurMonths])

  // Live estimate of the monthly set-aside, mirroring the server's by-target-date
  // math (remaining ÷ whole months to the — recurrence-adjusted — due date, floored
  // at one). Approximate by nature (prefixed "≈"). The base the contributions build on
  // is the initial allocation being typed (create) or the jar's actual balance (edit).
  // Hidden while the target doesn't parse or is 0, for imported jars on other accrual
  // methods, and while the balance is unavailable.
  const preview = useMemo(() => {
    if (jar && jar.accrual !== AccrualMethod.TargetByDate) return null
    if (jar && jar.currentBalance === null) return null
    const targetMinor = form.target.trim() === '' ? 0 : parseMinor(form.target)
    if (targetMinor === null || targetMinor <= 0) return null
    const baseMinor = jar
      ? fromAmount(jar.currentBalance ?? 0)
      : form.initialAllocation.trim() === ''
        ? 0
        : parseMinor(form.initialAllocation) ?? 0
    const remaining = targetMinor - baseMinor
    if (remaining <= 0) return 0
    const months = form.targetDate
      ? Math.max(1, monthsToEffectiveDue(form.targetDate, form.kind, form.recurMonths))
      : 12
    return Math.round(remaining / months)
  }, [form.target, form.initialAllocation, form.targetDate, form.kind, form.recurMonths, jar])

  const submit = useCallback(async () => {
    if (form.name.trim() === '') {
      setError('Give the jar a name.')
      return
    }
    const targetAmount = parseAmount(form.target)
    const initialAllocation = editing ? 0 : parseAmount(form.initialAllocation)
    if (targetAmount === null || initialAllocation === null) {
      setError('Enter valid amounts.')
      return
    }
    if (!form.fundingAccountId) {
      setError('Choose the account that holds this jar’s money.')
      return
    }
    if (!editing && initialAllocation > 0 && !form.initialAllocationDate) {
      setError('Enter the date the money was set aside.')
      return
    }
    // A recurring jar rolls its date forward each cycle, so it needs a date (and a
    // real target) to roll. This is form guidance for a NEW jar — the server stays
    // permissive so imported/legacy recurring jars (open-ended pools, date-less funds)
    // can still be renamed or re-accounted without inventing values on edit.
    if (!editing && form.kind === JarKind.Recurring) {
      if (targetAmount <= 0) {
        setError('Give the recurring jar a target amount.')
        return
      }
      if (!form.targetDate) {
        setError('Give the recurring jar its next due date.')
        return
      }
    }

    // The form doesn't surface the cover window or accrual method, so on edit the
    // jar's stored values are echoed back rather than wiped — importer-set cover
    // windows and StraightLine/DailyRate accruals survive an unrelated rename (PUT
    // replaces the whole resource). New jars save by target date.
    const common = {
      name: form.name.trim(),
      kind: form.kind,
      targetAmount,
      targetDate: form.targetDate || null,
      coverStart: jar?.coverStart ?? null,
      coverEnd: jar?.coverEnd ?? null,
      accrual: jar?.accrual ?? AccrualMethod.TargetByDate,
      fundingAccountId: form.fundingAccountId,
      recurMonths: form.kind === JarKind.Recurring ? form.recurMonths : null,
    }

    setSaving(true)
    setError(null)
    try {
      if (jar) {
        const { data } = await api.put<JarDto>(`/jars/${jar.id}`, common)
        track(EVENTS.fundEdited, { kind: form.kind })
        onSaved(data, 'updated')
      } else {
        const { data } = await api.post<JarDto>('/jars', {
          ...common,
          initialAllocation,
          initialAllocationDate: initialAllocation > 0 ? form.initialAllocationDate : null,
        })
        track(EVENTS.fundCreated, { kind: form.kind })
        onSaved(data, 'created')
      }
    } catch (err) {
      // A 400 carries the server's field messages (e.g. a FundingAccountId change refused
      // while the jar holds money, rule 80; an allocation above the unallocated funds).
      setError(serverErrors(err) ?? (editing ? 'Could not save that jar.' : 'Could not add that jar.'))
    } finally {
      setSaving(false)
    }
  }, [form, editing, jar, onSaved])

  const archive = useCallback(async () => {
    if (!jar || !onArchived) return
    setSaving(true)
    setError(null)
    try {
      await api.put(`/jars/${jar.id}/archive`, { archived: true })
      track(EVENTS.fundArchived)
      onArchived(jar)
    } catch (err) {
      // Archiving needs a zero balance (rule 26): the server says what the jar still holds.
      setError(serverErrors(err) ?? 'Could not archive that jar.')
    } finally {
      setSaving(false)
    }
  }, [jar, onArchived])

  const noAccounts = eligible.length === 0
  const today = todayIso()

  return (
    <Modal title={editing ? 'Edit jar' : 'New jar'} onClose={onClose} size="lg">
      {error && (
        <div className="mb-3">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}
      {noAccounts && (
        <p
          role="status"
          className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
        >
          Add an account first — a jar&rsquo;s money is held in an account.{' '}
          <Link to="/accounts" className="font-semibold underline">
            Go to accounts
          </Link>
        </p>
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
              {...selectOnFocusProps}
              value={form.target}
              placeholder="0.00"
              aria-label="Target amount"
              onChange={(e) => set('target', e.target.value)}
              className="w-full text-right tabular-nums"
            />
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
                  {recurOptions.map((o) => (
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
              disabled={noAccounts}
              className="w-full"
            >
              {eligible.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
            {editing && (
              <span className="text-[11px] font-normal text-slate-500">
                The account can change only while the jar holds nothing.
              </span>
            )}
          </label>
        </div>
        {!editing && (
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Already set aside
              <Input
                type="text"
                inputMode="decimal"
                {...selectOnFocusProps}
                value={form.initialAllocation}
                placeholder="0.00"
                aria-label="Already set aside"
                disabled={noAccounts}
                onChange={(e) => set('initialAllocation', e.target.value)}
                className="w-full text-right tabular-nums"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Set aside on
              <Input
                type="date"
                value={form.initialAllocationDate}
                max={today}
                aria-label="Set aside on"
                disabled={noAccounts}
                onChange={(e) => set('initialAllocationDate', e.target.value)}
                className="w-full"
              />
            </label>
            <p className="col-span-2 text-[11px] font-normal text-slate-500">
              Divides money already in {heldIn?.name ?? 'the account'} into this jar. It doesn&rsquo;t add money.
            </p>
          </div>
        )}
        {preview !== null && (
          <p
            aria-live="polite"
            className="rounded-lg bg-slate-100 px-3 py-2 text-[12.5px] font-medium tabular-nums text-slate-600"
          >
            Sets aside <span className="font-bold text-slate-900">≈ {formatMoney(preview, currency)}/mo</span>
            {form.targetDate
              ? form.kind === JarKind.Recurring
                ? ` toward ${formatDate(effectiveDueIso(form.targetDate, form.kind, form.recurMonths))}, then it repeats`
                : ` until ${formatDate(form.targetDate)}`
              : ' (no date — the remainder spreads over 12 months)'}
          </p>
        )}
        <div className="flex items-center justify-between gap-2 pt-1">
          {jar && onArchived ? (
            // Two clicks to archive: the first arms the button, the second acts.
            <button
              type="button"
              onClick={() => (confirmArchive ? archive() : setConfirmArchive(true))}
              disabled={saving}
              aria-label={confirmArchive ? `Confirm archive ${jar.name}` : `Archive ${jar.name}`}
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
            <Button variant="ghost" onClick={onClose} aria-label="Cancel edit">
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving || (!editing && noAccounts)} aria-label={editing ? 'Save jar' : 'Add jar'}>
              {editing ? 'Save' : 'Add jar'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

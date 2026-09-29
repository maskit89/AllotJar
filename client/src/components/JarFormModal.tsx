import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, ErrorBanner, Input, Select } from './ui'
import { Modal } from './Modal'
import { InfoHint } from './InfoHint'
import { api } from '../lib/api'
import { EVENTS, track } from '../analytics'
import type { AccountDto, JarDto, JarScheduleDto, JarScheduleRequest } from '../types'
import { AccrualMethod, JarKind, JAR_KIND_LABELS, RECUR_MONTHS_OPTIONS } from '../types'
import { formatMoney, fromAmount, parseMinor, toAmount, toEditString } from '../lib/money'
import { selectOnFocusProps } from '../lib/selectOnFocus'
import { formatDate, monthYear, todayIso } from '../lib/dates'
import { serverErrors } from '../lib/serverErrors'
import { deadlineMonthEligible, jarAccounts, monthIso } from '../lib/jarForm'

const KIND_OPTIONS = Object.entries(JAR_KIND_LABELS).map(([value, label]) => ({ value: Number(value), label }))

/** How a Goal saves (rule 17); a Recurring jar always saves toward its next due date. */
const METHOD_OPTIONS = [
  { value: AccrualMethod.TargetByDate, label: 'By a deadline' },
  { value: AccrualMethod.FixedMonthly, label: 'A fixed amount each month' },
]

/** How long the form waits after a keystroke before asking the server for the schedule. */
const PREVIEW_DEBOUNCE_MS = 250

/** Parse a non-negative amount string into a wire decimal; '' → 0; null when invalid. */
function parseAmount(input: string): number | null {
  if (input.trim() === '') return 0
  const minor = parseMinor(input)
  return minor === null ? null : toAmount(minor)
}

interface FormState {
  name: string
  kind: number
  /** AccrualMethod: how a Goal saves. A Recurring jar is always TargetByDate. */
  method: number
  target: string
  /** The deadline (a Recurring jar's next due date). */
  targetDate: string
  /** Rule 36: plan a contribution in the deadline month too. */
  includeDeadlineMonth: boolean
  /** The fixed monthly amount (FixedMonthly only). */
  monthly: string
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
      method: jar.accrual === AccrualMethod.FixedMonthly ? AccrualMethod.FixedMonthly : AccrualMethod.TargetByDate,
      target: jar.targetAmount > 0 ? toEditString(fromAmount(jar.targetAmount)) : '',
      // A Recurring jar's "Next due" is its open cycle (W03) — sent back unchanged it keeps the
      // cycle; a Goal's date is its deadline.
      targetDate: (jar.kind === JarKind.Recurring ? jar.deadline ?? jar.targetDate : jar.targetDate) ?? '',
      includeDeadlineMonth: jar.includeDeadlineMonth,
      monthly: jar.monthlyContribution !== null && jar.monthlyContribution > 0 ? toEditString(fromAmount(jar.monthlyContribution)) : '',
      recurMonths: jar.recurMonths ?? 12,
      initialAllocation: '',
      initialAllocationDate: todayIso(),
      fundingAccountId: jar.fundingAccountId,
    }
  }
  return {
    name: '',
    kind: JarKind.Recurring,
    method: AccrualMethod.TargetByDate,
    target: '',
    targetDate: '',
    includeDeadlineMonth: false,
    monthly: '',
    recurMonths: 12,
    initialAllocation: '',
    initialAllocationDate: todayIso(),
    // The select has no blank option, so the form starts on the first eligible account.
    fundingAccountId: accounts[0]?.id ?? '',
  }
}

/** The definition the form describes, or null while it can't be planned yet (rule 17). */
function definition(form: FormState, jar: JarDto | null, editing: boolean): JarScheduleRequest | null {
  const method = form.kind === JarKind.Recurring ? AccrualMethod.TargetByDate : form.method
  const targetMinor = form.target.trim() === '' ? 0 : parseMinor(form.target)
  if (targetMinor === null || targetMinor < 0) return null
  const initialMinor = editing || form.initialAllocation.trim() === '' ? 0 : parseMinor(form.initialAllocation)
  if (initialMinor === null || initialMinor < 0) return null
  if (method === AccrualMethod.TargetByDate) {
    if (targetMinor <= 0 || !form.targetDate) return null
    return {
      jarId: jar?.id ?? null,
      kind: form.kind,
      targetAmount: toAmount(targetMinor),
      targetDate: form.targetDate,
      accrual: method,
      monthlyContribution: null,
      includeDeadlineMonth: form.includeDeadlineMonth && deadlineMonthEligible(form.targetDate),
      recurMonths: form.kind === JarKind.Recurring ? form.recurMonths : null,
      initialAllocation: toAmount(initialMinor),
    }
  }
  const monthlyMinor = form.monthly.trim() === '' ? 0 : parseMinor(form.monthly)
  if (monthlyMinor === null || monthlyMinor <= 0) return null
  return {
    jarId: jar?.id ?? null,
    kind: form.kind,
    targetAmount: toAmount(targetMinor),
    targetDate: null,
    accrual: method,
    monthlyContribution: toAmount(monthlyMinor),
    includeDeadlineMonth: false,
    recurMonths: null,
    initialAllocation: toAmount(initialMinor),
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
  /**
   * Edit only: called after DELETE /jars/{id} succeeds. Shown only for a jar that has never
   * held money (rule 27: `canDelete`); any other jar is archived instead.
   */
  onDeleted?: (jar: JarDto) => void
}

/**
 * The one jar form (rule 73): the Jars page and a Budget-page Savings group open this
 * same modal, so a jar is always created with its designated account and, on create,
 * an optional initial allocation of money already held there (rule 77). The schedule it
 * shows comes from the server (POST /jars/schedule) — the same planner that seeds the
 * Savings lines — so what is previewed is what gets planned (W02). `role="dialog"`
 * comes from Modal; mount it conditionally so the focus trap engages.
 */
export function JarFormModal({ jar, accounts, currency, onClose, onSaved, onArchived, onDeleted }: JarFormModalProps) {
  const editing = jar !== null
  const eligible = useMemo(() => jarAccounts(accounts), [accounts])
  const [form, setForm] = useState<FormState>(() => initialForm(jar, eligible))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Rule 34: the server's warning when the chosen account is the user's private one. Nothing is
  // shared until they pick "Share the account and continue".
  const [privateWarning, setPrivateWarning] = useState<string | null>(null)
  // One deliberate step between "Archive jar" / "Delete jar" and it actually happening.
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // The server's schedule for the definition it was asked about (`key`), so a stale answer is
  // never shown for a definition that can no longer be planned.
  const [preview, setPreview] = useState<{ key: string; schedule: JarScheduleDto | null } | null>(null)

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const heldIn = useMemo(
    () => eligible.find((a) => a.id === form.fundingAccountId) ?? null,
    [eligible, form.fundingAccountId],
  )

  const method = form.kind === JarKind.Recurring ? AccrualMethod.TargetByDate : form.method
  const byDeadline = method === AccrualMethod.TargetByDate

  // The cycle dropdown offers the common cadences; if an edited jar carries a value
  // set via the API that isn't one of them (e.g. 24), keep it as an option so the
  // select shows it rather than silently rewriting it on the next save.
  const recurOptions = useMemo(() => {
    if (RECUR_MONTHS_OPTIONS.some((o) => o.value === form.recurMonths)) return RECUR_MONTHS_OPTIONS
    return [...RECUR_MONTHS_OPTIONS, { value: form.recurMonths, label: `Every ${form.recurMonths} months` }]
  }, [form.recurMonths])

  // Ask the server for the schedule whenever the definition can be planned, a moment after
  // typing stops. Hidden while it can't (blank/invalid target, no deadline or monthly amount)
  // and while the edited jar's balance is unavailable (rule 67: nothing to plan from).
  const request = useMemo(() => definition(form, jar, editing), [form, jar, editing])
  const requestKey = request && !(jar && jar.currentBalance === null) ? JSON.stringify(request) : null
  useEffect(() => {
    if (!requestKey) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      api
        .post<JarScheduleDto>('/jars/schedule', JSON.parse(requestKey) as JarScheduleRequest)
        .then(({ data }) => {
          if (!cancelled) setPreview({ key: requestKey, schedule: data && Array.isArray(data.months) ? data : null })
        })
        .catch(() => {
          if (!cancelled) setPreview({ key: requestKey, schedule: null })
        })
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [requestKey])
  // While a re-ask is in flight the last schedule stays up (no flicker between keystrokes);
  // it is dropped the moment the definition can't be planned at all.
  const schedule = requestKey && preview ? preview.schedule : null

  const submit = useCallback(async (shareAccount = false) => {
    if (form.name.trim() === '') {
      setError('Give the jar a name.')
      return
    }
    const targetAmount = parseAmount(form.target)
    const monthlyContribution = parseAmount(form.monthly)
    const initialAllocation = editing ? 0 : parseAmount(form.initialAllocation)
    if (targetAmount === null || initialAllocation === null || monthlyContribution === null) {
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
    // Rule 17: a target is saved by a deadline or at a fixed monthly amount; a recurring jar
    // rolls its date forward each cycle, so it needs a date (and a real target) to roll.
    if (form.kind === JarKind.Recurring) {
      if (targetAmount <= 0) {
        setError('Give the recurring jar a target amount.')
        return
      }
      if (!form.targetDate) {
        setError('Give the recurring jar its next due date.')
        return
      }
    } else if (byDeadline) {
      if (targetAmount <= 0) {
        setError('Give the goal a target amount.')
        return
      }
      if (!form.targetDate) {
        setError('Give the goal a deadline, or save a fixed amount each month instead.')
        return
      }
    } else if (monthlyContribution <= 0) {
      setError('Enter the amount to set aside each month.')
      return
    }

    const common = {
      name: form.name.trim(),
      kind: form.kind,
      targetAmount,
      targetDate: byDeadline ? form.targetDate : null,
      accrual: method,
      monthlyContribution: byDeadline ? null : monthlyContribution,
      includeDeadlineMonth: byDeadline && form.includeDeadlineMonth && deadlineMonthEligible(form.targetDate),
      fundingAccountId: form.fundingAccountId,
      recurMonths: form.kind === JarKind.Recurring ? form.recurMonths : null,
      // Sent only as the user's answer to the rule 34 warning.
      ...(shareAccount ? { shareAccount: true } : {}),
    }

    setSaving(true)
    setError(null)
    setPrivateWarning(null)
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
      const warning = privateAccountWarning(err)
      if (warning) {
        setPrivateWarning(warning)
        return
      }
      // A 400 carries the server's field messages (e.g. a FundingAccountId change refused
      // while the jar holds money, rule 80; an allocation above the unallocated funds).
      setError(serverErrors(err) ?? (editing ? 'Could not save that jar.' : 'Could not add that jar.'))
    } finally {
      setSaving(false)
    }
  }, [form, editing, jar, onSaved, byDeadline, method])

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

  // Rule 27: a jar that never held money can be deleted outright, with its planned lines.
  const remove = useCallback(async () => {
    if (!jar || !onDeleted) return
    setSaving(true)
    setError(null)
    try {
      await api.delete(`/jars/${jar.id}`)
      track(EVENTS.fundDeleted)
      onDeleted(jar)
    } catch (err) {
      // The server refuses a jar that has held money and points at Archive instead.
      setError(serverErrors(err) ?? 'Could not delete that jar.')
    } finally {
      setSaving(false)
    }
  }, [jar, onDeleted])

  const noAccounts = eligible.length === 0
  const today = todayIso()
  const deadlineMonthOption = byDeadline && form.targetDate !== '' && deadlineMonthEligible(form.targetDate)

  return (
    <Modal title={editing ? 'Edit jar' : 'New jar'} onClose={onClose} size="lg">
      {error && (
        <div className="mb-3">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}
      {privateWarning && (
        <div
          role="alert"
          className="mb-3 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-100"
        >
          <p>{privateWarning}</p>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPrivateWarning(null)}>
              Pick another account
            </Button>
            <Button size="sm" onClick={() => submit(true)} disabled={saving}>
              Share the account and continue
            </Button>
          </div>
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
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1 text-xs font-medium text-slate-500">
              <label htmlFor="jar-type">Type</label>
              <InfoHint label="About jar types">
                <span className="block font-semibold text-slate-700">Recurring</span>
                Saves toward a due date, then repeats: mark each cycle paid when the bill
                is settled and it moves on to the next due date; a cycle that reaches its
                target rolls on by itself, one that falls short says so until you act
                (insurance, road tax, holiday).
                <span className="mt-2 block font-semibold text-slate-700">Goal</span>
                A one-off savings target — once it&rsquo;s funded, it&rsquo;s done (new kitchen,
                sofa, wedding) — or an ongoing pot you top up by a fixed amount each month.
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
          {form.kind === JarKind.Goal && (
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Save
              <Select value={form.method} aria-label="How to save" onChange={(e) => set('method', Number(e.target.value))} className="w-full">
                {METHOD_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </label>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
            {byDeadline ? 'Target' : 'Target (optional)'}
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
          ) : byDeadline ? (
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Deadline
              <Input
                type="date"
                value={form.targetDate}
                aria-label="Deadline"
                onChange={(e) => set('targetDate', e.target.value)}
                className="w-full"
              />
            </label>
          ) : (
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
              Each month
              <Input
                type="text"
                inputMode="decimal"
                {...selectOnFocusProps}
                value={form.monthly}
                placeholder="0.00"
                aria-label="Monthly amount"
                onChange={(e) => set('monthly', e.target.value)}
                className="w-full text-right tabular-nums"
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
            {heldIn?.isPrivate && (
              <span className="text-[11px] font-normal text-slate-500">
                This account is private. A jar is part of the household budget, so saving it here asks you to share the account.
              </span>
            )}
          </label>
        </div>
        {deadlineMonthOption && (
          <label className="flex items-start gap-2 text-xs font-medium text-slate-500">
            <input
              type="checkbox"
              checked={form.includeDeadlineMonth}
              aria-label="Include the deadline month"
              onChange={(e) => set('includeDeadlineMonth', e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            <span>
              Also set aside money in {monthYear(form.targetDate)}, the deadline month.
              <span className="block font-normal">
                By default the plan finishes the month before, so the money is already in {heldIn?.name ?? 'the account'} on{' '}
                {formatDate(form.targetDate)}. Tick this only if that month&rsquo;s contribution will reach the account before the deadline.
              </span>
            </span>
          </label>
        )}
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
        {schedule && <SchedulePreview schedule={schedule} currency={currency} recurring={form.kind === JarKind.Recurring} recurMonths={form.recurMonths} />}
        <div className="flex items-center justify-between gap-2 pt-1">
          {jar && (onArchived || (onDeleted && jar.canDelete)) ? (
            <span className="flex flex-wrap gap-1">
              {onArchived && (
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
              )}
              {onDeleted && jar.canDelete && (
                // Rule 27: only a jar that has never held money offers Delete; two clicks as well.
                <button
                  type="button"
                  onClick={() => (confirmDelete ? remove() : setConfirmDelete(true))}
                  disabled={saving}
                  aria-label={confirmDelete ? `Confirm delete ${jar.name}` : `Delete ${jar.name}`}
                  title="This jar has never held money, so it can be deleted with its planned lines."
                  className={`rounded-lg px-2 py-1.5 text-sm font-semibold transition disabled:opacity-50 ${
                    confirmDelete
                      ? 'bg-rose-50 text-rose-600 hover:bg-rose-100'
                      : 'text-slate-500 hover:bg-rose-50 hover:text-rose-600'
                  }`}
                >
                  {confirmDelete ? 'Really delete?' : 'Delete jar'}
                </button>
              )}
            </span>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} aria-label="Cancel edit">
              Cancel
            </Button>
            <Button onClick={() => submit()} disabled={saving || (!editing && noAccounts)} aria-label={editing ? 'Save jar' : 'Add jar'}>
              {editing ? 'Save' : 'Add jar'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

/** How many planned months are listed in full before the rest is summarised. */
const LISTED_MONTHS = 12

/**
 * The server's schedule, as the user will see it on the Savings lines: each month's amount
 * (the rounding remainder visibly in the last one, rule 35), when funding completes against
 * the deadline (rule 36), a fixed monthly target's estimate (rule 58), and any month whose
 * budget the contribution would push over its income (rule 59) — shown in full, never trimmed.
 */
function SchedulePreview({
  schedule,
  currency,
  recurring,
  recurMonths,
}: {
  schedule: JarScheduleDto
  currency: string
  recurring: boolean
  recurMonths: number
}) {
  const money = (amount: number) => formatMoney(fromAmount(amount), currency)
  const months = schedule.months
  const uniform = months.length > 0 && months.every((m) => m.planned === months[0].planned)
  const over = months.filter((m) => m.shortfall !== null && m.shortfall > 0)
  const skipped = months.filter((m) => m.skipped)

  let summary: string
  if (!schedule.hasSchedule) {
    summary = 'Add a deadline or a monthly amount to plan contributions.'
  } else if (schedule.isOngoing) {
    summary = `Sets aside ${money(months[0]?.planned ?? 0)} every month, ongoing.`
  } else if (months.length === 0 || months.every((m) => m.skipped || m.planned === 0)) {
    summary =
      schedule.unplanned > 0
        ? `Nothing is planned: every remaining month is skipped, leaving ${money(schedule.unplanned)} unplanned.`
        : 'Already funded — nothing more to set aside.'
  } else if (schedule.accrual === AccrualMethod.FixedMonthly) {
    const n = schedule.estimatedMonths ?? months.length
    summary = `Sets aside ${money(months[0].planned)} a month — about ${n} more month${n === 1 ? '' : 's'} to reach the target (an estimate, not a deadline).`
  } else {
    const span =
      months.length === 1
        ? `in ${monthYear(monthIso(months[0].year, months[0].month))}`
        : `from ${monthYear(monthIso(months[0].year, months[0].month))} to ${monthYear(monthIso(months[months.length - 1].year, months[months.length - 1].month))}`
    const amount = uniform ? `${money(months[0].planned)} a month` : `${money(schedule.total)} in total`
    const completes = schedule.fundingCompletesOn ? `, funded by ${formatDate(schedule.fundingCompletesOn)}` : ''
    const due = schedule.deadline ? ` for the deadline on ${formatDate(schedule.deadline)}` : ''
    const repeats = recurring ? `, then it repeats every ${recurMonths === 12 ? 'year' : `${recurMonths} months`}` : ''
    summary = `Sets aside ${amount} ${span}${completes}${due}${repeats}.`
  }

  const listed = schedule.isOngoing ? [] : months.slice(0, LISTED_MONTHS)
  const showList = listed.length > 0 && (!uniform || over.length > 0 || skipped.length > 0 || listed.length <= 6)

  return (
    <div
      aria-live="polite"
      data-testid="jar-schedule-preview"
      className="rounded-lg bg-slate-100 px-3 py-2 text-[12.5px] font-medium tabular-nums text-slate-600"
    >
      <p className="text-slate-900">{summary}</p>
      {showList && (
        <ul className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
          {listed.map((m) => (
            <li key={`${m.year}-${m.month}`} className="flex justify-between gap-2">
              <span>{monthYear(monthIso(m.year, m.month))}</span>
              <span className={m.shortfall !== null && m.shortfall > 0 ? 'text-rose-600 dark:text-rose-400' : m.skipped ? 'text-slate-400' : ''}>
                {m.skipped ? 'Skipped' : money(m.planned)}
              </span>
            </li>
          ))}
          {months.length > listed.length && (
            <li className="col-span-full text-slate-500">… and {months.length - listed.length} more months</li>
          )}
        </ul>
      )}
      {schedule.unplanned > 0 && months.some((m) => m.planned > 0) && (
        <p role="status" className="mt-1.5 text-rose-600 dark:text-rose-400">
          {money(schedule.unplanned)} stays unplanned by the deadline because of the skipped months.
        </p>
      )}
      {over.length > 0 && (
        <p role="status" className="mt-1.5 text-rose-600 dark:text-rose-400">
          Over budget: {over.map((m) => `${monthYear(monthIso(m.year, m.month))} by ${money(m.shortfall ?? 0)}`).join(', ')}. The full
          contribution stays planned; adjust other lines if you need to.
        </p>
      )}
    </div>
  )
}

/** Rule 34: the server refuses a jar in the user's private account with this key until they choose to share it. */
function privateAccountWarning(err: unknown): string | null {
  const e = err as { response?: { status?: number; data?: { errors?: Record<string, string[]> } } }
  if (e?.response?.status !== 400) return null
  return e.response.data?.errors?.accountPrivate?.[0] ?? null
}

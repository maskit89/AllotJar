import { Fragment, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { Badge, Button, Card, ErrorBanner, Input, PageHeader, Select } from '../components/ui'
import { Modal } from '../components/Modal'
import { api, commitImport, previewImport, type StatementFormat } from '../lib/api'
import { bucketCount, EVENTS, track } from '../analytics'
import { useAuth } from '../auth/AuthContext'
import type {
  AccountDto,
  BudgetMonthDto,
  CommitImportItem,
  CsvDecimalStyle,
  CsvLayout,
  CsvMapping,
  HouseholdMemberDto,
  ImportCandidate,
  ImportPreviewResult,
  ImportStatementResult,
} from '../types'
import { TransactionType } from '../types'
import { buildItemOptions, type ItemOptionGroup } from '../lib/transactions'
import { formatMoney, fromAmount, parseMinor, sumMinor, toAmount } from '../lib/money'
import { selectOnFocusProps } from '../lib/selectOnFocus'
import { formatDate, monthYear } from '../lib/dates'

type Format = 'generic' | 'hsbc' | 'camt'
type Phase = 'upload' | 'review' | 'done'

const FORMATS: Record<Format, { label: string; accept: string; hint: string; wire: StatementFormat }> = {
  generic: {
    label: 'Bank CSV (auto-detect)',
    accept: '.csv,text/csv',
    hint: "Most banks' CSV export. Known formats (like the HSBC transaction history) are recognised automatically; otherwise you'll confirm which columns are the date, amount and description.",
    wire: 'GenericCsv',
  },
  hsbc: {
    label: 'HSBC transaction history (CSV)',
    accept: '.csv,text/csv',
    hint: 'The Date, Details, Amount export from HSBC personal banking.',
    wire: 'HsbcCsv',
  },
  camt: {
    label: 'CAMT.053 statement (XML)',
    accept: '.xml,text/xml,application/xml',
    hint: 'An ISO 20022 SEPA bank-to-customer statement.',
    wire: 'Camt053',
  },
}

/** Human names for the parser the server actually used, keyed by the wire StatementFormat. */
const DETECTED_FORMAT_LABELS: Record<string, string> = {
  HsbcCsv: 'an HSBC transaction history export',
  Camt053: 'a CAMT.053 statement',
}

/**
 * Date-format presets for the generic-CSV mapping (value is the .NET format, or '' = auto-detect).
 * Mirrors the server's GenericCsvImporter.DateFormats: after an auto-detect scan the server pins
 * the format it actually applied into the echoed mapping, and the select must be able to SHOW
 * whichever one that was — an unrepresentable value would render as a blank selection.
 */
const DATE_FORMAT_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Auto-detect' },
  { value: 'yyyy-MM-dd', label: 'YYYY-MM-DD' },
  { value: 'yyyy/MM/dd', label: 'YYYY/MM/DD' },
  { value: 'dd/MM/yyyy', label: 'DD/MM/YYYY' },
  { value: 'MM/dd/yyyy', label: 'MM/DD/YYYY' },
  { value: 'dd.MM.yyyy', label: 'DD.MM.YYYY' },
  { value: 'd/M/yyyy', label: 'D/M/YYYY' },
  { value: 'M/d/yyyy', label: 'M/D/YYYY' },
  { value: 'dd-MM-yyyy', label: 'DD-MM-YYYY' },
  { value: 'yyyyMMdd', label: 'YYYYMMDD' },
  { value: 'dd MMM yyyy', label: 'DD MON YYYY' },
  { value: 'MMM d, yyyy', label: 'MON D, YYYY' },
  { value: 'dd/MM/yy', label: 'DD/MM/YY' },
  { value: 'MM/dd/yy', label: 'MM/DD/YY' },
  { value: 'd/M/yy', label: 'D/M/YY' },
  { value: 'M/d/yy', label: 'M/D/YY' },
  { value: 'dd.MM.yy', label: 'DD.MM.YY' },
  { value: 'dd-MM-yy', label: 'DD-MM-YY' },
]

interface SplitDraft {
  budgetItemId: string
  amount: string
  memberId: string
}

interface ReviewRow {
  reference: string
  date: string
  payee: string
  amount: number
  currency: string
  isCredit: boolean
  include: boolean
  budgetItemId: string
  memberId: string
  /** Null = a single-category row; an array = split across these lines. */
  splits: SplitDraft[] | null
  /** Heuristic hint from the preview. */
  likelyTransfer: boolean
  /** Content-level hint that an existing transaction already matches this row; unticked by default. */
  possibleDuplicate: boolean
  /** When true, the row is a transfer to/from `transferAccountId` instead of income/spending. */
  isTransfer: boolean
  transferAccountId: string
}

/** Pull a human message out of an axios error (ProblemDetails `title`, or a 400 `error`). */
function errorMessage(err: unknown): string {
  const data = (err as { response?: { data?: { title?: string; error?: string } } }).response?.data
  return data?.title ?? data?.error ?? 'Something went wrong. Please check the file and try again.'
}

/** Pre-fill a row's category from the server's payee suggestion, resolved to a current-month line. */
function resolveSuggestion(c: ImportCandidate, month: BudgetMonthDto | null): string {
  const type = c.isCredit ? TransactionType.Income : TransactionType.Expense
  const flat = buildItemOptions(month, type).flatMap((g) => g.items)
  if (c.suggestedBudgetItemId && flat.some((i) => i.id === c.suggestedBudgetItemId)) {
    return c.suggestedBudgetItemId
  }
  if (c.suggestedBudgetItemName) {
    const byName = flat.find((i) => i.name === c.suggestedBudgetItemName)
    if (byName) return byName.id
  }
  return ''
}

/** The label for a .NET date format, for the "we read your dates as …" readout. */
function dateFormatLabel(format: string | null | undefined): string | null {
  if (!format) return null
  return DATE_FORMAT_OPTIONS.find((o) => o.value === format)?.label ?? format
}

/**
 * Sum the included rows matching <paramref name="predicate"/>, grouped by currency (a statement is
 * usually single-currency, but mixed imports must still add up correctly rather than across
 * currencies). Amounts are accumulated in minor units.
 */
function moneyByCurrency(
  rows: ReviewRow[],
  predicate: (r: ReviewRow) => boolean,
): { currency: string; minor: number }[] {
  const byCurrency = new Map<string, number>()
  for (const r of rows) {
    if (!r.include || !predicate(r)) continue
    byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + fromAmount(r.amount))
  }
  return [...byCurrency.entries()].map(([currency, minor]) => ({ currency, minor }))
}

/** Validity + remaining-to-allocate for a row's split (in minor units). */
function splitInfo(row: ReviewRow): { valid: boolean; remainingMinor: number } {
  if (!row.splits) return { valid: true, remainingMinor: 0 }
  const minors = row.splits.map((l) => parseMinor(l.amount) ?? -1)
  const allocated = sumMinor(minors.map((m) => (m < 0 ? 0 : m)))
  const remainingMinor = fromAmount(row.amount) - allocated
  const valid =
    row.splits.length >= 2 &&
    row.splits.every((l, i) => l.budgetItemId !== '' && minors[i] > 0) &&
    remainingMinor === 0
  return { valid, remainingMinor }
}

function CategoryOptions({ groups }: { groups: ItemOptionGroup[] }) {
  return (
    <>
      <option value="">Unassigned</option>
      {groups.map((g) => (
        <optgroup key={g.category} label={g.category}>
          {g.items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  )
}

export function ImportPage() {
  // Importing a statement creates/edits budget structure, so it needs Admin+ (canWrite).
  const { canWrite, preferredCurrency } = useAuth()
  const [phase, setPhase] = useState<Phase>('upload')
  const [format, setFormat] = useState<Format>('generic')
  const [file, setFile] = useState<File | null>(null)
  const [accountId, setAccountId] = useState('')

  const [accounts, setAccounts] = useState<AccountDto[]>([])
  const [month, setMonth] = useState<BudgetMonthDto | null>(null)
  const [members, setMembers] = useState<HouseholdMemberDto[]>([])

  const [preview, setPreview] = useState<ImportPreviewResult | null>(null)
  const [rows, setRows] = useState<ReviewRow[]>([])
  // Generic-CSV column mapping: the detected layout + the (editable) mapping applied to the preview.
  const [layout, setLayout] = useState<CsvLayout | null>(null)
  const [mapping, setMapping] = useState<CsvMapping | null>(null)
  // The mapping that produced the CURRENT preview rows. Compared against `mapping` to tell when the
  // user has edited the mapping but not re-scanned — so we never import a stale parse silently.
  const [scannedMapping, setScannedMapping] = useState<CsvMapping | null>(null)
  const [splitOpen, setSplitOpen] = useState<string | null>(null)
  const [bulkMember, setBulkMember] = useState('')
  const [bulkCategory, setBulkCategory] = useState('')

  const [result, setResult] = useState<ImportStatementResult | null>(null)
  // Count of categorised rows dated outside the loaded budget month — set when Import needs the
  // one-per-batch cross-month confirmation before committing.
  const [crossMonthCount, setCrossMonthCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      api.get<AccountDto[]>('/accounts').catch(() => null),
      api.get<BudgetMonthDto>('/budget/current').catch(() => null),
      api.get<HouseholdMemberDto[]>('/members').catch(() => null),
    ]).then(([acc, bud, mem]) => {
      if (cancelled) return
      setAccounts(Array.isArray(acc?.data) ? acc.data : [])
      setMonth(bud?.data ?? null)
      setMembers(Array.isArray(mem?.data) ? mem.data : [])
    })
    return () => {
      cancelled = true
    }
  }, [])

  const expenseGroups = useMemo(() => buildItemOptions(month, TransactionType.Expense), [month])
  const includedCount = useMemo(() => rows.filter((r) => r.include).length, [rows])
  const possibleDuplicateCount = useMemo(() => rows.filter((r) => r.possibleDuplicate).length, [rows])
  // The mapping has unsaved edits when it differs from the one that produced the current rows.
  const mappingDirty = useMemo(
    () => !!mapping && !!scannedMapping && JSON.stringify(mapping) !== JSON.stringify(scannedMapping),
    [mapping, scannedMapping],
  )
  const importAccount = accounts.find((a) => a.id === accountId) ?? null
  const otherAccounts = accounts.filter((a) => a.id !== accountId)
  // A transfer needs an import account plus another account to move to/from.
  const canTransfer = !!accountId && otherAccounts.length > 0
  // Block the import while a split doesn't add up, or a transfer hasn't picked a counterparty.
  const reviewIncomplete = useMemo(
    () =>
      rows.some(
        (r) =>
          r.include &&
          ((r.splits && !splitInfo(r).valid) || (r.isTransfer && !r.transferAccountId)),
      ),
    [rows],
  )

  // Fold a preview result into the review state (shared by the first upload and CSV re-scans).
  // On a re-scan, `priorRows` carries the user's per-row work forward for any row whose identity
  // (reference) is unchanged — the reference encodes date+amount+description, so a matching row is
  // genuinely the same transaction and its category/split/transfer choices still apply.
  function applyPreview(data: ImportPreviewResult, priorRows?: ReviewRow[]) {
    setPreview(data)
    const prior = new Map((priorRows ?? []).map((r) => [r.reference, r]))
    setRows(
      data.items.map((c) => {
        const kept = prior.get(c.reference)
        return {
          reference: c.reference,
          date: c.date,
          payee: c.payee,
          amount: c.amount,
          currency: c.currency,
          isCredit: c.isCredit,
          // Rows that look already-imported start unticked — the user opts them back in.
          include: kept ? kept.include : !c.possibleDuplicate,
          budgetItemId: kept ? kept.budgetItemId : resolveSuggestion(c, month),
          memberId: kept ? kept.memberId : '',
          splits: kept ? kept.splits : null,
          likelyTransfer: c.likelyTransfer,
          possibleDuplicate: c.possibleDuplicate ?? false,
          isTransfer: kept ? kept.isTransfer : false,
          transferAccountId: kept ? kept.transferAccountId : '',
        }
      }),
    )
    setLayout(data.layout ?? null)
    if (data.layout) {
      setMapping(data.layout.suggested)
      setScannedMapping(data.layout.suggested)
    }
    setSplitOpen(null)
  }

  async function onPreview(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      // Generic CSV auto-detects the layout on first upload; send the home currency as the
      // fallback. The chosen account scopes the server's already-imported filter to the same
      // account the commit will dedup against.
      const opts = {
        ...(format === 'generic' ? { defaultCurrency: preferredCurrency } : {}),
        accountId: accountId || null,
      }
      const data = await previewImport(file, FORMATS[format].wire, opts)
      applyPreview(data)
      setPhase('review')
      track(EVENTS.importPreviewed, { row_bucket: bucketCount(data.items.length) })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  // Re-parse the same CSV with the user's corrected column mapping and refresh the preview rows,
  // carrying forward the categorisation the user has already done for rows that survive unchanged.
  async function reScanCsv() {
    if (!file || !mapping) return
    setBusy(true)
    setError(null)
    try {
      const priorRows = rows
      const data = await previewImport(file, 'GenericCsv', {
        mapping,
        defaultCurrency: preferredCurrency,
        accountId: accountId || null,
      })
      applyPreview(data, priorRows)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  function updateRow(index: number, patch: Partial<ReviewRow>) {
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  function setAllIncluded(include: boolean) {
    setRows((rs) => rs.map((r) => ({ ...r, include })))
  }

  // Bulk actions apply to included rows that are plain (not split, not a transfer).
  function applyMemberToIncluded() {
    setRows((rs) => rs.map((r) => (r.include && !r.splits && !r.isTransfer ? { ...r, memberId: bulkMember } : r)))
  }
  function applyCategoryToIncluded() {
    setRows((rs) =>
      rs.map((r) => (r.include && !r.splits && !r.isTransfer && !r.isCredit ? { ...r, budgetItemId: bulkCategory } : r)),
    )
  }

  // --- per-row transfer mode ---
  function startTransfer(index: number) {
    setSplitOpen(null)
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, isTransfer: true, splits: null } : r)))
  }
  function clearTransfer(index: number) {
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, isTransfer: false, transferAccountId: '' } : r)))
  }

  // --- per-row split editing ---
  function startSplit(index: number, ref: string) {
    setRows((rs) =>
      rs.map((r, i) =>
        i === index && !r.splits
          ? {
              ...r,
              splits: [
                { budgetItemId: r.budgetItemId, amount: '', memberId: r.memberId },
                { budgetItemId: '', amount: '', memberId: '' },
              ],
            }
          : r,
      ),
    )
    setSplitOpen(ref)
  }
  function clearSplit(index: number) {
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, splits: null } : r)))
    setSplitOpen(null)
  }
  function updateSplitLine(index: number, li: number, patch: Partial<SplitDraft>) {
    setRows((rs) =>
      rs.map((r, i) =>
        i === index && r.splits
          ? { ...r, splits: r.splits.map((l, j) => (j === li ? { ...l, ...patch } : l)) }
          : r,
      ),
    )
  }
  function addSplitLine(index: number) {
    setRows((rs) =>
      rs.map((r, i) =>
        i === index && r.splits ? { ...r, splits: [...r.splits, { budgetItemId: '', amount: '', memberId: '' }] } : r,
      ),
    )
  }
  function removeSplitLine(index: number, li: number) {
    setRows((rs) =>
      rs.map((r, i) =>
        i === index && r.splits && r.splits.length > 2
          ? { ...r, splits: r.splits.filter((_, j) => j !== li) }
          : r,
      ),
    )
  }

  /** A row categorised (line or split) whose date falls outside the loaded budget month —
   *  committing it budgets money to a different month than it was spent, which needs an
   *  explicit confirmation (the categories on offer are always the current month's lines). */
  function isCrossMonthRow(r: ReviewRow): boolean {
    if (!month || (!r.budgetItemId && !r.splits) || r.isTransfer) return false
    return Number(r.date.slice(0, 4)) !== month.year || Number(r.date.slice(5, 7)) !== month.month
  }

  async function onCommit(acknowledgeCrossMonth = false) {
    const items: CommitImportItem[] = rows
      .filter((r) => r.include)
      .map((r) => {
        const base = {
          reference: r.reference,
          date: r.date,
          payee: r.payee,
          amount: r.amount,
          currency: r.currency,
          isCredit: r.isCredit,
        }
        if (r.isTransfer) {
          return { ...base, budgetItemId: null, memberId: null, transferAccountId: r.transferAccountId }
        }
        const acknowledged = acknowledgeCrossMonth && isCrossMonthRow(r) ? { acknowledgeCrossMonth: true } : {}
        if (r.splits) {
          return {
            ...base,
            budgetItemId: null,
            memberId: null,
            splits: r.splits.map((l) => ({
              budgetItemId: l.budgetItemId,
              amount: toAmount(parseMinor(l.amount) ?? 0),
              memberId: l.memberId || null,
            })),
            ...acknowledged,
          }
        }
        return { ...base, budgetItemId: r.budgetItemId || null, memberId: r.memberId || null, ...acknowledged }
      })
    // Never commit a stale parse (the Import button is already disabled while dirty; this guards
    // against any future path that reaches onCommit without that gate).
    if (items.length === 0 || mappingDirty) return

    // Historical rows put on this month's lines are a deliberate choice — confirm once for the
    // batch, then re-run with the affected rows acknowledged (the server rejects them otherwise).
    const affected = rows.filter((r) => r.include && isCrossMonthRow(r)).length
    if (affected > 0 && !acknowledgeCrossMonth) {
      setCrossMonthCount(affected)
      return
    }

    setBusy(true)
    setError(null)
    try {
      setResult(await commitImport(accountId || null, items))
      setPhase('done')
      setCrossMonthCount(null)
      track(EVENTS.importCommitted, { row_bucket: bucketCount(items.length) })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  function reset() {
    setPhase('upload')
    setFile(null)
    setPreview(null)
    setRows([])
    setLayout(null)
    setMapping(null)
    setScannedMapping(null)
    setSplitOpen(null)
    setResult(null)
    setError(null)
    setBulkMember('')
    setBulkCategory('')
    setCrossMonthCount(null)
  }

  return (
    <AppShell active="transactions" maxWidth="5xl">
      <div>
        <Link to="/transactions" className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-200">
          ← Back to transactions
        </Link>
      </div>
      <PageHeader
        title="Import transactions"
        subtitle="Upload a bank export, review and categorise the new transactions, then import. Re-importing the same file won't create duplicates."
      />

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {!canWrite && (
        <Card className="p-6 text-sm text-slate-600">
          Importing statements is available to admins and the household owner. You can still add
          transactions by hand on the <Link to="/transactions" className="font-medium text-brand-700 hover:underline dark:text-brand-200">Transactions</Link> page.
        </Card>
      )}

      {canWrite && phase === 'upload' && (
        <Card as="section" aria-labelledby="import-form-heading" className="p-6">
          <h2 id="import-form-heading" className="sr-only">
            Upload a statement
          </h2>
          <form className="grid gap-5 sm:max-w-md" onSubmit={onPreview}>
            <div className="grid gap-1.5">
              <label htmlFor="import-format" className="text-sm font-medium text-slate-700">
                File format
              </label>
              <Select
                id="import-format"
                value={format}
                onChange={(e) => {
                  setFormat(e.target.value as Format)
                  setFile(null)
                }}
              >
                {(Object.keys(FORMATS) as Format[]).map((key) => (
                  <option key={key} value={key}>
                    {FORMATS[key].label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-slate-500">{FORMATS[format].hint}</p>
            </div>

            <div className="grid gap-1.5">
              <label htmlFor="import-file" className="text-sm font-medium text-slate-700">
                Statement file
              </label>
              <input
                // Remount on format change so the browser clears the previously-chosen filename —
                // otherwise the input still shows a file that setFile(null) has already dropped,
                // leaving the submit button dead with no explanation.
                key={format}
                id="import-file"
                type="file"
                accept={FORMATS[format].accept}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-brand-700"
              />
            </div>

            <div className="grid gap-1.5">
              <label htmlFor="import-account" className="text-sm font-medium text-slate-700">
                Add to account <span className="font-normal text-slate-500">(optional)</span>
              </label>
              <Select id="import-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">Don't link to an account</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-slate-500">
                Stamps each transaction onto this account so its balance reflects the import.
              </p>
            </div>

            <div>
              <Button type="submit" disabled={!file || busy}>
                {busy ? 'Reading…' : 'Review transactions'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Everything in the file was already imported — a success, not an empty grid to puzzle over. */}
      {canWrite && phase === 'review' && preview && rows.length === 0 && (
        <Card as="section" aria-labelledby="import-caughtup-heading" className="p-6">
          <h2 id="import-caughtup-heading" className="text-lg font-semibold text-slate-900">
            You’re all caught up
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Every transaction in this file is already in AllotJar
            {preview.skippedDuplicates > 0
              ? ` — all ${preview.skippedDuplicates} were skipped as duplicates.`
              : '.'}{' '}
            Nothing new to import.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button onClick={reset}>Import another file</Button>
            <Link
              to="/transactions"
              className="inline-flex items-center text-sm font-medium text-brand-700 hover:underline dark:text-brand-200"
            >
              View transactions →
            </Link>
          </div>
        </Card>
      )}

      {canWrite && phase === 'review' && preview && rows.length > 0 && (
        <>
          <p className="text-sm text-slate-600">
            <span className="font-semibold text-slate-800">{preview.newCount}</span> new transaction
            {preview.newCount === 1 ? '' : 's'} to review
            {preview.skippedDuplicates > 0 &&
              ` — ${preview.skippedDuplicates} already imported (skipped)`}
            {possibleDuplicateCount > 0 &&
              ` — ${possibleDuplicateCount} possible duplicate${possibleDuplicateCount === 1 ? '' : 's'} unticked (tick to include)`}
            . Categorise them (split a row, or mark a transfer), untick any you don't want, then import.
          </p>
          {possibleDuplicateCount > 0 && (
            <p className="-mt-3 text-xs text-slate-500">
              A row is flagged as a possible duplicate when an existing transaction has the same amount and a
              similar payee within a few days — tick it to import anyway (e.g. two genuine identical purchases).
            </p>
          )}
          {format === 'generic' && preview.detectedFormat && DETECTED_FORMAT_LABELS[preview.detectedFormat] && (
            <p className="-mt-3 text-xs text-slate-500">
              We recognised this file as {DETECTED_FORMAT_LABELS[preview.detectedFormat]} and read it with the
              dedicated importer, so payees and duplicate detection stay consistent.
            </p>
          )}
          {importAccount && (
            <p className="-mt-3 text-xs text-slate-500">
              Importing into <span className="font-medium text-slate-700">{importAccount.name}</span>.
            </p>
          )}
          {!accountId && rows.some((r) => r.likelyTransfer) && (
            <p className="-mt-3 text-xs text-amber-700 dark:text-amber-400">
              Some rows look like transfers between your accounts. Re-import with an account selected (on the
              previous step) to record them as transfers.
            </p>
          )}

          {/* Generic-CSV column mapping — confirm/correct what we guessed, then re-scan. */}
          {format === 'generic' && layout && mapping && (
            <Card as="section" aria-labelledby="csv-mapping-heading" className="grid gap-4 p-5">
              <div>
                <h2 id="csv-mapping-heading" className="text-sm font-bold text-slate-800">
                  Column mapping
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  We guessed how to read your file. If the preview below looks off, fix a column and re-scan.
                  {mapping.dateFormat && (
                    <>
                      {' '}We read your dates as{' '}
                      <span className="font-semibold text-slate-700">{dateFormatLabel(mapping.dateFormat)}</span>
                      {' '}— change the date format below if that’s wrong.
                    </>
                  )}
                </p>
              </div>

              {/* The first few rows exactly as parsed, so the user can see which column is which.
                  No dark: overrides — the slate scale is remapped for dark mode in index.css, so
                  plain slate classes flip automatically (raising the number in a dark: variant would
                  invert to a light, low-contrast colour — see the review table below). */}
              {layout.sampleRows.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-left text-xs">
                    <caption className="sr-only">Sample of the uploaded file</caption>
                    <thead>
                      <tr className="bg-slate-50 text-slate-500">
                        {layout.columns.map((name, i) => (
                          <th key={i} scope="col" className="whitespace-nowrap px-3 py-1.5 font-medium">
                            {name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {layout.sampleRows.map((row, ri) => (
                        <tr key={ri}>
                          {layout.columns.map((_, ci) => (
                            <td key={ci} className="whitespace-nowrap px-3 py-1.5 tabular-nums text-slate-600">
                              {row[ci] ?? ''}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <label className="grid gap-1 text-xs font-medium text-slate-500">
                  Date column
                  <Select
                    aria-label="Date column"
                    value={mapping.dateColumn}
                    onChange={(e) => setMapping((m) => (m ? { ...m, dateColumn: Number(e.target.value) } : m))}
                  >
                    {layout.columns.map((name, i) => (
                      <option key={i} value={i}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="grid gap-1 text-xs font-medium text-slate-500">
                  Amount column (signed)
                  <Select
                    aria-label="Amount column"
                    value={mapping.amountColumn}
                    onChange={(e) => setMapping((m) => (m ? { ...m, amountColumn: Number(e.target.value) } : m))}
                  >
                    {layout.columns.map((name, i) => (
                      <option key={i} value={i}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="grid gap-1 text-xs font-medium text-slate-500">
                  Description column
                  <Select
                    aria-label="Description column"
                    value={mapping.descriptionColumn}
                    onChange={(e) => setMapping((m) => (m ? { ...m, descriptionColumn: Number(e.target.value) } : m))}
                  >
                    {layout.columns.map((name, i) => (
                      <option key={i} value={i}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="grid gap-1 text-xs font-medium text-slate-500">
                  Currency column
                  <Select
                    aria-label="Currency column"
                    value={mapping.currencyColumn ?? ''}
                    onChange={(e) =>
                      setMapping((m) =>
                        m ? { ...m, currencyColumn: e.target.value === '' ? null : Number(e.target.value) } : m,
                      )
                    }
                  >
                    <option value="">Use {preferredCurrency} for every row</option>
                    {layout.columns.map((name, i) => (
                      <option key={i} value={i}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="grid gap-1 text-xs font-medium text-slate-500">
                  Date format
                  <Select
                    aria-label="Date format"
                    value={mapping.dateFormat ?? ''}
                    onChange={(e) =>
                      setMapping((m) => (m ? { ...m, dateFormat: e.target.value === '' ? null : e.target.value } : m))
                    }
                  >
                    {DATE_FORMAT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="grid gap-1 text-xs font-medium text-slate-500">
                  Number format
                  <Select
                    aria-label="Number format"
                    value={mapping.decimalStyle}
                    onChange={(e) =>
                      setMapping((m) => (m ? { ...m, decimalStyle: Number(e.target.value) as CsvDecimalStyle } : m))
                    }
                  >
                    <option value={0}>Auto-detect</option>
                    <option value={1}>1,234.56</option>
                    <option value={2}>1.234,56</option>
                  </Select>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                  <input
                    type="checkbox"
                    checked={mapping.hasHeader}
                    onChange={(e) => setMapping((m) => (m ? { ...m, hasHeader: e.target.checked } : m))}
                    className="h-4 w-4 rounded border-slate-400 text-brand-600 focus:ring-2 focus:ring-brand-500/40"
                  />
                  First row is a header
                </label>
                <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                  Column separator
                  <Select
                    aria-label="Column separator"
                    value={mapping.delimiter}
                    onChange={(e) => setMapping((m) => (m ? { ...m, delimiter: e.target.value } : m))}
                    className="w-32"
                  >
                    <option value=",">Comma ,</option>
                    <option value=";">Semicolon ;</option>
                    <option value={'\t'}>Tab</option>
                    <option value="|">Pipe |</option>
                  </Select>
                </label>
                <Button
                  type="button"
                  variant={mappingDirty ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={reScanCsv}
                  disabled={busy}
                >
                  {busy ? 'Re-scanning…' : mappingDirty ? 'Apply changes & re-scan' : 'Re-scan with this mapping'}
                </Button>
                {mappingDirty && !busy && (
                  <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
                    Re-scan to apply your changes before importing.
                  </span>
                )}
              </div>
            </Card>
          )}

          {/* Bulk actions over the currently-included rows. */}
          <Card className="flex flex-wrap items-end gap-4 p-4">
            <div className="grid gap-1 text-xs font-medium text-slate-500">
              Member
              <div className="flex items-center gap-2">
                <Select aria-label="Bulk member" value={bulkMember} onChange={(e) => setBulkMember(e.target.value)} className="w-40">
                  <option value="">No member</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
                <Button variant="secondary" size="sm" onClick={applyMemberToIncluded} disabled={members.length === 0}>
                  Apply to included
                </Button>
              </div>
            </div>
            <div className="grid gap-1 text-xs font-medium text-slate-500">
              Category (expenses)
              <div className="flex items-center gap-2">
                <Select aria-label="Bulk category" value={bulkCategory} onChange={(e) => setBulkCategory(e.target.value)} className="w-48">
                  <CategoryOptions groups={expenseGroups} />
                </Select>
                <Button variant="secondary" size="sm" onClick={applyCategoryToIncluded} disabled={expenseGroups.length === 0}>
                  Apply to expenses
                </Button>
              </div>
            </div>
          </Card>

          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Transactions to import</caption>
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th scope="col" className="px-3 py-2 font-medium">
                    <input
                      type="checkbox"
                      aria-label="Include all rows"
                      checked={rows.length > 0 && rows.every((r) => r.include)}
                      onChange={(e) => setAllIncluded(e.target.checked)}
                      className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">Date</th>
                  <th scope="col" className="px-3 py-2 font-medium">Payee</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Amount</th>
                  <th scope="col" className="px-3 py-2 font-medium">Category</th>
                  <th scope="col" className="px-3 py-2 font-medium">Member</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r, index) => {
                  const groups = buildItemOptions(month, r.isCredit ? TransactionType.Income : TransactionType.Expense)
                  const nameById = new Map(groups.flatMap((g) => g.items).map((i) => [i.id, i.name]))
                  const info = splitInfo(r)
                  const open = splitOpen === r.reference
                  return (
                    <Fragment key={r.reference}>
                      {/* A flagged-but-unticked row needs its badge readable (an opacity-dimmed
                          row drops the amber text below AA contrast), so it gets an attention
                          tint instead of the excluded-row fade. */}
                      <tr
                        className={
                          r.include
                            ? 'hover:bg-slate-50'
                            : r.possibleDuplicate
                              ? 'bg-amber-50/70 dark:bg-amber-500/10'
                              : 'opacity-50'
                        }
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            aria-label={`Include ${r.payee} on ${r.date}`}
                            checked={r.include}
                            onChange={(e) => updateRow(index, { include: e.target.checked })}
                            className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                          />
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-500">{formatDate(r.date)}</td>
                        <td className="px-3 py-2 font-medium text-slate-700">
                          {r.payee}
                          {r.possibleDuplicate && (
                            <span className="block text-xs font-normal text-amber-700 dark:text-amber-400">
                              Possibly already imported
                            </span>
                          )}
                          {r.likelyTransfer && !r.isTransfer && (
                            <span className="block text-xs font-normal text-amber-700 dark:text-amber-400">
                              Looks like a transfer
                            </span>
                          )}
                        </td>
                        <td
                          className={`whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums ${
                            r.isCredit ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-700'
                          }`}
                        >
                          {r.isCredit ? '+' : '−'}
                          {formatMoney(fromAmount(r.amount), r.currency)}
                        </td>
                        <td className="px-3 py-2">
                          {r.isTransfer ? (
                            <div className="flex items-center gap-2">
                              <Badge tone="brand">Transfer</Badge>
                              <span className="text-xs text-slate-500">{r.isCredit ? 'from' : 'to'}</span>
                              <Select
                                aria-label={`Transfer account for ${r.payee} on ${r.date}`}
                                value={r.transferAccountId}
                                disabled={!r.include}
                                onChange={(e) => updateRow(index, { transferAccountId: e.target.value })}
                                className="w-44"
                              >
                                <option value="">Choose account…</option>
                                {otherAccounts.map((a) => (
                                  <option key={a.id} value={a.id}>
                                    {a.name}
                                  </option>
                                ))}
                              </Select>
                              <button
                                type="button"
                                onClick={() => clearTransfer(index)}
                                aria-label={`Cancel transfer for ${r.payee} on ${r.date}`}
                                className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-200"
                              >
                                Undo
                              </button>
                            </div>
                          ) : r.splits ? (
                            <div className="flex flex-col gap-0.5">
                              <div className="flex items-center gap-2">
                                <Badge tone={info.valid ? 'violet' : 'amber'}>Split · {r.splits.length}</Badge>
                                <button
                                  type="button"
                                  onClick={() => setSplitOpen(open ? null : r.reference)}
                                  aria-label={`Edit split for ${r.payee} on ${r.date}`}
                                  className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-200"
                                >
                                  {open ? 'Close' : 'Edit'}
                                </button>
                              </div>
                              {!open && (
                                <span className="max-w-[14rem] truncate text-xs text-slate-500">
                                  {r.splits.map((s) => nameById.get(s.budgetItemId) ?? 'Unassigned').join(' · ')}
                                </span>
                              )}
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <Select
                                aria-label={`Category for ${r.payee} on ${r.date}`}
                                value={r.budgetItemId}
                                disabled={!r.include}
                                onChange={(e) => updateRow(index, { budgetItemId: e.target.value })}
                                className="w-48"
                              >
                                <CategoryOptions groups={groups} />
                              </Select>
                              <button
                                type="button"
                                onClick={() => startSplit(index, r.reference)}
                                disabled={!r.include}
                                aria-label={`Split ${r.payee} on ${r.date}`}
                                className="text-xs font-medium text-brand-700 hover:underline disabled:opacity-40 dark:text-brand-200"
                              >
                                Split
                              </button>
                              {canTransfer && (
                                <button
                                  type="button"
                                  onClick={() => startTransfer(index)}
                                  disabled={!r.include}
                                  aria-label={`Mark ${r.payee} on ${r.date} as a transfer`}
                                  className="text-xs font-medium text-brand-700 hover:underline disabled:opacity-40 dark:text-brand-200"
                                >
                                  Transfer
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {r.isTransfer ? (
                            <span className="text-xs text-slate-500">—</span>
                          ) : r.splits ? (
                            <span className="text-xs text-slate-500">Per line</span>
                          ) : (
                            <Select
                              aria-label={`Member for ${r.payee} on ${r.date}`}
                              value={r.memberId}
                              disabled={!r.include || members.length === 0}
                              onChange={(e) => updateRow(index, { memberId: e.target.value })}
                              className="w-36"
                            >
                              <option value="">No member</option>
                              {members.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.name}
                                </option>
                              ))}
                            </Select>
                          )}
                        </td>
                      </tr>

                      {open && r.splits && (() => {
                        const total = fromAmount(r.amount)
                        const allocatedMinor = total - info.remainingMinor
                        const pct = total <= 0 ? 0 : Math.max(0, Math.min(100, (allocatedMinor / total) * 100))
                        const over = info.remainingMinor < 0
                        const hasMembers = members.length > 0
                        const cols = hasMembers
                          ? 'grid grid-cols-[minmax(0,1fr)_7rem_8rem_1.75rem] items-center gap-2'
                          : 'grid grid-cols-[minmax(0,1fr)_7rem_1.75rem] items-center gap-2'
                        return (
                          <tr>
                            <td colSpan={6} className="p-0">
                              <div className="m-2 rounded-xl border border-violet-200/70 bg-violet-50/60 p-4 dark:border-violet-500/20 dark:bg-violet-500/10">
                                {/* Header: what we're splitting + allocation progress. */}
                                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                                  <h3 className="text-sm font-semibold text-slate-800">
                                    Splitting “{r.payee}”
                                    <span className="ml-2 font-normal text-slate-500">
                                      {formatMoney(total, r.currency)}
                                    </span>
                                  </h3>
                                  <div className="flex items-center gap-2.5">
                                    <div
                                      className="h-1.5 w-28 overflow-hidden rounded-full bg-violet-200/70 dark:bg-violet-500/20"
                                      aria-hidden
                                    >
                                      <div
                                        className={`h-full rounded-full transition-all ${
                                          over ? 'bg-rose-500' : info.remainingMinor === 0 ? 'bg-emerald-500' : 'bg-violet-500'
                                        }`}
                                        style={{ width: `${pct}%` }}
                                      />
                                    </div>
                                    <span
                                      aria-label="Remaining to allocate"
                                      className={`text-xs font-semibold tabular-nums ${
                                        info.remainingMinor === 0
                                          ? 'text-emerald-600 dark:text-emerald-400'
                                          : 'text-rose-600 dark:text-rose-400'
                                      }`}
                                    >
                                      {info.remainingMinor === 0
                                        ? 'Fully allocated'
                                        : over
                                          ? `${formatMoney(-info.remainingMinor, r.currency)} over`
                                          : `${formatMoney(info.remainingMinor, r.currency)} left`}
                                    </span>
                                  </div>
                                </div>

                                {/* Column labels. */}
                                <div className={`${cols} px-0.5 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500`}>
                                  <span>Category</span>
                                  <span className="text-right">Amount</span>
                                  {hasMembers && <span>Member</span>}
                                  <span className="sr-only">Remove line</span>
                                </div>

                                <div className="space-y-2">
                                  {r.splits.map((line, li) => (
                                    <div key={li} className={cols}>
                                      <Select
                                        aria-label={`Split line ${li + 1} category for ${r.payee}`}
                                        value={line.budgetItemId}
                                        onChange={(e) => updateSplitLine(index, li, { budgetItemId: e.target.value })}
                                        className="w-full"
                                      >
                                        <CategoryOptions groups={groups} />
                                      </Select>
                                      <Input
                                        type="text"
                                        inputMode="decimal"
                                        {...selectOnFocusProps}
                                        placeholder="0,00"
                                        aria-label={`Split line ${li + 1} amount for ${r.payee}`}
                                        value={line.amount}
                                        onChange={(e) => updateSplitLine(index, li, { amount: e.target.value })}
                                        className="w-full text-right tabular-nums"
                                      />
                                      {hasMembers && (
                                        <Select
                                          aria-label={`Split line ${li + 1} member for ${r.payee}`}
                                          value={line.memberId}
                                          onChange={(e) => updateSplitLine(index, li, { memberId: e.target.value })}
                                          className="w-full"
                                        >
                                          <option value="">No member</option>
                                          {members.map((m) => (
                                            <option key={m.id} value={m.id}>
                                              {m.name}
                                            </option>
                                          ))}
                                        </Select>
                                      )}
                                      {r.splits!.length > 2 ? (
                                        <button
                                          type="button"
                                          onClick={() => removeSplitLine(index, li)}
                                          aria-label={`Remove split line ${li + 1} for ${r.payee}`}
                                          className="flex h-8 w-7 items-center justify-center rounded-md text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"
                                        >
                                          ✕
                                        </button>
                                      ) : (
                                        <span />
                                      )}
                                    </div>
                                  ))}
                                </div>

                                <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-violet-200/60 pt-3 dark:border-violet-500/20">
                                  <Button variant="secondary" size="sm" onClick={() => addSplitLine(index)}>
                                    + Add line
                                  </Button>
                                  <button
                                    type="button"
                                    onClick={() => clearSplit(index)}
                                    className="text-xs font-medium text-slate-500 hover:text-slate-700 hover:underline"
                                  >
                                    Clear split
                                  </button>
                                  <div className="flex-1" />
                                  <Button size="sm" onClick={() => setSplitOpen(null)} disabled={!info.valid}>
                                    Done
                                  </Button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )
                      })()}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </Card>

          {reviewIncomplete && (
            <p className="text-sm text-rose-600 dark:text-rose-400">
              Finish the highlighted rows first — splits must add up, and transfers need an account.
            </p>
          )}
          {mappingDirty && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              You’ve changed the column mapping. Re-scan to apply it — otherwise the import would use the
              previous reading of your file.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => onCommit()} disabled={busy || includedCount === 0 || reviewIncomplete || mappingDirty}>
              {busy ? 'Importing…' : `Import ${includedCount} transaction${includedCount === 1 ? '' : 's'}`}
            </Button>
            <Button variant="ghost" onClick={reset} disabled={busy}>
              Choose a different file
            </Button>
          </div>

          {/* Cross-month confirm: categorised rows dated outside the loaded budget month get
              budgeted to this month's lines — a deliberate choice, confirmed once per batch. */}
          {crossMonthCount !== null && (
            <Modal title="Budget to a different month?" onClose={() => setCrossMonthCount(null)}>
              <p className="text-sm text-slate-600">
                {crossMonthCount} transaction{crossMonthCount === 1 ? ' is' : 's are'} dated outside{' '}
                {month ? monthYear(`${month.year}-${String(month.month).padStart(2, '0')}-01`) : 'this month'} but
                assigned to its budget lines. Importing will count {crossMonthCount === 1 ? 'it' : 'them'} toward{' '}
                {month ? monthYear(`${month.year}-${String(month.month).padStart(2, '0')}-01`) : 'this month'}
                {'’'}s budget rather than the month {crossMonthCount === 1 ? 'it was' : 'they were'} spent.
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => setCrossMonthCount(null)}>
                  Go back
                </Button>
                <Button size="sm" onClick={() => onCommit(true)} disabled={busy}>
                  Import anyway
                </Button>
              </div>
            </Modal>
          )}
        </>
      )}

      {canWrite && phase === 'done' && result && (
        <Card as="section" aria-labelledby="import-result-heading" className="p-6">
          <h2 id="import-result-heading" className="text-lg font-semibold text-slate-900">
            Import complete
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {result.imported} transaction{result.imported === 1 ? '' : 's'} added
            {result.skippedDuplicates > 0 && `, ${result.skippedDuplicates} skipped`}.
          </p>
          {(() => {
            // Money in/out are the actual sums of what was imported (the reviewed rows are still in
            // state), not transaction counts. Transfers are internal moves, so they stay a count.
            const moneyIn = moneyByCurrency(rows, (r) => !r.isTransfer && r.isCredit)
            const moneyOut = moneyByCurrency(rows, (r) => !r.isTransfer && !r.isCredit)
            const money = (groups: { currency: string; minor: number }[]) =>
              groups.length === 0
                ? formatMoney(0, preferredCurrency)
                : groups.map((g) => formatMoney(g.minor, g.currency)).join(' + ')
            return (
              <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                <Stat label="Imported" value={result.imported} />
                <Stat label="Skipped" value={result.skippedDuplicates} />
                <Stat label="Money in" value={money(moneyIn)} />
                <Stat label="Money out" value={money(moneyOut)} />
                <Stat label="Transfers" value={result.transfers} />
              </dl>
            )
          })()}
          <div className="mt-6">
            <Button onClick={reset}>Import another file</Button>
          </div>
        </Card>
      )}
    </AppShell>
  )
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl bg-slate-50 px-4 py-3">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words text-2xl font-bold tabular-nums text-slate-900">{value}</dd>
    </div>
  )
}

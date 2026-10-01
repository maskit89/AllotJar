import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
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
  ImportReusedReference,
  ImportStatementResult,
} from '../types'
import { TransactionType, type TransferMatchCandidate } from '../types'
import { buildItemOptions, type ItemOptionGroup } from '../lib/transactions'
import { formatMoney, fromAmount, parseMinor, sumMinor, toAmount } from '../lib/money'
import { selectOnFocusProps } from '../lib/selectOnFocus'
import { formatDate, monthYear } from '../lib/dates'
import { crossMonthError, serverErrors } from '../lib/serverErrors'
import { activeJars, useJarLedgers } from '../lib/jarLedgers'
import { jarAllocationsTotal, toJarAllocations } from '../lib/jarAllocationFields'
import { JarAllocationFields } from '../components/jars/JarAllocationFields'
import { PaidFromJarSelect } from '../components/jars/PaidFromJarSelect'
import type { SplitRowDraft } from '../components/SplitLinesEditor'
import { appendSplitRow, patchSplitRow, removeSplitRowAt, startSplitRows } from '../lib/splitRows'

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

/** One slice of a row's split; the same draft the Transactions page edits. */
type SplitDraft = SplitRowDraft

interface ReviewRow {
  /** The row's own identity on this screen, by its place in the preview: bank references can repeat or be empty. */
  key: string
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
  /** The already-imported entry that printed the same bank reference with other details; unticked by default. */
  reusedReference: ImportReusedReference | null
  /** When true, the row is a transfer to/from `transferAccountId` instead of income/spending. */
  isTransfer: boolean
  transferAccountId: string
  /** Recorded transfers this row could be the other side of (server suggestions; the user picks). */
  transferMatches: TransferMatchCandidate[]
  /**
   * The recorded transfer this row confirms (or, for a 'Return' candidate, brings back), chosen by
   * the user; '' = record it as its own movement.
   */
  matchTransferId: string
  /** A debit transfer with no match: the part of the row that is a fee, as typed ('' = none). */
  feeInput: string
  /** The fee's budget line (a chosen candidate's fee, or the typed one); '' = uncategorised. */
  feeBudgetItemId: string
  /**
   * A credit into a jar-backed account: the typed amount per jar id (rule 78), as entered.
   * Empty = all unallocated, the default.
   */
  jarAllocation: Record<string, string>
  /** A debit from a jar-backed account on a non-jar line (or out to another account): the jar it comes from; '' = unallocated (rule 79). */
  paidFromJarId: string
  /** Set once a commit held this row back (rule 74): the server's reason. Null for a row never held. */
  heldMessage: string | null
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

/** The candidate the row's user picked, if any. */
function chosenMatch(r: ReviewRow): TransferMatchCandidate | undefined {
  return r.matchTransferId ? r.transferMatches.find((m) => m.transferId === r.matchTransferId) : undefined
}

/** True when the row brings a transfer back to the account it left (a chosen 'Return' candidate). */
function isReturnRow(r: ReviewRow): boolean {
  return r.isTransfer && chosenMatch(r)?.kind === 'Return'
}

/**
 * The fee a transfer row records, in minor units: the chosen candidate's fee, or the part of an
 * unmatched debit the user typed as a fee. Null when there is none (or it doesn't parse); the
 * typed fee is only checked by manualFeeValid.
 */
function rowFeeMinor(r: ReviewRow): number | null {
  if (!r.isTransfer) return null
  const match = chosenMatch(r)
  if (match) return match.fee != null && match.fee > 0 ? fromAmount(match.fee) : null
  if (r.isCredit || !r.feeInput.trim()) return null
  const minor = parseMinor(r.feeInput)
  return minor !== null && minor > 0 ? minor : null
}

/** A typed fee (unmatched debit transfer) is blank, or more than zero and less than the row. */
function manualFeeValid(r: ReviewRow): boolean {
  if (!r.isTransfer || r.isCredit || r.matchTransferId || !r.feeInput.trim()) return true
  const minor = parseMinor(r.feeInput)
  return minor !== null && minor > 0 && minor < fromAmount(r.amount)
}

/** An included transfer records a fee (the candidate's or a typed one) but no line for it: the server requires one. */
function feeLineMissing(r: ReviewRow): boolean {
  return r.include && rowFeeMinor(r) !== null && !r.feeBudgetItemId
}

/**
 * The date a row's fee is recorded on once committed: the transfer's departure — the row's own
 * date for a debit; for a credit the recorded departure, unless the money is credited before it,
 * which pulls the departure back to the credit's date (it cannot arrive before it left).
 */
function feeDateOf(r: ReviewRow): string {
  if (!r.isCredit) return r.date
  const departed = chosenMatch(r)?.departedOn
  return departed && departed <= r.date ? departed : r.date
}

/**
 * A candidate's line in the "Already recorded?" picker. A 'Return' is the transfer coming back
 * to this account; a match reads as before, plus the fee it records and a shared bank reference.
 */
function matchLabel(r: ReviewRow, m: TransferMatchCandidate): string {
  if (m.kind === 'Return') {
    return `Returned: transfer to ${m.counterpartyAccountName} on ${formatDate(m.departedOn ?? r.date)}`
  }
  const parts = [
    r.isCredit ? `From ${m.counterpartyAccountName}` : `To ${m.counterpartyAccountName}`,
    formatMoney(fromAmount(m.amount), m.currency),
    m.departedOn ? `left ${formatDate(m.departedOn)}` : `received ${formatDate(m.receivedOn ?? r.date)}`,
  ]
  if (m.fee != null && m.fee > 0) parts.push(`with a fee of ${formatMoney(fromAmount(m.fee), m.currency)}`)
  if (m.sameReference) parts.push('same bank reference')
  return parts.join(' · ')
}

/**
 * The rows of a commit's `sent` rows that its result names, by key: by position in the request
 * (unique), else, from a server that sends none, the first row not yet named with that reference.
 */
function rowsNamed<T extends { reference: string; index?: number }>(sent: ReviewRow[], named: T[]): Map<string, T> {
  const byKey = new Map<string, T>()
  for (const n of named) {
    const row =
      typeof n.index === 'number' && n.index >= 0 ? sent[n.index] : sent.find((r) => r.reference === n.reference && !byKey.has(r.key))
    if (row && !byKey.has(row.key)) byKey.set(row.key, n)
  }
  return byKey
}

/** A DOM id prefix for one row's prompts: the statement reference, sanitised, plus the row's position. */
function rowDomId(reference: string, index: number): string {
  return `import-row-${index}-${reference.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/**
 * Rule 79: a debit from a jar-backed account asks "which jar does this come from?" only when
 * the money isn't already tied to a jar by its line — a plain row on a non-jar line, a split
 * with any slice on a non-jar line, or a transfer out to another account. A row with no line
 * (or on a jar line) shows nothing.
 */
function paidFromApplies(r: ReviewRow, jarLineIds: Set<string>): boolean {
  if (r.isCredit || isReturnRow(r)) return false
  if (r.isTransfer) return true
  if (r.splits) return r.splits.some((l) => l.budgetItemId !== '' && !jarLineIds.has(l.budgetItemId))
  return r.budgetItemId !== '' && !jarLineIds.has(r.budgetItemId)
}

/** Rule 78 fields parse and don't exceed the amount received (the server would refuse otherwise). */
function jarAllocationValid(r: ReviewRow): boolean {
  const total = jarAllocationsTotal(r.jarAllocation)
  return total !== null && total <= r.amount
}

function CategoryOptions({
  groups,
  emptyLabel = 'Unassigned',
  currentId = '',
}: {
  groups: ItemOptionGroup[]
  emptyLabel?: string
  /** A chosen line this month doesn't list (e.g. a transfer's fee line in another month), kept selectable. */
  currentId?: string
}) {
  const listed = !currentId || groups.some((g) => g.items.some((i) => i.id === currentId))
  return (
    <>
      <option value="">{emptyLabel}</option>
      {!listed && <option value={currentId}>The fee&rsquo;s current line</option>}
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
  const { canWrite, budgetCurrency } = useAuth()
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

  // Every commit of this review, in order: a commit that held rows (rule 74) keeps the review
  // open for just those rows, so the done screen sums what each commit imported.
  const [results, setResults] = useState<ImportStatementResult[]>([])
  // The reviewed rows each commit accepted (imported or skipped as a duplicate) — the done
  // screen's money in/out sums. Held rows join once a later commit posts them.
  const [committedRows, setCommittedRows] = useState<(ReviewRow & { skipped: boolean })[]>([])
  // Every row held at some point in this review (a row may be held by more than one commit), by key.
  const [heldEver, setHeldEver] = useState<string[]>([])
  // Each preview's rows get keys no earlier preview used.
  const nextRowKey = useRef(0)
  // The latest commit that held rows back: while set, the review shows only those rows.
  const [heldResult, setHeldResult] = useState<ImportStatementResult | null>(null)
  // Count of categorised rows dated outside the loaded budget month — set when Import needs the
  // one-per-batch cross-month confirmation before committing.
  // The batch's cross-month question: the rows the screen counted, or the server's own refusal.
  const [crossMonthAsk, setCrossMonthAsk] = useState<{ count: number; message?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The jar-backed accounts (rules 78/79): the prompts only apply when the import account is one.
  const { byAccount } = useJarLedgers()

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
  const reusedReferenceCount = useMemo(() => rows.filter((r) => r.reusedReference).length, [rows])
  // The summary's note on rows that start unticked, reading naturally with either or both kinds.
  const flaggedNotes = [
    possibleDuplicateCount > 0 &&
      `${possibleDuplicateCount} possible duplicate${possibleDuplicateCount === 1 ? '' : 's'} unticked`,
    reusedReferenceCount > 0 && `${reusedReferenceCount} reusing a known bank reference unticked`,
  ].filter((note): note is string => !!note)
  // The header checkbox reads ticked when every row it ticks is included (rows reusing a known
  // bank reference are left to the user unless they are all there is).
  const bulkRows = rows.some((r) => !r.reusedReference) ? rows.filter((r) => !r.reusedReference) : rows
  const allIncluded = bulkRows.length > 0 && bulkRows.every((r) => r.include)
  // The mapping has unsaved edits when it differs from the one that produced the current rows.
  const mappingDirty = useMemo(
    () => !!mapping && !!scannedMapping && JSON.stringify(mapping) !== JSON.stringify(scannedMapping),
    [mapping, scannedMapping],
  )
  const importAccount = accounts.find((a) => a.id === accountId) ?? null
  const otherAccounts = accounts.filter((a) => a.id !== accountId)
  // A transfer needs an import account plus another account to move to/from.
  const canTransfer = !!accountId && otherAccounts.length > 0
  // The import account's jars, when it backs any: money reaching it asks which jars it goes
  // into (rule 78) and money leaving it which jar it comes from (rule 79).
  const importLedger = accountId ? byAccount.get(accountId) : undefined
  const importJars = useMemo(() => activeJars(importLedger), [importLedger])
  const importBacksJars = importJars.length > 0
  const importCurrency = importLedger?.currency || importAccount?.currency || budgetCurrency
  // The currency a CSV row without its own currency column is read in: the chosen import
  // account's currency, else the budget currency.
  const fallbackCurrency = importAccount?.currency || budgetCurrency
  // The month's jar lines (a savings line names its jar), whose debits never ask for a jar.
  /** Every line of the loaded month: a categorised row's line is one of them, a matched fee's may not be. */
  const monthLineIds = useMemo(() => new Set((month?.categories ?? []).flatMap((c) => c.items).map((i) => i.id)), [month])
  const jarLineIds = useMemo(
    () => new Set((month?.categories ?? []).flatMap((c) => c.items).filter((i) => i.savingsId).map((i) => i.id)),
    [month],
  )
  // Block the import while a split doesn't add up, a transfer hasn't picked a counterparty (a
  // return names its transfer instead, and a chosen match its counterparty, which may be private
  // to another login), a typed fee isn't less than the row, a fee has no line (the server
  // requires one, rule 91), or a credit's jar amounts exceed what arrived.
  const reviewIncomplete = useMemo(
    () =>
      rows.some(
        (r) =>
          r.include &&
          ((r.splits && !splitInfo(r).valid) ||
            (r.isTransfer && !isReturnRow(r) && !r.transferAccountId && !r.matchTransferId) ||
            !manualFeeValid(r) ||
            feeLineMissing(r) ||
            (importBacksJars && r.isCredit && !isReturnRow(r) && !jarAllocationValid(r))),
      ),
    [rows, importBacksJars],
  )
  // Rows held by the latest commit (rule 74): the review shows only those until they post or are unticked.
  const heldMode = heldResult !== null
  const heldEverCount = useMemo(() => new Set(heldEver).size, [heldEver])

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
          key: `row-${nextRowKey.current++}`,
          reference: c.reference,
          date: c.date,
          payee: c.payee,
          amount: c.amount,
          currency: c.currency,
          isCredit: c.isCredit,
          // Rows that look already-imported (or reuse a known bank reference) start unticked:
          // the user opts them back in.
          include: kept ? kept.include : !c.possibleDuplicate && !c.reusedReference,
          budgetItemId: kept ? kept.budgetItemId : resolveSuggestion(c, month),
          memberId: kept ? kept.memberId : '',
          splits: kept ? kept.splits : null,
          likelyTransfer: c.likelyTransfer,
          possibleDuplicate: c.possibleDuplicate ?? false,
          reusedReference: c.reusedReference ?? null,
          isTransfer: kept ? kept.isTransfer : false,
          transferAccountId: kept ? kept.transferAccountId : '',
          transferMatches: c.transferMatches ?? [],
          matchTransferId: kept ? kept.matchTransferId : '',
          feeInput: kept ? kept.feeInput : '',
          feeBudgetItemId: kept ? kept.feeBudgetItemId : '',
          jarAllocation: kept ? kept.jarAllocation : {},
          paidFromJarId: kept ? kept.paidFromJarId : '',
          heldMessage: null,
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
      // Generic CSV auto-detects the layout on first upload; send the import account's currency
      // (else the budget currency) as the fallback. The chosen account scopes the server's already-imported filter to the same
      // account the commit will dedup against.
      const opts = {
        ...(format === 'generic' ? { defaultCurrency: fallbackCurrency } : {}),
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
        defaultCurrency: fallbackCurrency,
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

  /**
   * The header checkbox. Ticking all leaves rows reusing a known bank reference as they are
   * (rule 88: each is opted in on its own), unless they are all there is; unticking clears every row.
   */
  function setAllIncluded(include: boolean) {
    setRows((rs) => {
      const skipReused = include && rs.some((r) => !r.reusedReference)
      return rs.map((r) => (skipReused && r.reusedReference ? r : { ...r, include }))
    })
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
    setRows((rs) =>
      rs.map((r, i) =>
        i === index
          ? { ...r, isTransfer: false, transferAccountId: '', matchTransferId: '', feeInput: '', feeBudgetItemId: '' }
          : r,
      ),
    )
  }
  /**
   * Choosing a recorded transfer also fixes the counterparty it names ('' when that side is
   * private to another login: the server derives it) and pre-fills the fee's line with the one
   * the transfer's current fee is on; '' records the row as its own movement. A 'Return'
   * candidate names the transfer coming back, not a counterparty.
   */
  function chooseMatch(index: number, matchTransferId: string) {
    setRows((rs) =>
      rs.map((r, i) => {
        if (i !== index) return r
        const match = r.transferMatches.find((m) => m.transferId === matchTransferId)
        if (!match) return { ...r, matchTransferId, feeBudgetItemId: r.matchTransferId ? '' : r.feeBudgetItemId }
        return {
          ...r,
          matchTransferId,
          transferAccountId: match.counterpartyAccountId ?? '',
          feeBudgetItemId: match.fee != null && match.fee > 0 ? (match.feeBudgetItemId ?? '') : '',
        }
      }),
    )
  }

  // --- per-row split editing ---
  function startSplit(index: number, key: string) {
    setRows((rs) =>
      rs.map((r, i) =>
        i === index && !r.splits
          ? { ...r, splits: startSplitRows({ budgetItemId: r.budgetItemId, memberId: r.memberId }) }
          : r,
      ),
    )
    setSplitOpen(key)
  }
  function clearSplit(index: number) {
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, splits: null } : r)))
    setSplitOpen(null)
  }
  function updateSplitLine(index: number, li: number, patch: Partial<SplitDraft>) {
    setRows((rs) =>
      rs.map((r, i) =>
        i === index && r.splits ? { ...r, splits: patchSplitRow(r.splits, li, patch) } : r,
      ),
    )
  }
  function addSplitLine(index: number) {
    setRows((rs) =>
      rs.map((r, i) =>
        i === index && r.splits ? { ...r, splits: appendSplitRow(r.splits) } : r,
      ),
    )
  }
  function removeSplitLine(index: number, li: number) {
    setRows((rs) =>
      rs.map((r, i) =>
        i === index && r.splits ? { ...r, splits: removeSplitRowAt(r.splits, li) } : r,
      ),
    )
  }

  /** A row categorised (line or split) whose date falls outside the loaded budget month —
   *  committing it budgets money to a different month than it was spent, which needs an
   *  explicit confirmation (the categories on offer are always the current month's lines). */
  function isCrossMonthRow(r: ReviewRow): boolean {
    if (!month) return false
    const loadedMonth = `${month.year}-${String(month.month).padStart(2, '0')}`
    const outsideMonth = (date: string) => date.slice(0, 7) !== loadedMonth
    // A transfer's fee is dated the departure (the bank's, once matched) and judged against its
    // line's own month, as the server judges it on every commit that carries a fee: one of this
    // month's lines, or the line the recorded transfer already gave it, whose month the candidate
    // carries (#279 P3-8 asked for every matched fee; #286 P2-1 asked for none of them).
    if (r.isTransfer) {
      if (rowFeeMinor(r) === null || !r.feeBudgetItemId) return false
      const match = chosenMatch(r)
      const lineMonth = monthLineIds.has(r.feeBudgetItemId)
        ? loadedMonth
        : match && r.feeBudgetItemId === match.feeBudgetItemId
          ? (match.feeBudgetItemMonth?.slice(0, 7) ?? loadedMonth)
          : loadedMonth
      return feeDateOf(r).slice(0, 7) !== lineMonth
    }
    if (!r.budgetItemId && !r.splits) return false
    return outsideMonth(r.date)
  }

  /**
   * The jar answer for one row, when the import account backs jars: a credit carries its jar
   * amounts (rule 78; left out when all unallocated), a debit the jar it comes from (rule 79;
   * null = unallocated, and always null where the prompt doesn't apply). The server rejects a
   * jar answer in the wrong direction, so a credit never carries `paidFromJarId` and vice versa.
   */
  function jarAnswer(r: ReviewRow): Pick<CommitImportItem, 'jarAllocations' | 'paidFromJarId'> {
    // A return goes back to the jars the money left from; it carries no jar answer.
    if (!importBacksJars || isReturnRow(r)) return {}
    if (r.isCredit) {
      const jarAllocations = toJarAllocations(r.jarAllocation)
      return jarAllocations.length > 0 ? { jarAllocations } : {}
    }
    return { paidFromJarId: paidFromApplies(r, jarLineIds) ? r.paidFromJarId || null : null }
  }

  /**
   * Posts the included rows. `acknowledgeCrossMonth` re-sends after the batch question was
   * answered: the rows the screen judged cross-month are flagged, or every row that names a
   * line when the server raised the question itself (a case the screen did not foresee).
   */
  async function onCommit(acknowledgeCrossMonth = false, acknowledgeEveryLine = false) {
    const sent = rows.filter((r) => r.include)
    const namesALine = (r: ReviewRow) => (r.isTransfer ? !!r.feeBudgetItemId && rowFeeMinor(r) !== null : !!r.budgetItemId || !!r.splits)
    const items: CommitImportItem[] = sent.map((r) => {
      const base = {
        reference: r.reference,
        date: r.date,
        payee: r.payee,
        amount: r.amount,
        currency: r.currency,
        isCredit: r.isCredit,
        ...jarAnswer(r),
      }
      const acknowledged =
        acknowledgeCrossMonth && (isCrossMonthRow(r) || (acknowledgeEveryLine && namesALine(r))) ? { acknowledgeCrossMonth: true } : {}
      if (isReturnRow(r)) {
        // The transfer coming back names only that transfer: no counterparty, line, member or jars.
        return { ...base, budgetItemId: null, memberId: null, transferAccountId: null, matchTransferId: null, returnOfTransferId: r.matchTransferId }
      }
      if (r.isTransfer) {
        const feeMinor = rowFeeMinor(r)
        return {
          ...base,
          budgetItemId: null,
          memberId: null,
          // Null only for a match whose counterparty is private to another login.
          transferAccountId: r.transferAccountId || null,
          matchTransferId: r.matchTransferId || null,
          // A chosen candidate's fee is echoed as the server computed it; a typed one splits the row.
          ...(feeMinor !== null
            ? { fee: chosenMatch(r)?.fee ?? toAmount(feeMinor), feeBudgetItemId: r.feeBudgetItemId || null }
            : {}),
          ...acknowledged,
        }
      }
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
    if (mappingDirty) return
    // Every held row unticked (rule 74: discarded): nothing is left to post, so finish here.
    if (items.length === 0) {
      if (heldMode) {
        setHeldResult(null)
        setPhase('done')
      }
      return
    }

    // Historical rows put on this month's lines are a deliberate choice — confirm once for the
    // batch, then re-run with the affected rows acknowledged (the server rejects them otherwise).
    const affected = rows.filter((r) => r.include && isCrossMonthRow(r)).length
    if (affected > 0 && !acknowledgeCrossMonth) {
      setCrossMonthAsk({ count: affected })
      return
    }

    setBusy(true)
    setError(null)
    try {
      const result = await commitImport(accountId || null, items)
      setResults((prev) => [...prev, result])
      setCrossMonthAsk(null)
      track(EVENTS.importCommitted, { row_bucket: bucketCount(items.length) })
      // Rule 74: the rows the account could not take on their date were held, not posted.
      // Everything else went in; the review stays open for just the held rows, each with the
      // server's reason, until a later commit posts them or the user unticks them.
      // Rows are named by their position in the request: references need not be unique.
      const held = new Map([...rowsNamed(sent, result.held ?? [])].map(([key, h]) => [key, h.message]))
      const skipped = rowsNamed<{ reference: string; index?: number }>(
        sent,
        result.skippedIndexes
          ? result.skippedIndexes.map((index) => ({ reference: '', index }))
          : (result.skippedReferences ?? []).map((reference) => ({ reference })),
      )
      setCommittedRows((prev) => [...prev, ...sent.filter((r) => !held.has(r.key)).map((r) => ({ ...r, skipped: skipped.has(r.key) }))])
      setHeldEver((prev) => [...prev, ...held.keys()])
      if (held.size > 0) {
        // The rows as they are now: a row re-answered while the commit was out keeps that answer.
        setRows((current) => current.filter((r) => held.has(r.key)).map((r) => ({ ...r, heldMessage: held.get(r.key) ?? null })))
        setSplitOpen(null)
        setHeldResult(result)
      } else {
        setHeldResult(null)
        setPhase('done')
      }
    } catch (err) {
      // The server's own cross-month refusal (a matched fee's line, say) is the same question,
      // asked once with its reason; "Import anyway" re-sends with every line acknowledged.
      const crossMonth = !acknowledgeEveryLine ? crossMonthError(err) : undefined
      if (crossMonth) {
        setCrossMonthAsk({ count: 0, message: crossMonth })
      } else {
        setCrossMonthAsk(null)
        setError(serverErrors(err) ?? errorMessage(err))
      }
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
    setResults([])
    setCommittedRows([])
    setHeldEver([])
    setHeldResult(null)
    setError(null)
    setBulkMember('')
    setBulkCategory('')
    setCrossMonthAsk(null)
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
          {/* Rule 74: the last commit held these rows because the account would go below zero on
              their date. Nothing is posted "anyway" — the user records the missing money (or
              changes the row) and commits again, or unticks a row to discard it. */}
          {heldResult && (
            <div
              role="status"
              className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
            >
              <p className="font-semibold">
                {heldResult.held?.length ?? 0} row{(heldResult.held?.length ?? 0) === 1 ? ' was' : 's were'} held because the
                account would go below zero on {(heldResult.held?.length ?? 0) === 1 ? 'its' : 'their'} date.
              </p>
              <p className="mt-1">Record the missing money first and commit again, or untick a row to discard it.</p>
              <p className="mt-1 text-xs">
                The rest went in: {heldResult.imported} transaction{heldResult.imported === 1 ? '' : 's'} imported
                {heldResult.skippedDuplicates > 0 && `, ${heldResult.skippedDuplicates} skipped`}
                {heldResult.transfers > 0 && `, ${heldResult.transfers} transfer${heldResult.transfers === 1 ? '' : 's'}`}.
              </p>
            </div>
          )}
          {!heldMode && (
            <p className="text-sm text-slate-600">
              <span className="font-semibold text-slate-800">{preview.newCount}</span> new transaction
              {preview.newCount === 1 ? '' : 's'} to review
              {preview.skippedDuplicates > 0 &&
                ` — ${preview.skippedDuplicates} already imported (skipped)`}
              {flaggedNotes.length > 0 && ` — ${flaggedNotes.join(' and ')} (tick to include)`}
              . Categorise them (split a row, or mark a transfer), untick any you don't want, then import.
            </p>
          )}
          {!heldMode && possibleDuplicateCount > 0 && (
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
              Importing into <span className="font-medium text-slate-700">{importAccount.name}</span>
              {importBacksJars && (
                <>
                  , which holds jars — say which jars incoming money goes into and which jar a payment comes from
                  (leave them as they are to keep the money unallocated)
                </>
              )}
              .
            </p>
          )}
          {!heldMode && !accountId && rows.some((r) => r.likelyTransfer) && (
            <p className="-mt-3 text-xs text-amber-700 dark:text-amber-400">
              Some rows look like transfers between your accounts. Re-import with an account selected (on the
              previous step) to record them as transfers.
            </p>
          )}

          {/* Generic-CSV column mapping — confirm/correct what we guessed, then re-scan. Hidden once
              rows are held: a re-scan would bring back the rows already imported. */}
          {!heldMode && format === 'generic' && layout && mapping && (
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
                    <option value="">Use {fallbackCurrency} for every row</option>
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
                <Select aria-label="Bulk category" value={bulkCategory} onChange={(e) => setBulkCategory(e.target.value)} className="w-48" disabled={busy}>
                  <CategoryOptions groups={expenseGroups} />
                </Select>
                <Button variant="secondary" size="sm" onClick={applyCategoryToIncluded} disabled={busy || expenseGroups.length === 0}>
                  Apply to expenses
                </Button>
              </div>
            </div>
          </Card>

          <Card className="overflow-x-auto">
            {/* The rows are what Import sends: they hold still while it is out, so an answer can't be
                given to a row that is already on its way (and lost when the server takes it). */}
            <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
            <table className="w-full text-sm">
              <caption className="sr-only">Transactions to import</caption>
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th scope="col" className="px-3 py-2 font-medium">
                    <input
                      type="checkbox"
                      aria-label="Include all rows"
                      checked={allIncluded}
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
                  const open = splitOpen === r.key
                  const domId = rowDomId(r.reference, index)
                  // The jar prompts (rules 78/79) apply only to a ticked row into/out of a jar-backed account.
                  const showAllocation = importBacksJars && r.include && r.isCredit && !isReturnRow(r)
                  const showPaidFrom = importBacksJars && r.include && paidFromApplies(r, jarLineIds)
                  return (
                    <Fragment key={r.key}>
                      {/* A flagged-but-unticked row needs its badge readable (an opacity-dimmed
                          row drops the amber text below AA contrast), so it gets an attention
                          tint instead of the excluded-row fade. */}
                      <tr
                        className={
                          r.include
                            ? 'hover:bg-slate-50'
                            : r.possibleDuplicate || r.reusedReference
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
                          {r.heldMessage !== null && (
                            <Badge tone="rose" className="ml-1.5 align-middle">
                              Held
                            </Badge>
                          )}
                          {r.heldMessage !== null && (
                            <span className="block max-w-md text-xs font-normal text-rose-700 dark:text-rose-300">{r.heldMessage}</span>
                          )}
                          {r.possibleDuplicate && (
                            <span className="block text-xs font-normal text-amber-700 dark:text-amber-400">
                              Possibly already imported
                            </span>
                          )}
                          {r.reusedReference && (
                            <span className="block max-w-md text-xs font-normal text-amber-700 dark:text-amber-400">
                              An entry with this bank reference was already imported: {formatDate(r.reusedReference.date)}{' '}
                              {r.reusedReference.isCredit ? '+' : '−'}
                              {formatMoney(fromAmount(r.reusedReference.amount), r.currency)}. Tick it only if this is a
                              different payment.
                            </span>
                          )}
                          {r.likelyTransfer && !r.isTransfer && (
                            <span className="block text-xs font-normal text-amber-700 dark:text-amber-400">
                              Looks like a transfer
                            </span>
                          )}
                          {!r.likelyTransfer && !r.isTransfer && r.transferMatches.some((m) => m.kind === 'Return') && (
                            <span className="block text-xs font-normal text-amber-700 dark:text-amber-400">
                              Looks like a transfer coming back
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
                          <div className="flex flex-col gap-1.5">
                            {r.isTransfer ? (() => {
                              const match = chosenMatch(r)
                              const returning = match?.kind === 'Return'
                              const feeMinor = rowFeeMinor(r)
                              const typedFee = !r.isCredit && !match
                              return (
                              <div className="flex flex-col gap-1">
                                <div className="flex items-center gap-2">
                                  <Badge tone="brand">Transfer</Badge>
                                  {returning ? (
                                    <span className="text-xs text-slate-500">coming back</span>
                                  ) : match && match.counterpartyAccountId === null ? (
                                    // The other side is private to another login: named, never chosen.
                                    <span className="text-xs text-slate-500">
                                      {r.isCredit ? 'from' : 'to'}{' '}
                                      <span className="font-medium text-slate-700">
                                        {match.counterpartyAccountName || 'Private account'}
                                      </span>
                                    </span>
                                  ) : (
                                    <>
                                      <span className="text-xs text-slate-500">{r.isCredit ? 'from' : 'to'}</span>
                                      <Select
                                        aria-label={`Transfer account for ${r.payee} on ${r.date}`}
                                        value={r.transferAccountId}
                                        disabled={!r.include || !!r.matchTransferId}
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
                                    </>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => clearTransfer(index)}
                                    aria-label={`Cancel transfer for ${r.payee} on ${r.date}`}
                                    className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-200"
                                  >
                                    Undo
                                  </button>
                                </div>
                                {r.transferMatches.length > 0 && (
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-slate-500">Already recorded?</span>
                                    <Select
                                      aria-label={`Match recorded transfer for ${r.payee} on ${r.date}`}
                                      value={r.matchTransferId}
                                      disabled={!r.include}
                                      onChange={(e) => chooseMatch(index, e.target.value)}
                                      className="w-72"
                                    >
                                      <option value="">No — record it as a new transfer</option>
                                      {/* In the server's order: nearest date first (rule 87). */}
                                      {r.transferMatches.map((m) => (
                                        <option key={m.transferId} value={m.transferId}>
                                          {matchLabel(r, m)}
                                        </option>
                                      ))}
                                    </Select>
                                    {match?.sameReference && <Badge tone="teal">Same bank reference</Badge>}
                                  </div>
                                )}
                                {match?.recordedDate && (
                                  <span className="text-xs text-slate-500">
                                    Recorded in the app on {formatDate(match.recordedDate)}; the bank&rsquo;s date will be used.
                                  </span>
                                )}
                                {/* A fee: the candidate's (accepted by choosing it) or one typed for an unmatched debit. */}
                                {typedFee && (
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-xs text-slate-500">Fee (optional)</span>
                                    <Input
                                      type="text"
                                      inputMode="decimal"
                                      {...selectOnFocusProps}
                                      placeholder="0.00"
                                      aria-label={`Fee for ${r.payee} on ${r.date}`}
                                      value={r.feeInput}
                                      disabled={!r.include}
                                      onChange={(e) => updateRow(index, { feeInput: e.target.value })}
                                      className="w-24 text-right tabular-nums"
                                    />
                                  </div>
                                )}
                                {typedFee && !manualFeeValid(r) && (
                                  <span className="text-xs text-rose-600 dark:text-rose-400">
                                    The fee must be more than zero and less than the row&rsquo;s amount.
                                  </span>
                                )}
                                {feeMinor !== null && (
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-xs text-slate-500">
                                      {typedFee
                                        ? `A transfer of ${formatMoney(fromAmount(r.amount) - feeMinor, r.currency)} plus a fee of ${formatMoney(feeMinor, r.currency)}. Fee category:`
                                        : `Records a fee of ${formatMoney(feeMinor, r.currency)}. Fee category:`}
                                    </span>
                                    <Select
                                      aria-label={`Fee category for ${r.payee} on ${r.date}`}
                                      value={r.feeBudgetItemId}
                                      disabled={!r.include}
                                      onChange={(e) => updateRow(index, { feeBudgetItemId: e.target.value })}
                                      className="w-48"
                                    >
                                      <CategoryOptions groups={expenseGroups} emptyLabel="Choose a line…" currentId={r.feeBudgetItemId} />
                                    </Select>
                                  </div>
                                )}
                                {feeLineMissing(r) && (
                                  <span className="text-xs text-rose-600 dark:text-rose-400">Choose the fee&rsquo;s category.</span>
                                )}
                                {returning ? (
                                  <span className="text-xs text-slate-500">
                                    Records the transfer to {match.counterpartyAccountName} as returned: the money is back in{' '}
                                    {importAccount?.name ?? 'this account'} and goes back to the jars it left from.
                                  </span>
                                ) : r.matchTransferId ? (
                                  <span className="text-xs text-slate-500">
                                    Confirms the other side of the recorded transfer — no second balance movement.
                                  </span>
                                ) : r.isCredit ? (
                                  <span className="text-xs text-amber-700 dark:text-amber-400">
                                    Held for review until the departure date is known; nothing is posted to either account yet.
                                  </span>
                                ) : (
                                  <span className="text-xs text-slate-500">
                                    Recorded as departed on {formatDate(r.date)}; in transit until the receipt is confirmed.
                                  </span>
                                )}
                              </div>
                              )
                            })() : r.splits ? (
                              <div className="flex flex-col gap-0.5">
                                <div className="flex items-center gap-2">
                                  <Badge tone={info.valid ? 'violet' : 'amber'}>Split · {r.splits.length}</Badge>
                                  <button
                                    type="button"
                                    onClick={() => setSplitOpen(open ? null : r.key)}
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
                                  onClick={() => startSplit(index, r.key)}
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
                            {/* Rule 79: which jar this payment comes from (unallocated unless chosen). */}
                            {showPaidFrom && (
                              <PaidFromJarSelect
                                jars={importJars}
                                accountName={importAccount?.name ?? ''}
                                currency={importCurrency}
                                value={r.paidFromJarId}
                                onChange={(jarId) => updateRow(index, { paidFromJarId: jarId })}
                                id={`${domId}-paid-from`}
                                compact
                              />
                            )}
                          </div>
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

                      {/* Rule 78: money reaching a jar-backed account asks which jars it goes into.
                          Every field starts empty (unallocated). A credit transfer whose departure
                          is unknown stores the answer now; it applies once the departure is confirmed. */}
                      {showAllocation && (
                        <tr>
                          <td colSpan={6} className="p-0">
                            <div className="mx-2 mb-2">
                              <JarAllocationFields
                                jars={importJars}
                                accountName={importAccount?.name ?? ''}
                                currency={importCurrency}
                                amount={r.amount}
                                value={r.jarAllocation}
                                onChange={(value) => updateRow(index, { jarAllocation: value })}
                                idPrefix={domId}
                                compact
                              />
                              {r.isTransfer && !r.matchTransferId && (
                                <p className="mt-1 text-xs text-slate-500">
                                  These jar amounts apply once the transfer&rsquo;s departure is confirmed.
                                </p>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
            </fieldset>
          </Card>

          {reviewIncomplete && (
            <p className="text-sm text-rose-600 dark:text-rose-400">
              Finish the highlighted rows first — splits must add up, transfers need an account, a fee needs a category,
              and jar amounts can&rsquo;t exceed what arrived.
            </p>
          )}
          {mappingDirty && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              You’ve changed the column mapping. Re-scan to apply it — otherwise the import would use the
              previous reading of your file.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => onCommit()} disabled={busy || (includedCount === 0 && !heldMode) || reviewIncomplete || mappingDirty}>
              {busy
                ? 'Importing…'
                : heldMode
                  ? includedCount === 0
                    ? 'Finish without the held rows'
                    : 'Commit held rows'
                  : `Import ${includedCount} transaction${includedCount === 1 ? '' : 's'}`}
            </Button>
            <Button variant="ghost" onClick={reset} disabled={busy}>
              Choose a different file
            </Button>
          </div>

          {/* Cross-month confirm: categorised rows dated outside the loaded budget month get
              budgeted to this month's lines — a deliberate choice, confirmed once per batch. */}
          {crossMonthAsk !== null && (
            <Modal title="Budget to a different month?" onClose={() => setCrossMonthAsk(null)}>
              {crossMonthAsk.message ? (
                <p className="text-sm text-slate-600">
                  {crossMonthAsk.message} Importing will count it toward that line{'’'}s month rather than the month it was
                  spent.
                </p>
              ) : (
                <p className="text-sm text-slate-600">
                  {crossMonthAsk.count} transaction{crossMonthAsk.count === 1 ? ' is' : 's are'} dated outside{' '}
                  {month ? monthYear(`${month.year}-${String(month.month).padStart(2, '0')}-01`) : 'this month'} but
                  assigned to its budget lines. Importing will count {crossMonthAsk.count === 1 ? 'it' : 'them'} toward{' '}
                  {month ? monthYear(`${month.year}-${String(month.month).padStart(2, '0')}-01`) : 'this month'}
                  {'’'}s budget rather than the month {crossMonthAsk.count === 1 ? 'it was' : 'they were'} spent.
                </p>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => setCrossMonthAsk(null)}>
                  Go back
                </Button>
                <Button size="sm" onClick={() => onCommit(true, !!crossMonthAsk.message)} disabled={busy}>
                  Import anyway
                </Button>
              </div>
            </Modal>
          )}
        </>
      )}

      {canWrite && phase === 'done' && results.length > 0 && (
        <Card as="section" aria-labelledby="import-result-heading" className="p-6">
          {(() => {
            // One review can take several commits when rows were held (rule 74); the summary
            // adds up what each of them posted.
            const total = results.reduce(
              (t, r) => ({
                imported: t.imported + r.imported,
                skipped: t.skipped + r.skippedDuplicates,
                transfers: t.transfers + r.transfers,
                matched: t.matched + (r.matchedTransfers ?? 0),
                pendingReview: t.pendingReview + (r.pendingReviewTransfers ?? 0),
                returned: t.returned + (r.returned ?? 0),
                awaitingAmount: t.awaitingAmount + (r.awaitingAmount ?? 0),
              }),
              { imported: 0, skipped: 0, transfers: 0, matched: 0, pendingReview: 0, returned: 0, awaitingAmount: 0 },
            )
            // Money in/out are the actual sums of what was imported (the accepted rows are still
            // in state), not transaction counts. A row the server skipped as already imported
            // moved no money, so it is left out; a row in another currency is summed in that
            // currency and shown apart, and the count of those still waiting for their amount in
            // the budget currency is shown below. Transfers are internal moves, so they stay a count.
            const importedRows = committedRows.filter((r) => !r.skipped)
            const moneyIn = moneyByCurrency(importedRows, (r) => !r.isTransfer && r.isCredit)
            const moneyOut = moneyByCurrency(importedRows, (r) => !r.isTransfer && !r.isCredit)
            const money = (groups: { currency: string; minor: number }[]) =>
              groups.length === 0
                ? formatMoney(0, budgetCurrency)
                : groups.map((g) => formatMoney(g.minor, g.currency)).join(' + ')
            return (
              <>
                <h2 id="import-result-heading" className="text-lg font-semibold text-slate-900">
                  Import complete
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {total.imported} transaction{total.imported === 1 ? '' : 's'} added
                  {total.skipped > 0 && `, ${total.skipped} skipped`}.
                </p>
                <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                  <Stat label="Imported" value={total.imported} />
                  <Stat label="Skipped" value={total.skipped} />
                  <Stat label="Money in" value={money(moneyIn)} />
                  <Stat label="Money out" value={money(moneyOut)} />
                  <Stat label="Transfers" value={total.transfers} />
                  {total.matched > 0 && <Stat label="Matched" value={total.matched} />}
                  {total.pendingReview > 0 && <Stat label="Pending review" value={total.pendingReview} />}
                  {total.returned > 0 && <Stat label="Returned" value={total.returned} />}
                  {heldEverCount > 0 && <Stat label="Held" value={heldEverCount} />}
                  {total.awaitingAmount > 0 && <Stat label={`Waiting for ${budgetCurrency} amount`} value={total.awaitingAmount} />}
                </dl>
                {total.awaitingAmount > 0 && (
                  <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
                    {total.awaitingAmount} {total.awaitingAmount === 1 ? 'row is' : 'rows are'} in another currency and{' '}
                    {total.awaitingAmount === 1 ? 'is' : 'are'} not counted anywhere until{' '}
                    {total.awaitingAmount === 1 ? 'its' : 'their'} amount in {budgetCurrency} is entered on Transactions.
                  </p>
                )}
              </>
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

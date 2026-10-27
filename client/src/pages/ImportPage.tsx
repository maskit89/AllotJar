import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeftRight,
  Check,
  ChevronDown,
  Columns3,
  FileCode,
  FileSpreadsheet,
  Lock,
  Pencil,
  ReceiptText,
  Split,
  TriangleAlert,
  Undo2,
  User,
  Users,
  X,
} from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { Button, ErrorBanner } from '../components/ui'
import { Modal } from '../components/Modal'
import { InfoHint } from '../components/InfoHint'
import { StatusChip } from '../components/StatusChip'
import { ActionSheet, RowMenu, type RowAction } from '../components/RowActions'
import { AssignChip, NEUTRAL, TxTile } from '../components/transactions/TxParts'
import { CommitSelect } from '../components/CommitSelect'
import { DASH_CARD } from '../components/budget/card'
import { AccountTypeGlyph } from '../components/accounts/AccountParts'
import { ImportIcon, JarNavIcon } from '../components/icons'
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
import { currencySymbol, formatMoney, formatMoneyShort, fromAmount, parseMinor, sumMinor, toAmount, tooPrecise, TOO_MANY_DECIMALS } from '../lib/money'
import { selectOnFocusProps } from '../lib/selectOnFocus'
import { formatDate, monthYear, shortDate } from '../lib/dates'
import { crossMonthError, serverErrors } from '../lib/serverErrors'
import { activeJars, useJarLedgers } from '../lib/jarLedgers'
import { jarAllocationsTotal, toJarAllocations } from '../lib/jarAllocationFields'
import { hueColor, hueForIndex, type CategoryHue } from '../lib/categoryColors'
import { useMediaQuery } from '../lib/useMediaQuery'
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

/** The format's short name, for the review's file strip. */
const FORMAT_SHORT: Record<Format, string> = { generic: 'Bank CSV', hsbc: 'HSBC CSV', camt: 'CAMT.053' }

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

// ---- The page's sentences, behind the (i) buttons (the mock-ups' hints) -----------------------

const DUPES = "Re-importing the same file won't create duplicates."
const ACCOUNT_HINT =
  'Optional. Stamps each transaction onto this account so its balance reflects the import. Pick one to record transfers between your accounts.'
const SUMMARY_HINT =
  'Rows already imported are skipped, so re-importing a file never duplicates them. A possible duplicate (an existing transaction with the same amount and a similar payee within a few days) starts unticked: tick it to import it anyway.'
const MAP_HINT =
  'We guessed how to read your file. If the rows look off, fix a column and re-scan. Rows that are the same before and after keep the categories you already gave them.'
const PENDING_HINT = 'Held for review until the departure date is known; nothing is posted to either account yet.'
const NO_ACCOUNT_HINT =
  'Some rows look like transfers between your accounts. Re-import with an account selected to record them as transfers.'
const HELD_HINT = 'Record the missing money first and commit again, or untick a row to discard it.'
const INCOMPLETE_HINT = 'Splits must add up, transfers need an account, a fee needs a category, and jar amounts can’t exceed what arrived.'

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

/** Validity + remaining-to-allocate for a row's split (in minor units); a slice is whole cents (D1). */
function splitInfo(row: ReviewRow): { valid: boolean; remainingMinor: number; tooPrecise: boolean } {
  if (!row.splits) return { valid: true, remainingMinor: 0, tooPrecise: false }
  const minors = row.splits.map((l) => parseMinor(l.amount) ?? -1)
  const allocated = sumMinor(minors.map((m) => (m < 0 ? 0 : m)))
  const remainingMinor = fromAmount(row.amount) - allocated
  const slicesTooPrecise = row.splits.some((l) => tooPrecise(l.amount))
  const valid =
    row.splits.length >= 2 &&
    row.splits.every((l, i) => l.budgetItemId !== '' && minors[i] > 0) &&
    remainingMinor === 0 &&
    !slicesTooPrecise
  return { valid, remainingMinor, tooPrecise: slicesTooPrecise }
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
  return minor !== null && minor > 0 && minor < fromAmount(r.amount) && !tooPrecise(r.feeInput)
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
  return total !== null && total <= r.amount && !jarAllocationTooPrecise(r)
}

/** A typed jar amount with more decimals than cents (D1). */
function jarAllocationTooPrecise(r: ReviewRow): boolean {
  return Object.values(r.jarAllocation).some((text) => tooPrecise(text))
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

// ---- The look (the approved mock-ups: importer*.py), shared with the other restyled pages --------

/** The page's one primary action (the Transactions page's Add transaction look). */
const PRIMARY_BUTTON =
  'h-[38px] gap-[7px] rounded-[10px] px-4 shadow-[0_1px_2px_rgb(10_50_30/0.2),inset_0_1px_0_rgb(255_255_255/0.12)] max-[899.98px]:h-10 max-[899.98px]:px-3.5 dark:bg-primary dark:hover:bg-brand-600'

/** The file strip's quiet Columns button (the mock-ups' small outline button; 40px on a phone). */
const OUTLINE_SM =
  'h-8 gap-1.5 rounded-[10px] border-slate-200 px-3 py-0 text-[13px] text-slate-900 shadow-none max-[699.98px]:h-10 max-[699.98px]:w-10 max-[699.98px]:border-transparent max-[699.98px]:bg-transparent max-[699.98px]:px-0 dark:hover:bg-foreground/7'

/** A dialog's or the upload form's field label (13px, muted). */
const FIELD_LABEL = 'flex min-h-[22px] items-center gap-1 text-[13px] font-semibold whitespace-nowrap text-slate-500'

/** An (i) in a row, a strip or beside a label: a 22px target, the icon at 15px, in the line's colour. */
const LINE_HINT =
  "relative -my-1 inline-grid size-[22px] shrink-0 place-items-center rounded-full opacity-85 transition after:absolute after:-inset-[9px] after:content-[''] hover:bg-[color-mix(in_srgb,currentColor_10%,transparent)] hover:opacity-100"
const ROW_HINT = `${LINE_HINT} text-slate-500`

/** The ⋯ shows while the row is hovered or holds focus (and always on a touch screen), as on Transactions. */
const HOVER_TRIGGER =
  'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100'

/** A sheet dialog's footer buttons (the Allocation dialogs' Cancel / Save). */
const FOOT_BTN = 'h-10! min-w-[104px] px-[18px]! max-[699.98px]:h-11! max-[699.98px]:flex-1'
const FOOT_GHOST = 'h-10! gap-1.5 px-3! text-slate-500 max-[699.98px]:h-11! max-[699.98px]:px-2.5!'

/** The include checkbox: a 40px target around the 20px box (`.im-check` in index.css draws the box).
 *  The target is the label's ::after, kept behind the box (its own stacking context) so a click
 *  on the box lands on the input itself: a hit test, as Playwright's `uncheck()` does, finds it. */
const CHECK_WRAP = "im-check relative isolate grid size-[30px] shrink-0 cursor-pointer place-items-center after:absolute after:-inset-[5px] after:-z-10 after:content-['']"

/** A chip that gives way first when its line is short of room: it truncates, at most its cell wide. */
const GIVES_WAY = 'max-w-full min-w-0 shrink!'

/** A dialog's labelled select: the words are the select's label; an (i) may sit beside them. */
function SelectField({
  label,
  hint,
  hintLabel,
  locked = false,
  className = '',
  children,
}: {
  label: string
  hint?: ReactNode
  hintLabel?: string
  /** A locked field shows a lock in place of the chevron (the select itself is disabled). */
  locked?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <span className={FIELD_LABEL}>
        <span>{label}</span>
        {hint && (
          <InfoHint fixed label={hintLabel ?? `About ${label.toLowerCase()}`} buttonClassName={LINE_HINT}>
            {hint}
          </InfoHint>
        )}
      </span>
      <span className="dlg-sel block [&_select:disabled]:bg-transparent [&_select:disabled]:text-slate-500">
        {children}
        {locked ? <Lock aria-hidden strokeWidth={1.8} /> : <ChevronDown aria-hidden strokeWidth={1.8} />}
      </span>
    </div>
  )
}

/** What a row dialog edits: the statement row, in a field-coloured panel (as Allocate's people). */
function RowSummary({ row, account, tile }: { row: ReviewRow; account: string | null; tile: ReactNode }) {
  return (
    <div className="flex min-h-[62px] items-center gap-3 rounded-xl bg-[var(--dlg-field)] py-2.5 pr-4 pl-3.5 shadow-[inset_0_0_0_1px_var(--color-line)] max-[699.98px]:pr-3.5 max-[699.98px]:pl-3">
      {tile}
      <span className="flex min-w-0 flex-col">
        <b className="truncate text-base font-semibold text-slate-900">{row.payee}</b>
        <small className="truncate text-[13px] text-slate-500">
          {shortDate(row.date)}
          {account && ` · ${account}`}
        </small>
      </span>
      <span className={`ml-auto shrink-0 text-base font-semibold tabular-nums ${row.isTransfer ? 'text-slate-500' : row.isCredit ? 'text-ok' : 'text-slate-900'}`}>
        {row.isCredit ? '+' : '−'}
        {formatMoney(fromAmount(row.amount), row.currency)}
      </span>
    </div>
  )
}

/** One stat of the done card: its label over its value, in one div (the journeys read the pair). */
function Stat({ label, value, tone, hint, hintLabel }: { label: string; value: ReactNode; tone?: 'ok'; hint?: ReactNode; hintLabel?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="flex items-center gap-1 text-[13px] text-slate-500">
        {label}
        {hint && (
          <InfoHint fixed label={hintLabel ?? `About ${label.toLowerCase()}`} buttonClassName={LINE_HINT}>
            {hint}
          </InfoHint>
        )}
      </dt>
      <dd className={`text-lg font-[650] tracking-[-0.01em] break-words tabular-nums max-[699.98px]:text-base ${tone === 'ok' ? 'text-ok' : 'text-slate-900'}`}>
        {value}
      </dd>
    </div>
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
  // The row whose split editor (a dialog) is open, by key.
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
  // The batch's one-per-batch cross-month question before committing: the categorised rows the
  // screen counted outside the loaded budget month, or the server's own refusal.
  const [crossMonthAsk, setCrossMonthAsk] = useState<{ count: number; message?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The jar-backed accounts (rules 78/79): the prompts only apply when the import account is one.
  const { byAccount } = useJarLedgers()

  // ---- The review's dialogs and open editors (restyle PR 14), each by the row's key ----------
  // The Columns dialog (the Bank CSV column mapping) and the error of a re-scan it asked for.
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [rescanError, setRescanError] = useState<string | null>(null)
  // The transfer editor, the member picker and the "From jar" picker, each for one row.
  const [transferFor, setTransferFor] = useState<string | null>(null)
  const [memberFor, setMemberFor] = useState<string | null>(null)
  const [jarFor, setJarFor] = useState<string | null>(null)
  // The list bar's bulk actions (a dialog each).
  const [bulkOpen, setBulkOpen] = useState<'member' | 'category' | null>(null)
  // The row whose category picker is open in the row, and the rows whose jar fields are open.
  const [assigning, setAssigning] = useState<string | null>(null)
  // The row whose category chip takes focus back once its picker closes by a pick or Escape (a blur
  // means focus already went somewhere else).
  const assignReturn = useRef<string | null>(null)
  useEffect(() => {
    if (assigning !== null || !assignReturn.current) return
    const key = assignReturn.current
    assignReturn.current = null
    document.querySelector<HTMLElement>(`[data-import-row="${key}"] [data-assign-chip]`)?.focus()
  }, [assigning])
  // The row whose trigger (the ⋯, or the payee on a phone) takes focus back when the Transfer or Split
  // dialog closes by removing its own opener (Undo transfer, Clear split): the chip that opened it is
  // gone by then, so the dialog's own focus return would land nowhere.
  const dialogReturn = useRef<string | null>(null)
  // A server error lands at the top of the page; on a phone the user pressed Import at the foot of
  // a long list, so bring it into view (jsdom has no scrollIntoView).
  const errorRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [error])
  useEffect(() => {
    if (transferFor !== null || splitOpen !== null || !dialogReturn.current) return
    const key = dialogReturn.current
    dialogReturn.current = null
    document.querySelector<HTMLElement>(`[data-import-row="${key}"] [data-row-trigger]`)?.focus()
  }, [transferFor, splitOpen])
  const [jarsOpen, setJarsOpen] = useState<string[]>([])
  // The row whose phone action sheet is open.
  const [sheetFor, setSheetFor] = useState<string | null>(null)
  // The page action sits in the top bar from 900px (AppShell's own breakpoint); below it the
  // page pins its own bar above the tab bar. The rows take their phone shape below 700px.
  const desktop = useMediaQuery('(min-width: 900px)')
  const phone = useMediaQuery('(max-width: 699.98px)')
  const allBox = useRef<HTMLInputElement>(null)
  // Focus moves to the new step's heading when the step changes: the button that was pressed is gone
  // by then, so the keyboard carries on from the new card and a screen reader hears where it is.
  const stepHeading = useRef<HTMLHeadingElement>(null)
  const lastPhase = useRef(phase)
  useEffect(() => {
    if (lastPhase.current === phase) return
    lastPhase.current = phase
    stepHeading.current?.focus()
  }, [phase])

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
  const incomeGroups = useMemo(() => buildItemOptions(month, TransactionType.Income), [month])
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
  /** Every line of the loaded month: a categorised row's line is one of them, a matched fee's may not be. */
  const monthLineIds = useMemo(() => new Set((month?.categories ?? []).flatMap((c) => c.items).map((i) => i.id)), [month])
  // The month's jar lines (a savings line names its jar), whose debits never ask for a jar.
  const jarLineIds = useMemo(
    () => new Set((month?.categories ?? []).flatMap((c) => c.items).filter((i) => i.savingsId).map((i) => i.id)),
    [month],
  )
  // Each budget line's colour and name, for the rows' category chips (the Transactions list's palette).
  const lines = useMemo(() => {
    const hue: Record<string, CategoryHue> = {}
    const name: Record<string, string> = {}
    if (!month) return { hue, name }
    let expenseIdx = 0
    let fundIdx = 0
    for (const c of month.categories) {
      const h: CategoryHue = c.kind === 'Income' ? 'emerald' : c.kind === 'Savings' ? hueForIndex(fundIdx++) : hueForIndex(expenseIdx++)
      for (const it of c.items) {
        hue[it.id] = h
        name[it.id] = it.name
      }
    }
    return { hue, name }
  }, [month])
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

  // The header checkbox reads mixed while only some of the rows it ticks are included.
  const someIncluded = bulkRows.some((r) => r.include)
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = !allIncluded && someIncluded
  }, [allIncluded, someIncluded])

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
    setTransferFor(null)
    setMemberFor(null)
    setJarFor(null)
    setAssigning(null)
    setJarsOpen([])
    setSheetFor(null)
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
  // The Columns dialog closes once the re-scan is in; a refusal stays in the dialog.
  async function reScanCsv() {
    if (!file || !mapping) return
    setBusy(true)
    setRescanError(null)
    try {
      const priorRows = rows
      const data = await previewImport(file, 'GenericCsv', {
        mapping,
        defaultCurrency: fallbackCurrency,
        accountId: accountId || null,
      })
      applyPreview(data, priorRows)
      setColumnsOpen(false)
    } catch (err) {
      setRescanError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /** Cancel, ✕ or Escape on the Columns dialog: the mapping goes back to the one the rows were read with. */
  function closeColumns() {
    setMapping(scannedMapping)
    setRescanError(null)
    setColumnsOpen(false)
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
    setColumnsOpen(false)
    setRescanError(null)
    setTransferFor(null)
    setMemberFor(null)
    setJarFor(null)
    setBulkOpen(null)
    setAssigning(null)
    setJarsOpen([])
    setSheetFor(null)
  }

  // ---- The page action: "Import N transactions", in the top bar (desktop) or the pinned bar (phone) ----
  const importDisabled = busy || (includedCount === 0 && !heldMode) || reviewIncomplete || mappingDirty
  const importLabel = busy
    ? 'Importing…'
    : heldMode
      ? includedCount === 0
        ? 'Finish without the held rows'
        : 'Commit held rows'
      : `Import ${includedCount} transaction${includedCount === 1 ? '' : 's'}`
  const reviewing = canWrite && phase === 'review' && !!preview && rows.length > 0
  const importButton = reviewing ? (
    <Button onClick={() => onCommit()} disabled={importDisabled} className={`${PRIMARY_BUTTON} max-[899.98px]:w-full`}>
      {!busy && <ImportIcon className="size-4" />}
      {importLabel}
    </Button>
  ) : null

  const rowByKey = (key: string | null) => (key === null ? -1 : rows.findIndex((r) => r.key === key))
  const transferIndex = rowByKey(transferFor)
  const splitIndex = rowByKey(splitOpen)
  const memberIndex = rowByKey(memberFor)
  const jarIndex = rowByKey(jarFor)
  const groupsFor = (r: ReviewRow) => (r.isCredit ? incomeGroups : expenseGroups)

  // ---- The review rows -------------------------------------------------------------------------
  function renderRow(r: ReviewRow, index: number) {
    const groups = groupsFor(r)
    const info = splitInfo(r)
    const domId = rowDomId(r.reference, index)
    const name = `${r.payee} on ${r.date}`
    const match = chosenMatch(r)
    const returning = match?.kind === 'Return'
    const feeMinor = rowFeeMinor(r)
    // An unticked row steps back to the muted colours; nothing fades (the empty box says it is left out).
    const off = !r.include
    // The jar prompts (rules 78/79) apply only to a ticked row into/out of a jar-backed account.
    const showAllocation = importBacksJars && r.include && r.isCredit && !isReturnRow(r)
    const showPaidFrom = importBacksJars && r.include && paidFromApplies(r, jarLineIds)
    const jarsAreOpen = showAllocation && jarsOpen.includes(r.key)
    const jarTotal = jarAllocationsTotal(r.jarAllocation)
    // Wrong jar amounts mark the row whether the fields are open or folded away (a re-scan folds them).
    const jarsProblem = showAllocation && !jarAllocationValid(r) ? (jarAllocationTooPrecise(r) ? TOO_MANY_DECIMALS : 'The jar amounts exceed what arrived.') : undefined
    const paidFromJar = showPaidFrom && r.paidFromJarId ? importJars.find((j) => j.jarId === r.paidFromJarId) : undefined
    const lineColor = r.budgetItemId && lines.hue[r.budgetItemId] ? hueColor(lines.hue[r.budgetItemId]) : NEUTRAL
    const jarLine = !!r.budgetItemId && jarLineIds.has(r.budgetItemId)

    // ---- The row's actions: the ⋯ menu (desktop) and the phone sheet, one list ----------------
    const actions: RowAction[] = []
    if (r.isTransfer) {
      actions.push({
        key: 'edit-transfer',
        label: 'Edit transfer',
        ariaLabel: `Edit transfer for ${name}`,
        icon: <Pencil aria-hidden />,
        after: 'dialog',
        onSelect: () => setTransferFor(r.key),
      })
      actions.push({
        key: 'undo-transfer',
        label: 'Undo transfer',
        ariaLabel: `Undo transfer for ${name}`,
        icon: <Undo2 aria-hidden />,
        onSelect: () => clearTransfer(index),
      })
    } else if (r.splits) {
      actions.push({
        key: 'edit-split',
        label: 'Edit split',
        ariaLabel: `Edit split for ${name}`,
        icon: <Split aria-hidden />,
        after: 'dialog',
        onSelect: () => setSplitOpen(r.key),
      })
      actions.push({ key: 'clear-split', label: 'Clear split', icon: <X aria-hidden />, onSelect: () => clearSplit(index) })
    } else {
      actions.push({
        key: 'split',
        label: 'Split',
        ariaLabel: `Split ${name}`,
        icon: <Split aria-hidden />,
        disabled: !r.include,
        after: 'dialog',
        onSelect: () => startSplit(index, r.key),
      })
      if (canTransfer) {
        actions.push({
          key: 'transfer',
          label: 'Mark as transfer',
          ariaLabel: `Mark as transfer: ${name}`,
          icon: <ArrowLeftRight aria-hidden />,
          disabled: !r.include,
          after: 'dialog',
          onSelect: () => {
            startTransfer(index)
            setTransferFor(r.key)
          },
        })
      }
      actions.push({
        key: 'member',
        label: 'Member',
        ariaLabel: `Member for ${name}`,
        icon: <User aria-hidden />,
        disabled: !r.include || members.length === 0,
        after: 'dialog',
        onSelect: () => setMemberFor(r.key),
      })
    }
    if (showPaidFrom) {
      actions.push({
        key: 'from-jar',
        label: 'From jar…',
        ariaLabel: `From jar for ${name}`,
        icon: <JarNavIcon aria-hidden strokeWidth={1.8} />,
        after: 'dialog',
        onSelect: () => setJarFor(r.key),
      })
    }

    // ---- The flags beside the payee (desktop) or under the category (phone) --------------------
    const flags: ReactNode[] = []
    if (r.heldMessage !== null) {
      flags.push(
        <span key="held" className="inline-flex items-center gap-0.5">
          <StatusChip tone="bad">Held</StatusChip>
          <InfoHint fixed label={`Why ${r.payee} was held`} buttonClassName={ROW_HINT} align={phone ? 'center' : 'start'}>
            {r.heldMessage}
          </InfoHint>
        </span>,
      )
    }
    if (r.possibleDuplicate) flags.push(<StatusChip key="dup" tone="warn">Possible duplicate</StatusChip>)
    if (r.reusedReference) {
      flags.push(
        <span key="ref" className="inline-flex items-center gap-0.5">
          <StatusChip tone="warn">Same reference</StatusChip>
          <InfoHint fixed label={`About the bank reference of ${r.payee}`} buttonClassName={ROW_HINT} align={phone ? 'center' : 'start'}>
            An entry with this bank reference was already imported: {formatDate(r.reusedReference.date)}{' '}
            {r.reusedReference.isCredit ? '+' : '−'}
            {formatMoney(fromAmount(r.reusedReference.amount), r.currency)}. Tick it only if this is a different payment.
          </InfoHint>
        </span>,
      )
    }
    if (r.likelyTransfer && !r.isTransfer) flags.push(<StatusChip key="likely" tone="line">Looks like a transfer</StatusChip>)
    if (!r.likelyTransfer && !r.isTransfer && r.transferMatches.some((m) => m.kind === 'Return')) {
      flags.push(<StatusChip key="back" tone="line">Looks like a transfer coming back</StatusChip>)
    }

    // ---- The category cell: the transfer, the split, or the line (a chip, or its picker) -------
    let main: ReactNode
    let xflag: ReactNode = null
    if (r.isTransfer) {
      // The row carries every reason the transfer blocks the import, as the dialog does: a missing
      // account, a fee with no line (rule 91), or a typed fee the row can't carry.
      const noAccount = !returning && !r.transferAccountId && !r.matchTransferId
      const incomplete = noAccount || feeLineMissing(r) || !manualFeeValid(r)
      const problem = noAccount
        ? 'Choose the other account.'
        : !manualFeeValid(r)
          ? 'The fee must be more than zero and less than the row’s amount.'
          : feeLineMissing(r)
            ? 'Choose the fee’s category.'
            : undefined
      const other = returning
        ? 'coming back'
        : match && match.counterpartyAccountId === null
          ? `${r.isCredit ? 'from' : 'to'} ${match.counterpartyAccountName || 'Private account'}`
          : r.transferAccountId
            ? `${r.isCredit ? 'from' : 'to'} ${otherAccounts.find((a) => a.id === r.transferAccountId)?.name ?? '…'}`
            : 'Choose account…'
      main = (
        <button
          type="button"
          onClick={() => setTransferFor(r.key)}
          title={problem}
          className={`group/x relative flex min-w-0 items-center gap-2 rounded-lg after:absolute after:-inset-x-1 after:-inset-y-2.5 after:content-[''] ${phone ? 'z-10' : ''}`}
        >
          {/* "Edit transfer for Lidl: Transfer to Savings", the visible words inside the spoken name. */}
          <span className="sr-only">Edit transfer for {name}:</span>{' '}
          {/* On a phone the icon alone says "transfer" (the mock-up's row), the chip only on a wide screen. */}
          {!phone && (
            <StatusChip tone={incomplete ? 'bad' : 'line'}>
              <ArrowLeftRight aria-hidden strokeWidth={2} />
              Transfer
            </StatusChip>
          )}
          <span className={`flex min-w-0 items-center gap-1.5 text-[13px] whitespace-nowrap transition group-hover/x:text-slate-900 ${phone ? 'text-slate-500' : 'text-slate-400'} ${incomplete ? 'text-bad!' : ''}`}>
            {phone && <ArrowLeftRight aria-hidden strokeWidth={2} className="size-[13px] shrink-0" />}
            <span className="truncate">{other}</span>
          </span>
        </button>
      )
      if (!returning && r.transferMatches.length > 0 && !r.matchTransferId) {
        xflag = (
          <button
            type="button"
            onClick={() => setTransferFor(r.key)}
            aria-label={`Already recorded? ${name}`}
            className={`relative after:absolute after:-inset-x-1 after:-inset-y-2.5 after:content-[''] ${phone ? 'z-10' : ''}`}
          >
            <StatusChip tone="warn">Already recorded?</StatusChip>
          </button>
        )
      } else if (!returning && r.isCredit && !r.matchTransferId) {
        xflag = (
          <span className="inline-flex items-center gap-0.5">
            <StatusChip tone="warn">Pending review</StatusChip>
            <InfoHint fixed label="About pending review" buttonClassName={ROW_HINT} align={phone ? 'center' : 'start'}>
              {PENDING_HINT}
            </InfoHint>
          </span>
        )
      }
    } else if (r.splits) {
      const slices = r.splits.map((s) => {
        const lineName = lines.name[s.budgetItemId] ?? 'Unassigned'
        const minor = parseMinor(s.amount)
        return minor !== null && s.amount.trim() ? `${lineName} ${formatMoneyShort(minor, r.currency)}` : lineName
      })
      main = (
        <button
          type="button"
          onClick={() => setSplitOpen(r.key)}
          title={`Split: ${slices.join(' · ')}`}
          className={`relative min-w-0 after:absolute after:-inset-x-1 after:-inset-y-2.5 after:content-[''] ${phone ? 'z-10' : ''}`}
        >
          <span className="sr-only">Edit split for {name}:</span>{' '}
          <StatusChip tone={info.valid ? 'line' : 'bad'} className={GIVES_WAY}>
            <Split aria-hidden strokeWidth={2} />
            <span className="sr-only">Split: </span>
            <span className="min-w-0 truncate">{slices.join(' · ')}</span>
          </StatusChip>
        </button>
      )
    } else if (assigning === r.key) {
      main = (
        // Arrow keys move the choice; Enter, leaving the select or a pointer choice commits it, and
        // Escape closes it unchanged (#350 P3-1).
        <CommitSelect
          autoFocus
          initial={r.budgetItemId}
          aria-label={`Category for ${name}`}
          onCommit={(value, how) => {
            if (value !== r.budgetItemId) updateRow(index, { budgetItemId: value })
            // Focus back on the chip after a choice; a blur has already put it where it went.
            if (how === 'pick') assignReturn.current = r.key
            setAssigning(null)
          }}
          onCancel={() => {
            assignReturn.current = r.key
            setAssigning(null)
          }}
          className="relative z-10 h-8 w-56 max-w-full max-[699.98px]:h-10 rounded-lg border border-input bg-surface px-2 text-sm text-slate-700 focus:border-brand-600 focus:ring-2 focus:ring-brand-500/40 focus:outline-none focus-visible:outline-none! disabled:opacity-50"
        >
          <CategoryOptions groups={groups} />
        </CommitSelect>
      )
    } else {
      main = (
        <AssignChip
          color={r.budgetItemId ? (off ? NEUTRAL : lineColor) : undefined}
          line={jarLine}
          icon={jarLine ? <JarNavIcon strokeWidth={2} /> : undefined}
          label={r.budgetItemId ? (lines.name[r.budgetItemId] ?? 'Unassigned') : 'Assign'}
          aria-label={`${r.budgetItemId ? 'Reassign' : 'Assign'} ${name}`}
          disabled={!r.include}
          // Unticked, the line is already in the muted colour: it stays readable, only the dashed Assign fades.
          fade={!r.budgetItemId}
          onClick={() => setAssigning(r.key)}
          className={phone ? 'z-10' : ''}
        />
      )
    }
    const jarChip = paidFromJar && (
      <StatusChip tone="line" className={GIVES_WAY} title={`From jar: ${paidFromJar.name}`}>
        <JarNavIcon aria-hidden strokeWidth={2} />
        <span className="min-w-0 truncate">From {paidFromJar.name}</span>
      </StatusChip>
    )
    const memberName = !r.isTransfer && !r.splits && r.memberId ? members.find((m) => m.id === r.memberId)?.name : undefined
    const memberChip = memberName && (
      <StatusChip tone="line" className={GIVES_WAY} title={`Member: ${memberName}`}>
        <User aria-hidden strokeWidth={2} />
        <span className="min-w-0 truncate">{memberName}</span>
      </StatusChip>
    )

    // ---- The amount, and under it a credit's jar answer (which opens the jar fields) ------------
    const amount = (
      <div className="flex min-w-0 flex-col items-end gap-[3px] text-right">
        <span
          data-import-amount=""
          className={`text-sm whitespace-nowrap tabular-nums ${
            off ? 'font-semibold text-slate-500' : r.isTransfer ? 'font-semibold text-slate-500' : r.isCredit ? 'font-[650] text-ok' : 'font-[650] text-slate-900'
          }`}
        >
          {r.isCredit ? '+' : '−'}
          {formatMoney(fromAmount(r.amount), r.currency)}
        </span>
        {r.isTransfer && feeMinor !== null && manualFeeValid(r) && (
          <span className="text-xs whitespace-nowrap text-slate-400 tabular-nums">+ fee {formatMoney(feeMinor, r.currency)}</span>
        )}
        {showAllocation && (
          <button
            type="button"
            aria-expanded={jarsAreOpen}
            aria-controls={`${domId}-jars`}
            onClick={() => setJarsOpen((open) => (open.includes(r.key) ? open.filter((k) => k !== r.key) : [...open, r.key]))}
            title={jarsProblem}
            className={`relative inline-flex items-center gap-[3px] rounded-md text-xs font-semibold whitespace-nowrap transition after:absolute after:-inset-x-1.5 after:-inset-y-3 after:content-[''] ${
              jarsProblem ? 'text-bad hover:text-bad' : 'text-slate-500 hover:text-slate-900'
            } ${phone ? 'z-10' : ''}`}
          >
            {jarTotal !== null && jarTotal > 0 ? `${formatMoneyShort(fromAmount(jarTotal), r.currency)} into jars` : 'Into jars'}
            <ChevronDown aria-hidden strokeWidth={2} className={`size-3 text-slate-400 transition ${jarsAreOpen ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>
    )

    const payeeText = (
      <span className={`min-w-0 truncate text-left text-sm font-semibold ${off ? 'text-slate-500' : 'text-slate-900'}`}>{r.payee}</span>
    )
    const payee =
      phone && actions.length > 0 ? (
        <ActionSheet title={r.payee} description={shortDate(r.date)} actions={actions} open={sheetFor === r.key} onOpenChange={(open) => setSheetFor(open ? r.key : null)}>
          <button
            type="button"
            data-row-trigger=""
            className={`min-w-0 truncate text-left text-sm font-semibold after:absolute after:inset-0 after:rounded-[10px] after:content-[''] focus-visible:outline-none! focus-visible:after:outline-2 focus-visible:after:-outline-offset-1 focus-visible:after:outline-ring ${off ? 'text-slate-500' : 'text-slate-900'}`}
          >
            {r.payee}
          </button>
        </ActionSheet>
      ) : (
        payeeText
      )

    const include = (
      <label className={CHECK_WRAP}>
        <input
          type="checkbox"
          aria-label={`Include ${name}`}
          checked={r.include}
          onChange={(e) => updateRow(index, { include: e.target.checked })}
        />
      </label>
    )

    // ---- The editors under the row: a credit's jar fields (rule 78) ----------------------------
    const jarFields = showAllocation && (
      <div
        id={`${domId}-jars`}
        hidden={!jarsAreOpen}
        className="dlg-scope dlg-scope-panel mr-[46px] mb-3 ml-[110px] rounded-xl bg-surface-2 px-[18px] pt-3.5 pb-3 shadow-[inset_0_0_0_1px_var(--color-line)] max-[699.98px]:mr-0 max-[699.98px]:ml-[42px] max-[699.98px]:px-3.5 max-[699.98px]:pt-2.5 max-[699.98px]:pb-2.5 dark:bg-[color-mix(in_srgb,var(--color-background)_55%,var(--color-card))]"
      >
        <JarAllocationFields
          look="dialog"
          columns={2}
          title={`Put into jars in ${importAccount?.name ?? ''}`}
          hint={r.isTransfer && !r.matchTransferId ? 'These jar amounts apply once the transfer’s departure is confirmed.' : undefined}
          jars={importJars}
          accountName={importAccount?.name ?? ''}
          currency={importCurrency}
          amount={r.amount}
          value={r.jarAllocation}
          onChange={(value) => updateRow(index, { jarAllocation: value })}
          idPrefix={domId}
          placeholder="0.00"
        />
        {jarAllocationTooPrecise(r) && (
          <p role="alert" className="mt-1.5 text-[13px] text-bad">
            {TOO_MANY_DECIMALS}
          </p>
        )}
      </div>
    )

    const more = !phone && actions.length > 0 && (
      <RowMenu label={`${name}: more actions`} actions={actions} triggerClassName={HOVER_TRIGGER} />
    )

    return (
      <li key={r.key} data-import-row={r.key} className="not-first:border-t not-first:border-line">
        <div
          data-testid="import-row"
          className={
            phone
              ? 'group relative grid min-h-[60px] grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-[5px] py-[11px]'
              : // Below 1024px (a tablet) the payee column takes a little more than the category column, so a flagged payee is not cut short beside an emptier cell.
                'group relative grid min-h-14 grid-cols-[30px_52px_minmax(0,1fr)_minmax(0,1.3fr)_128px_32px] items-center gap-x-3.5 py-3 max-[1023.98px]:grid-cols-[30px_52px_minmax(0,1.2fr)_minmax(0,1fr)_128px_32px]'
          }
        >
          {phone ? (
            <>
              {/* Above the payee button's full-row overlay (as the chips are), so a tap on the box ticks it. */}
              <div className="relative z-10 col-start-1 row-span-2 row-start-1 self-center">{include}</div>
              {/* Line 1: the payee and what flags it (a flag that would not fit beside it drops under it; a long payee
                  truncates); line 2: the line, the date, the rest. */}
              <div className="col-start-2 row-start-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                {payee}
                {flags}
              </div>
              <div className="col-start-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
                {main}
                <span className={`shrink-0 text-xs whitespace-nowrap tabular-nums text-slate-400`}>
                  {r.isTransfer && <span aria-hidden>· </span>}
                  {shortDate(r.date)}
                </span>
                {jarChip}
                {memberChip}
                {xflag}
              </div>
              <div className="col-start-3 row-span-2 row-start-1 self-center">{amount}</div>
            </>
          ) : (
            <>
              {include}
              <span className={`text-[13px] whitespace-nowrap tabular-nums text-slate-400`}>{shortDate(r.date)}</span>
              <div className="flex min-w-0 items-center gap-2">
                {payee}
                {flags}
              </div>
              <div className="flex min-w-0 items-center gap-2">
                {main}
                {jarChip}
                {memberChip}
                {xflag}
              </div>
              {amount}
              <div className="flex justify-end">{more}</div>
            </>
          )}
        </div>
        {jarFields}
      </li>
    )
  }

  // ---- The transfer editor (a dialog on a wide screen, a bottom sheet on a phone) ---------------
  function renderTransferDialog() {
    if (transferIndex < 0) return null
    const r = rows[transferIndex]
    const index = transferIndex
    const name = `${r.payee} on ${r.date}`
    const match = chosenMatch(r)
    const returning = match?.kind === 'Return'
    const feeMinor = rowFeeMinor(r)
    const typedFee = !r.isCredit && !match
    const privateSide = !!match && match.counterpartyAccountId === null
    const domId = rowDomId(r.reference, index)
    const close = () => setTransferFor(null)
    return (
      <Modal
        sheet
        title="Transfer"
        onClose={close}
        footer={
          <div className="mt-[22px] flex items-center gap-2 max-[699.98px]:mt-[18px]">
            <Button
              variant="ghost"
              onClick={() => {
                dialogReturn.current = r.key
                clearTransfer(index)
                close()
              }}
              aria-label={`Undo transfer for ${name}`}
              disabled={busy}
              className={FOOT_GHOST}
            >
              <Undo2 aria-hidden className="size-4 text-slate-400" />
              Undo transfer
            </Button>
            <span className="flex-1" />
            <Button onClick={close} disabled={busy} className={`${PRIMARY_BUTTON} ${FOOT_BTN}`}>
              Done
            </Button>
          </div>
        }
      >
        <RowSummary
          row={r}
          account={importAccount?.name ?? null}
          tile={
            <TxTile color={hueColor('teal')}>
              <ArrowLeftRight strokeWidth={1.8} />
            </TxTile>
          }
        />
        {!r.include && <p className="mt-3 text-[13px] text-slate-500">Tick the row to edit its transfer.</p>}
        <fieldset disabled={busy} className="m-0 mt-[18px] flex min-w-0 flex-col gap-4 border-0 p-0">
          {/* The other account: fixed by a chosen recorded transfer; named, never chosen, when it is private to another login. */}
          {returning ? null : privateSide ? (
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className={FIELD_LABEL}>{r.isCredit ? 'From' : 'To'}</span>
              <span className="flex h-10 items-center gap-2 rounded-[9px] px-3 text-sm font-semibold text-slate-500 shadow-[inset_0_0_0_1px_var(--dlg-edge)] max-[699.98px]:h-11 max-[699.98px]:text-base">
                <Lock aria-hidden strokeWidth={1.8} className="size-4 text-slate-400" />
                {match.counterpartyAccountName || 'Private account'}
              </span>
            </div>
          ) : (
            <SelectField label={r.isCredit ? 'From' : 'To'} locked={!!r.matchTransferId}>
              <select
                aria-label={`Transfer account for ${name}`}
                value={r.transferAccountId}
                disabled={!r.include || !!r.matchTransferId}
                onChange={(e) => updateRow(index, { transferAccountId: e.target.value })}
              >
                <option value="">Choose account…</option>
                {otherAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </SelectField>
          )}

          {/* "Already recorded?": the few candidates as a radio group, in the server's order (nearest date first, rule 87). */}
          {r.transferMatches.length > 0 && (
            <fieldset aria-label={`Match recorded transfer for ${name}`} disabled={!r.include} className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
              <legend className={`${FIELD_LABEL} mb-1.5 p-0`}>Already recorded?</legend>
              <div className="rounded-xl bg-[var(--dlg-field)] shadow-[inset_0_0_0_1px_var(--color-line)]">
                {[{ transferId: '', label: 'No — record it as a new transfer' }, ...r.transferMatches.map((m) => ({ transferId: m.transferId, label: matchLabel(r, m) }))].map((o) => {
                  const chosen = r.matchTransferId === o.transferId
                  return (
                    <label
                      key={o.transferId || 'new'}
                      className={`flex min-h-12 cursor-pointer items-center gap-3 px-3.5 py-2.5 text-sm not-first:border-t not-first:border-line ${chosen ? 'font-semibold text-slate-900' : 'font-medium text-slate-900'}`}
                    >
                      <input
                        type="radio"
                        name={`${rowDomId(r.reference, index)}-match`}
                        value={o.transferId}
                        checked={chosen}
                        onChange={() => chooseMatch(index, o.transferId)}
                        className="size-[18px] shrink-0 cursor-pointer appearance-none rounded-full border-[1.5px] border-[color-mix(in_srgb,var(--color-slate-400)_80%,var(--color-card))] bg-card checked:border-[5px] checked:border-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:checked:border-primary"
                      />
                      <span className="min-w-0 tabular-nums [overflow-wrap:anywhere]">{o.label}</span>
                    </label>
                  )
                })}
              </div>
              {match?.sameReference && (
                <div>
                  <StatusChip tone="line">Same bank reference</StatusChip>
                </div>
              )}
              {match?.recordedDate && (
                <p className="text-[13px] text-slate-500">
                  Recorded in the app on {formatDate(match.recordedDate)}; the bank&rsquo;s date will be used.
                </p>
              )}
            </fieldset>
          )}

          {/* A fee: the candidate's (accepted by choosing it) or one typed for an unmatched debit. */}
          {typedFee && (
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor={`${rowDomId(r.reference, index)}-fee`} className={FIELD_LABEL}>
                Fee (optional)
              </label>
              <span className="dlg-in w-36 max-[699.98px]:w-full">
                <span aria-hidden>{currencySymbol(r.currency)}</span>
                <input
                  id={`${rowDomId(r.reference, index)}-fee`}
                  inputMode="decimal"
                  {...selectOnFocusProps}
                  placeholder="0.00"
                  aria-label={`Fee for ${name}`}
                  aria-invalid={!manualFeeValid(r) || undefined}
                  aria-describedby={!manualFeeValid(r) ? `${domId}-fee-error` : undefined}
                  value={r.feeInput}
                  disabled={!r.include}
                  onChange={(e) => updateRow(index, { feeInput: e.target.value })}
                />
              </span>
              {!manualFeeValid(r) && (
                <p id={`${domId}-fee-error`} role="alert" className="text-[13px] text-bad">
                  {tooPrecise(r.feeInput) ? TOO_MANY_DECIMALS : 'The fee must be more than zero and less than the row’s amount.'}
                </p>
              )}
            </div>
          )}
          {feeMinor !== null && (
            <SelectField
              label="Fee category"
              hint={
                typedFee
                  ? `A transfer of ${formatMoney(fromAmount(r.amount) - feeMinor, r.currency)} plus a fee of ${formatMoney(feeMinor, r.currency)}.`
                  : `Records a fee of ${formatMoney(feeMinor, r.currency)}.`
              }
              hintLabel="About the fee"
            >
              <select
                aria-label={`Fee category for ${name}`}
                value={r.feeBudgetItemId}
                disabled={!r.include}
                aria-invalid={feeLineMissing(r) || undefined}
                aria-describedby={feeLineMissing(r) ? `${domId}-fee-line-error` : undefined}
                onChange={(e) => updateRow(index, { feeBudgetItemId: e.target.value })}
              >
                <CategoryOptions groups={expenseGroups} emptyLabel="Choose a line…" currentId={r.feeBudgetItemId} />
              </select>
            </SelectField>
          )}
          {feeLineMissing(r) && (
            <p id={`${domId}-fee-line-error`} role="alert" className="-mt-2 text-[13px] text-bad">
              Choose the fee&rsquo;s category.
            </p>
          )}

          {/* The status: what the choices above do, with the ok tick (a receipt with no departure waits, in orange). */}
          {returning ? (
            <p className="flex items-start gap-[7px] text-[13px] leading-[1.45] text-slate-500">
              <Check aria-hidden strokeWidth={2.2} className="mt-0.5 size-[15px] shrink-0 text-ok" />
              <span>
                Records the transfer to {match.counterpartyAccountName} as returned: the money is back in {importAccount?.name ?? 'this account'} and
                goes back to the jars it left from.
              </span>
            </p>
          ) : r.matchTransferId ? (
            <p className="flex items-start gap-[7px] text-[13px] leading-[1.45] text-slate-500">
              <Check aria-hidden strokeWidth={2.2} className="mt-0.5 size-[15px] shrink-0 text-ok" />
              <span>Confirms the other side of the recorded transfer — no second balance movement.</span>
            </p>
          ) : r.isCredit ? (
            <p className="flex items-start gap-[7px] text-[13px] leading-[1.45] text-warn">
              <TriangleAlert aria-hidden strokeWidth={2} className="mt-0.5 size-[15px] shrink-0" />
              <span>Held for review until the departure date is known; nothing is posted to either account yet.</span>
            </p>
          ) : (
            <p className="flex items-start gap-[7px] text-[13px] leading-[1.45] text-slate-500">
              <Check aria-hidden strokeWidth={2.2} className="mt-0.5 size-[15px] shrink-0 text-ok" />
              <span>Recorded as departed on {formatDate(r.date)}; in transit until the receipt is confirmed.</span>
            </p>
          )}
        </fieldset>
      </Modal>
    )
  }

  // ---- The split editor: the slices, the remainder, Add line / Clear split / Done ---------------
  function renderSplitDialog() {
    if (splitIndex < 0) return null
    const r = rows[splitIndex]
    const index = splitIndex
    if (!r.splits) return null
    const info = splitInfo(r)
    const groups = groupsFor(r)
    const hasMembers = members.length > 0
    const close = () => setSplitOpen(null)
    const splitColor = r.splits[0]?.budgetItemId && lines.hue[r.splits[0].budgetItemId] ? hueColor(lines.hue[r.splits[0].budgetItemId]) : NEUTRAL
    return (
      <Modal
        sheet
        title="Split"
        onClose={close}
        footer={
          <div className="mt-[22px] flex items-center gap-2 max-[699.98px]:mt-[18px]">
            <Button
              variant="ghost"
              onClick={() => {
                dialogReturn.current = r.key
                clearSplit(index)
              }}
              disabled={busy}
              className={FOOT_GHOST}
            >
              <X aria-hidden className="size-4 text-slate-400" />
              Clear split
            </Button>
            <span className="flex-1" />
            <Button onClick={close} disabled={!info.valid || busy} className={`${PRIMARY_BUTTON} ${FOOT_BTN}`}>
              Done
            </Button>
          </div>
        }
      >
        <RowSummary
          row={r}
          account={importAccount?.name ?? null}
          tile={
            <TxTile color={splitColor}>
              <Split strokeWidth={1.8} />
            </TxTile>
          }
        />
        <fieldset disabled={busy} className="m-0 mt-[18px] flex min-w-0 flex-col gap-3 border-0 p-0">
          <legend className="sr-only">Split lines</legend>
          {r.splits.map((line, li) => (
            <div
              key={li}
              className={`grid items-center gap-2 ${
                hasMembers
                  ? 'grid-cols-[minmax(0,1fr)_112px_minmax(0,0.8fr)_36px] max-[699.98px]:grid-cols-[minmax(0,1fr)_100px_36px]'
                  : 'grid-cols-[minmax(0,1fr)_112px_36px] max-[699.98px]:grid-cols-[minmax(0,1fr)_100px_36px]'
              }`}
            >
              <span className="dlg-sel block min-w-0">
                <select
                  aria-label={`Split line ${li + 1} category for ${r.payee}`}
                  value={line.budgetItemId}
                  onChange={(e) => updateSplitLine(index, li, { budgetItemId: e.target.value })}
                >
                  <CategoryOptions groups={groups} />
                </select>
                <ChevronDown aria-hidden strokeWidth={1.8} />
              </span>
              <span className="dlg-in">
                <span aria-hidden>{currencySymbol(r.currency)}</span>
                <input
                  inputMode="decimal"
                  {...selectOnFocusProps}
                  placeholder="0.00"
                  aria-label={`Split line ${li + 1} amount for ${r.payee}`}
                  value={line.amount}
                  onChange={(e) => updateSplitLine(index, li, { amount: e.target.value })}
                />
              </span>
              {hasMembers && (
                <span className="dlg-sel block min-w-0 max-[699.98px]:col-span-2 max-[699.98px]:col-start-1">
                  <select
                    aria-label={`Split line ${li + 1} member for ${r.payee}`}
                    value={line.memberId}
                    onChange={(e) => updateSplitLine(index, li, { memberId: e.target.value })}
                  >
                    <option value="">No member</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown aria-hidden strokeWidth={1.8} />
                </span>
              )}
              {r.splits!.length > 2 ? (
                <button
                  type="button"
                  onClick={() => removeSplitLine(index, li)}
                  aria-label={`Remove split line ${li + 1} for ${r.payee}`}
                  title="Remove line"
                  className={`grid size-9 place-items-center rounded-lg text-slate-500 transition hover:bg-bad-bg hover:text-bad ${hasMembers ? 'max-[699.98px]:col-start-3 max-[699.98px]:row-start-1' : ''}`}
                >
                  <X aria-hidden className="size-4" />
                </button>
              ) : (
                <span className={hasMembers ? 'max-[699.98px]:col-start-3 max-[699.98px]:row-start-1' : ''} />
              )}
            </div>
          ))}
          <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
            <Button variant="ghost" size="sm" onClick={() => addSplitLine(index)} className="-ml-2 h-8 px-2 text-[13px] text-slate-500 hover:text-slate-900 max-[699.98px]:h-10">
              + Add line
            </Button>
            <span
              aria-label="Remaining to allocate"
              className={`text-[13px] font-semibold tabular-nums ${info.remainingMinor === 0 && !info.tooPrecise ? 'text-ok' : 'text-bad'}`}
            >
              {info.tooPrecise
                ? TOO_MANY_DECIMALS
                : info.remainingMinor === 0
                  ? 'Fully allocated'
                  : info.remainingMinor < 0
                    ? `${formatMoney(-info.remainingMinor, r.currency)} over`
                    : `${formatMoney(info.remainingMinor, r.currency)} left`}
            </span>
          </div>
        </fieldset>
      </Modal>
    )
  }

  // ---- A row's member (a dialog), and which jar a payment comes from (rule 79) ------------------
  function renderMemberDialog() {
    if (memberIndex < 0) return null
    const r = rows[memberIndex]
    const index = memberIndex
    const close = () => setMemberFor(null)
    return (
      <Modal
        sheet
        title="Member"
        onClose={close}
        footer={
          <div className="mt-[22px] flex justify-end gap-2 max-[699.98px]:mt-[18px]">
            <Button onClick={close} disabled={busy} className={`${PRIMARY_BUTTON} ${FOOT_BTN}`}>
              Done
            </Button>
          </div>
        }
      >
        <RowSummary
          row={r}
          account={importAccount?.name ?? null}
          tile={
            <TxTile color={r.budgetItemId && lines.hue[r.budgetItemId] ? hueColor(lines.hue[r.budgetItemId]) : NEUTRAL}>
              <User strokeWidth={1.8} />
            </TxTile>
          }
        />
        <div className="mt-[18px]">
          <SelectField label="Member">
            <select
              aria-label={`Member for ${r.payee} on ${r.date}`}
              value={r.memberId}
              disabled={!r.include || members.length === 0 || busy}
              onChange={(e) => updateRow(index, { memberId: e.target.value })}
            >
              <option value="">No member</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </SelectField>
        </div>
      </Modal>
    )
  }

  function renderJarDialog() {
    if (jarIndex < 0) return null
    const r = rows[jarIndex]
    const index = jarIndex
    const close = () => setJarFor(null)
    return (
      <Modal
        sheet
        title="From jar"
        onClose={close}
        hint={`Which jar in ${importAccount?.name ?? 'this account'} does this come from? Leave it unallocated to take the money from no jar.`}
        hintLabel="About paying from a jar"
        footer={
          <div className="mt-[22px] flex justify-end gap-2 max-[699.98px]:mt-[18px]">
            <Button onClick={close} disabled={busy} className={`${PRIMARY_BUTTON} ${FOOT_BTN}`}>
              Done
            </Button>
          </div>
        }
      >
        <RowSummary
          row={r}
          account={importAccount?.name ?? null}
          tile={
            <TxTile color={hueColor('teal')}>
              <JarNavIcon strokeWidth={1.8} />
            </TxTile>
          }
        />
        <fieldset disabled={busy} className="m-0 mt-[18px] min-w-0 border-0 p-0">
          <PaidFromJarSelect
            look="dialog"
            jars={importJars}
            accountName={importAccount?.name ?? ''}
            currency={importCurrency}
            value={r.paidFromJarId}
            onChange={(jarId) => updateRow(index, { paidFromJarId: jarId })}
            id={`${rowDomId(r.reference, index)}-paid-from`}
            compact
          />
        </fieldset>
      </Modal>
    )
  }

  // ---- The list bar's bulk actions: a member for the included rows, a line for the included expenses ----
  function renderBulkDialog() {
    if (!bulkOpen) return null
    const member = bulkOpen === 'member'
    const close = () => setBulkOpen(null)
    const apply = () => {
      if (member) applyMemberToIncluded()
      else applyCategoryToIncluded()
      close()
    }
    const nothing = member ? members.length === 0 : expenseGroups.length === 0
    return (
      <Modal
        sheet
        title={member ? 'Member for included rows' : 'Category for included expenses'}
        onClose={close}
        hint={
          member
            ? 'Sets whose spending every ticked row is. Split rows and transfers keep their own answers.'
            : 'Puts every ticked expense on this line. Money in, split rows and transfers keep their own lines.'
        }
        hintLabel={member ? 'About the bulk member' : 'About the bulk category'}
        footer={
          <div className="mt-[22px] flex justify-end gap-2 max-[699.98px]:mt-[18px]">
            <Button variant="ghost" onClick={close} className={FOOT_GHOST}>
              Cancel
            </Button>
            <Button onClick={apply} disabled={busy || nothing} className={`${PRIMARY_BUTTON} ${FOOT_BTN}`}>
              {member ? 'Apply to included' : 'Apply to expenses'}
            </Button>
          </div>
        }
      >
        <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
          {member ? (
            <SelectField label="Member">
              <select aria-label="Bulk member" value={bulkMember} onChange={(e) => setBulkMember(e.target.value)}>
                <option value="">No member</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </SelectField>
          ) : (
            <SelectField label="Category">
              <select aria-label="Bulk category" value={bulkCategory} onChange={(e) => setBulkCategory(e.target.value)}>
                <CategoryOptions groups={expenseGroups} />
              </select>
            </SelectField>
          )}
        </fieldset>
      </Modal>
    )
  }

  // ---- The Bank CSV column mapping: the first rows as read, the four main choices, the rest behind "More options" ----
  function renderColumnsDialog() {
    if (!columnsOpen || !layout || !mapping) return null
    const dateLabel = dateFormatLabel(mapping.dateFormat)
    const split = mapping.debitColumn != null && mapping.creditColumn != null
    // A number column may leave cells empty (a debit column on a money-in row).
    const numeric = layout.columns.map(
      (_, ci) =>
        layout.sampleRows.some((row) => (row[ci] ?? '').trim() !== '') &&
        layout.sampleRows.every((row) => /^\s*(-?[\d.,\s]+)?\s*$/.test(row[ci] ?? '')),
    )
    const columnOptions = layout.columns.map((name, i) => (
      <option key={i} value={i}>
        {name}
      </option>
    ))
    return (
      <Modal
        sheet
        title="Columns"
        onClose={closeColumns}
        hint={MAP_HINT}
        hintLabel="About the column mapping"
        footer={
          <div className="mt-[22px] flex flex-col gap-3 max-[699.98px]:mt-[18px]">
            {mappingDirty && !busy && (
              <p aria-live="polite" className="text-[13px] font-medium text-warn">
                You’ve changed the column mapping. Re-scan to apply it before importing.
              </p>
            )}
            {rescanError && (
              <p role="alert" className="text-[13px] font-medium text-bad">
                {rescanError}
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={closeColumns} disabled={busy} className={FOOT_GHOST}>
                Cancel
              </Button>
              <Button onClick={() => void reScanCsv()} disabled={busy} className={`${PRIMARY_BUTTON} ${FOOT_BTN}`}>
                {busy ? 'Re-scanning…' : mappingDirty ? 'Apply changes & re-scan' : 'Re-scan'}
              </Button>
            </div>
          </div>
        }
      >
        {/* The first few rows exactly as parsed, so the user can see which column is which. */}
        {/* Wider than a phone's sheet, the box scrolls sideways: a keyboard reaches it too (its name is the table's). */}
        {layout.sampleRows.length > 0 && (
          <div
            tabIndex={0}
            role="region"
            aria-labelledby="import-sample-caption"
            className="overflow-x-auto rounded-xl bg-[var(--dlg-field)] px-3.5 py-1 shadow-[inset_0_0_0_1px_var(--color-line)] max-[699.98px]:px-3"
          >
            <table className="w-full border-collapse text-[13px] tabular-nums">
              <caption id="import-sample-caption" className="sr-only">
                Sample of the uploaded file
              </caption>
              <thead>
                <tr>
                  {layout.columns.map((name, i) => (
                    <th
                      key={i}
                      scope="col"
                      className={`py-2 pr-3 pb-[7px] text-xs font-[650] tracking-[0.05em] whitespace-nowrap text-slate-500 uppercase last:pr-0 ${numeric[i] ? 'text-right' : 'text-left'}`}
                    >
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {layout.sampleRows.map((row, ri) => (
                  <tr key={ri}>
                    {layout.columns.map((_, ci) => (
                      <td key={ci} className={`border-t border-line py-2 pr-3 whitespace-nowrap text-slate-500 last:pr-0 ${numeric[ci] ? 'text-right' : 'text-left'}`}>
                        {row[ci] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* The readout of the date format applied, for assistive tech (the Date format field shows it). */}
        {dateLabel && <p className="sr-only">We read your dates as {dateLabel}.</p>}

        <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
          <legend className="sr-only">Column mapping</legend>
          <div className="mt-[18px] grid grid-cols-2 gap-x-4 gap-y-3.5 max-[699.98px]:mt-4 max-[699.98px]:gap-3">
            <SelectField label="Date column">
              <select aria-label="Date column" value={mapping.dateColumn} onChange={(e) => setMapping((m) => (m ? { ...m, dateColumn: Number(e.target.value) } : m))}>
                {columnOptions}
              </select>
            </SelectField>
            <SelectField label="Date format">
              <select
                aria-label="Date format"
                value={mapping.dateFormat ?? ''}
                onChange={(e) => setMapping((m) => (m ? { ...m, dateFormat: e.target.value === '' ? null : e.target.value } : m))}
              >
                {DATE_FORMAT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </SelectField>
            <SelectField label="Description column">
              <select
                aria-label="Description column"
                value={mapping.descriptionColumn}
                onChange={(e) => setMapping((m) => (m ? { ...m, descriptionColumn: Number(e.target.value) } : m))}
              >
                {columnOptions}
              </select>
            </SelectField>
            <SelectField label="Amounts">
              <select
                aria-label="Amounts"
                value={split ? 'split' : 'one'}
                onChange={(e) =>
                  setMapping((m) => {
                    if (!m) return m
                    if (e.target.value === 'one') return { ...m, debitColumn: null, creditColumn: null }
                    // Start from the amount column and the one after it; the user corrects either.
                    const credit = m.amountColumn + 1 < layout.columns.length ? m.amountColumn + 1 : Math.max(0, m.amountColumn - 1)
                    return { ...m, debitColumn: m.amountColumn, creditColumn: credit }
                  })
                }
              >
                <option value="one">One column</option>
                <option value="split">Debit and credit</option>
              </select>
            </SelectField>
            {split ? (
              <>
                <SelectField label="Debit column">
                  <select
                    aria-label="Debit column"
                    value={mapping.debitColumn ?? 0}
                    onChange={(e) => setMapping((m) => (m ? { ...m, debitColumn: Number(e.target.value) } : m))}
                  >
                    {columnOptions}
                  </select>
                </SelectField>
                <SelectField label="Credit column">
                  <select
                    aria-label="Credit column"
                    value={mapping.creditColumn ?? 0}
                    onChange={(e) => setMapping((m) => (m ? { ...m, creditColumn: Number(e.target.value) } : m))}
                  >
                    {columnOptions}
                  </select>
                </SelectField>
              </>
            ) : (
              <SelectField label="Amount column" hint="Signed: money out is negative." hintLabel="About the amount column">
                <select aria-label="Amount column" value={mapping.amountColumn} onChange={(e) => setMapping((m) => (m ? { ...m, amountColumn: Number(e.target.value) } : m))}>
                  {columnOptions}
                </select>
              </SelectField>
            )}
          </div>
          {/* The four that are almost never changed, behind one quiet row (closed). */}
          <details className="group/more mt-4 border-t border-line max-[699.98px]:mt-3.5">
            <summary className="flex h-11 cursor-pointer list-none items-center gap-2 rounded-lg text-sm font-semibold text-slate-500 transition hover:text-slate-900 [&::-webkit-details-marker]:hidden">
              More options
              <ChevronDown aria-hidden strokeWidth={2} className="size-4 transition group-open/more:rotate-180" />
            </summary>
            <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-3.5 max-[699.98px]:gap-3">
              <SelectField label="Currency column">
                <select
                  aria-label="Currency column"
                  value={mapping.currencyColumn ?? ''}
                  onChange={(e) => setMapping((m) => (m ? { ...m, currencyColumn: e.target.value === '' ? null : Number(e.target.value) } : m))}
                >
                  <option value="">Use {fallbackCurrency} for every row</option>
                  {columnOptions}
                </select>
              </SelectField>
              <SelectField label="Number format">
                <select
                  aria-label="Number format"
                  value={mapping.decimalStyle}
                  onChange={(e) => setMapping((m) => (m ? { ...m, decimalStyle: Number(e.target.value) as CsvDecimalStyle } : m))}
                >
                  <option value={0}>Auto-detect</option>
                  <option value={1}>1,234.56</option>
                  <option value={2}>1.234,56</option>
                </select>
              </SelectField>
              <SelectField label="Column separator">
                <select aria-label="Column separator" value={mapping.delimiter} onChange={(e) => setMapping((m) => (m ? { ...m, delimiter: e.target.value } : m))}>
                  <option value=",">Comma ,</option>
                  <option value=";">Semicolon ;</option>
                  <option value={'\t'}>Tab</option>
                  <option value="|">Pipe |</option>
                </select>
              </SelectField>
              <label className="dlg-check flex h-10 cursor-pointer items-center gap-2.5 self-end text-sm font-medium text-slate-900 max-[699.98px]:h-11">
                <input type="checkbox" checked={mapping.hasHeader} onChange={(e) => setMapping((m) => (m ? { ...m, hasHeader: e.target.checked } : m))} />
                First row is a header
              </label>
            </div>
          </details>
        </fieldset>
      </Modal>
    )
  }

  // ---- The done card's figures --------------------------------------------------------------
  function renderDone() {
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
      groups.length === 0 ? formatMoney(0, budgetCurrency) : groups.map((g) => formatMoney(g.minor, g.currency)).join(' + ')
    const n = total.awaitingAmount
    return (
      <section
        aria-labelledby="import-result-heading"
        className={`${DASH_CARD} grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-[22px] [grid-template-areas:'hd_btn'_'st_st'] max-[699.98px]:grid-cols-1 max-[699.98px]:gap-[18px] max-[699.98px]:[grid-template-areas:'hd'_'st'_'btn']`}
      >
        <div className="flex items-center gap-3.5 [grid-area:hd]">
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-cat-emerald)_14%,var(--color-card))] text-[var(--color-cat-emerald)] shadow-[0_0_0_6px_color-mix(in_srgb,var(--color-cat-emerald)_6%,transparent)]">
            <Check aria-hidden strokeWidth={2.2} className="size-[22px]" />
          </span>
          <div className="min-w-0">
            <h2 ref={stepHeading} tabIndex={-1} id="import-result-heading" className="text-lg font-bold tracking-[-0.015em] text-slate-900">
              Import complete
            </h2>
            {/* The one-line summary, for assistive tech and the journeys (the stats say it on screen). */}
            <p className="sr-only">
              {total.imported} transaction{total.imported === 1 ? '' : 's'} added
              {total.skipped > 0 && `, ${total.skipped} skipped`}.
            </p>
          </div>
        </div>
        <dl className="grid grid-cols-5 gap-4 border-t border-line pt-[18px] [grid-area:st] max-[699.98px]:grid-cols-3 max-[699.98px]:gap-x-3 max-[699.98px]:gap-y-4 max-[699.98px]:pt-4">
          <Stat label="Imported" value={total.imported} />
          {total.skipped > 0 && <Stat label="Skipped" value={total.skipped} />}
          <Stat label="Money in" value={money(moneyIn)} tone="ok" />
          <Stat label="Money out" value={money(moneyOut)} />
          <Stat label="Transfers" value={total.transfers} />
          {total.matched > 0 && <Stat label="Matched" value={total.matched} />}
          {total.pendingReview > 0 && <Stat label="Pending review" value={total.pendingReview} />}
          {total.returned > 0 && <Stat label="Returned" value={total.returned} />}
          {heldEverCount > 0 && <Stat label="Held" value={heldEverCount} />}
          {n > 0 && (
            <Stat
              label={`Waiting for ${budgetCurrency} amount`}
              value={n}
              hintLabel="About the rows waiting for an amount"
              hint={`${n} ${n === 1 ? 'row is' : 'rows are'} in another currency and ${n === 1 ? 'is' : 'are'} not counted anywhere until ${n === 1 ? 'its' : 'their'} amount in ${budgetCurrency} is entered on Transactions.`}
            />
          )}
        </dl>
        <div className="flex justify-end [grid-area:btn]">
          <Button onClick={reset} className={`${PRIMARY_BUTTON} h-10! px-[18px]! max-[699.98px]:h-11! max-[699.98px]:w-full`}>
            <ImportIcon className="size-4" />
            Import another file
          </Button>
        </div>
      </section>
    )
  }

  const heldCount = heldResult?.held?.length ?? 0
  const heldRest = heldResult
    ? `The rest went in: ${heldResult.imported} transaction${heldResult.imported === 1 ? '' : 's'} imported${
        heldResult.skippedDuplicates > 0 ? `, ${heldResult.skippedDuplicates} skipped` : ''
      }${heldResult.transfers > 0 ? `, ${heldResult.transfers} transfer${heldResult.transfers === 1 ? '' : 's'}` : ''}.`
    : ''
  const formatHint = `${FORMATS[format].hint} ${DUPES}`
  const detected = format === 'generic' && preview?.detectedFormat ? DETECTED_FORMAT_LABELS[preview.detectedFormat] : undefined
  const FileIcon = format === 'camt' ? FileCode : FileSpreadsheet

  return (
    <AppShell active="import" title="Import transactions" actions={desktop ? importButton : undefined}>
      {error && (
        <div ref={errorRef}>
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}

      {!canWrite && (
        <section aria-label="Import" className={`${DASH_CARD} text-sm text-slate-500`}>
          Importing statements is available to admins and the household owner. You can still add transactions by hand on the{' '}
          <Link to="/transactions" className="font-semibold text-brand-700 hover:underline dark:text-brand-200">
            Transactions
          </Link>{' '}
          page.
        </section>
      )}

      {/* Step 1: one calm card in the wide column: the drop zone is the file chooser, the format sits inside it. */}
      {canWrite && phase === 'upload' && (
        <div className="@container">
          <div className="grid grid-cols-1 items-start gap-4 min-[700px]:gap-6 @min-[940px]:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
            <section aria-labelledby="import-form-heading" className={DASH_CARD}>
              <h2 ref={stepHeading} tabIndex={-1} id="import-form-heading" className="sr-only">
                Upload a statement
              </h2>
              <form onSubmit={onPreview} className="dlg-scope">
                <div
                  data-drop-zone=""
                  className="relative flex min-h-[236px] flex-col items-center justify-center gap-1 rounded-[14px] border-[1.5px] border-dashed border-[color-mix(in_srgb,var(--color-slate-400)_50%,transparent)] bg-[color-mix(in_srgb,var(--color-brand-600)_3%,var(--color-surface-2))] px-6 pt-7 pb-6 text-center transition focus-within:border-ring has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring hover:border-[color-mix(in_srgb,var(--color-brand-600)_60%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-brand-600)_6%,var(--color-surface-2))] max-[699.98px]:min-h-0 max-[699.98px]:px-3.5 max-[699.98px]:pt-[26px] max-[699.98px]:pb-5 dark:bg-[color-mix(in_srgb,var(--color-brand-600)_5%,var(--color-card))]"
                >
                  {/* The input covers the zone: a click opens the chooser and a dropped file lands in it. */}
                  <input
                    // Remount on format change so the browser clears the previously-chosen filename —
                    // otherwise the input still shows a file that setFile(null) has already dropped,
                    // leaving the submit button dead with no explanation.
                    key={format}
                    id="import-file"
                    type="file"
                    // Named by its visible words too (2.5.3), so "click Choose a file" finds it.
                    aria-label={`Statement file: ${file ? 'choose a different file' : 'choose a file or drop it here'}`}
                    accept={FORMATS[format].accept}
                    disabled={busy}
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    className="absolute inset-0 z-0 size-full cursor-pointer rounded-[inherit] opacity-0 focus-visible:outline-none disabled:cursor-default"
                  />
                  <span
                    aria-hidden
                    className="pointer-events-none mb-3 grid size-14 place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-cat-emerald)_14%,var(--color-card))] text-[var(--color-cat-emerald)] shadow-[0_0_0_7px_color-mix(in_srgb,var(--color-cat-emerald)_6%,transparent)] max-[699.98px]:mb-2.5 max-[699.98px]:size-[52px]"
                  >
                    {file ? <FileIcon strokeWidth={2} className="size-6" /> : <ImportIcon className="size-6" />}
                  </span>
                  <b aria-hidden className="pointer-events-none max-w-full truncate text-base font-[650] tracking-[-0.01em] text-slate-900">
                    {file ? file.name : 'Choose a file'}
                  </b>
                  <span aria-hidden className={`pointer-events-none text-sm text-slate-500 ${file ? '' : 'max-[699.98px]:hidden'}`}>
                    {file ? 'Choose a different file' : 'or drop it here'}
                  </span>
                  {/* The format: a small pill select on the zone's axis, its label to the left and its help (i) to the right. */}
                  <div className="relative z-10 mt-[18px] flex justify-center">
                    <span className="relative inline-flex items-center max-[699.98px]:flex max-[699.98px]:w-full max-[699.98px]:flex-wrap max-[699.98px]:items-center max-[699.98px]:justify-center max-[699.98px]:gap-x-0.5 max-[699.98px]:gap-y-1.5">
                      <label
                        htmlFor="import-format"
                        className="absolute top-1/2 right-[calc(100%+10px)] -translate-y-1/2 cursor-pointer text-[13px] font-semibold whitespace-nowrap text-slate-500 max-[699.98px]:static max-[699.98px]:translate-y-0"
                      >
                        File format
                      </label>
                      <span className="dlg-sel flex max-[699.98px]:order-3 max-[699.98px]:flex max-[699.98px]:basis-full max-[699.98px]:justify-center [&_select]:h-9 [&_select]:w-auto [&_select]:rounded-full [&_select]:bg-card [&_select]:pr-8 [&_select]:pl-3.5 [&_select]:text-[13px] [&_select]:font-semibold [&_select]:shadow-[inset_0_0_0_1px_var(--dlg-edge),var(--shadow-frame)] max-[699.98px]:[&_select]:h-10 max-[699.98px]:[&_select]:pr-[34px] max-[699.98px]:[&_select]:pl-4 max-[699.98px]:[&_select]:text-base [&_svg]:right-[11px] [&_svg]:size-3.5 [&_svg]:-mt-[7px]">
                        <select
                          id="import-format"
                          value={format}
                          disabled={busy}
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
                        </select>
                        <ChevronDown aria-hidden strokeWidth={1.8} />
                      </span>
                      {/* No translate on this span: a `translate` would make it the containing block of the (i)'s fixed popover. */}
                      <span className="absolute inset-y-0 left-[calc(100%+4px)] flex items-center max-[699.98px]:static">
                        <InfoHint fixed label="About file formats" buttonClassName={ROW_HINT} align="center">
                          {formatHint}
                        </InfoHint>
                      </span>
                    </span>
                  </div>
                </div>

                {/* The account and the button share one row under the zone. */}
                <div className="mt-[22px] flex items-end gap-4 max-[699.98px]:mt-[18px] max-[699.98px]:flex-col max-[699.98px]:items-stretch max-[699.98px]:gap-[18px]">
                  <div className="flex min-w-0 flex-1 flex-col gap-[7px]">
                    <span className={FIELD_LABEL}>
                      <label htmlFor="import-account">Add to account</label>
                      <InfoHint fixed label="About the account" buttonClassName={LINE_HINT}>
                        {ACCOUNT_HINT}
                      </InfoHint>
                    </span>
                    <span className="dlg-sel block [&_select]:h-11 [&_select]:bg-surface-2 [&_select]:font-medium max-[699.98px]:[&_select]:text-base dark:[&_select]:bg-background">
                      <select id="import-account" value={accountId} disabled={busy} onChange={(e) => setAccountId(e.target.value)}>
                        <option value="">Don't link to an account</option>
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown aria-hidden strokeWidth={1.8} />
                    </span>
                  </div>
                  <Button type="submit" disabled={!file || busy} className={`${PRIMARY_BUTTON} h-11! px-5! max-[699.98px]:w-full`}>
                    {busy ? 'Reading…' : 'Review transactions'}
                  </Button>
                </div>
              </form>
            </section>
          </div>
        </div>
      )}

      {/* Everything in the file was already imported — a success, not an empty grid to puzzle over. */}
      {canWrite && phase === 'review' && preview && rows.length === 0 && (
        <div className="@container">
          <div className="grid grid-cols-1 items-start gap-4 min-[700px]:gap-6 @min-[940px]:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
            <section
              aria-labelledby="import-caughtup-heading"
              className={`${DASH_CARD} grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-[18px] max-[699.98px]:grid-cols-1`}
            >
              <div className="flex items-center gap-3.5">
                <span className="grid size-11 shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-cat-emerald)_14%,var(--color-card))] text-[var(--color-cat-emerald)] shadow-[0_0_0_6px_color-mix(in_srgb,var(--color-cat-emerald)_6%,transparent)]">
                  <Check aria-hidden strokeWidth={2.2} className="size-[22px]" />
                </span>
                <div className="min-w-0">
                  <h2 ref={stepHeading} tabIndex={-1} id="import-caughtup-heading" className="text-lg font-bold tracking-[-0.015em] text-slate-900">
                    You’re all caught up
                  </h2>
                  <p className="mt-0.5 text-[13px] text-slate-500">
                    Every transaction in this file is already in AllotJar
                    {preview.skippedDuplicates > 0 ? ` — all ${preview.skippedDuplicates} were skipped as duplicates.` : '.'} Nothing new to import.
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-end gap-4 max-[699.98px]:flex-col-reverse max-[699.98px]:items-stretch max-[699.98px]:gap-3">
                <Link
                  to="/transactions"
                  className="inline-flex h-10 items-center justify-center gap-1 rounded-[10px] px-2 text-sm font-semibold text-brand-700 hover:underline max-[699.98px]:h-11 dark:text-brand-200"
                >
                  View transactions →
                </Link>
                <Button onClick={reset} className={`${PRIMARY_BUTTON} h-10! px-[18px]! max-[699.98px]:h-11! max-[699.98px]:w-full`}>
                  <ImportIcon className="size-4" />
                  Import another file
                </Button>
              </div>
            </section>
          </div>
        </div>
      )}

      {reviewing && (
        <>
          {/* The file strip: what was read and where it goes. */}
          <section
            aria-label="Statement file"
            className={`${DASH_CARD} flex items-center gap-3.5 px-4 py-4 pl-6 max-[699.98px]:gap-3 max-[699.98px]:py-3 max-[699.98px]:pr-2 max-[699.98px]:pl-4`}
          >
            <span
              aria-hidden
              className="grid size-10 shrink-0 place-items-center rounded-[11px] bg-[color-mix(in_srgb,var(--color-cat-indigo)_13%,var(--color-card))] text-[var(--color-cat-indigo)] max-[699.98px]:size-9 max-[699.98px]:rounded-[10px]"
            >
              <FileIcon strokeWidth={1.8} className="size-5" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <b className="truncate text-sm font-semibold text-slate-900">{file?.name}</b>
              <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-slate-500">
                <span className="shrink-0">{FORMAT_SHORT[format]}</span>
                {detected && (
                  <InfoHint fixed label="About the format" buttonClassName={ROW_HINT}>
                    We recognised this file as {detected} and read it with the dedicated importer, so payees and duplicate detection stay consistent.
                  </InfoHint>
                )}
                <span aria-hidden className="text-slate-400">
                  ·
                </span>
                {importAccount ? (
                  <>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <AccountTypeGlyph type={importAccount.type} className="size-3.5 shrink-0 text-slate-400" />
                      <span aria-hidden className="truncate">
                        {importAccount.name}
                      </span>
                      <span className="sr-only">Importing into {importAccount.name}.</span>
                    </span>
                    {importBacksJars && (
                      <InfoHint fixed label={`About ${importAccount.name}`} buttonClassName={ROW_HINT}>
                        {importAccount.name} holds jars: say which jars incoming money goes into and which jar a payment comes from. Leave them as they
                        are to keep the money unallocated.
                      </InfoHint>
                    )}
                  </>
                ) : (
                  <>
                    <span className="truncate">No account</span>
                    {!heldMode && rows.some((r) => r.likelyTransfer) && (
                      <InfoHint fixed label="About the account" buttonClassName={`${LINE_HINT} text-warn`}>
                        {NO_ACCOUNT_HINT}
                      </InfoHint>
                    )}
                  </>
                )}
              </span>
            </div>
            {/* The Bank CSV column mapping. Hidden once rows are held: a re-scan would bring back the rows already imported. */}
            {!heldMode && format === 'generic' && layout && mapping && (
              <Button variant="secondary" onClick={() => setColumnsOpen(true)} disabled={busy} className={OUTLINE_SM}>
                <Columns3 aria-hidden strokeWidth={1.8} className="size-4 text-slate-500" />
                <span className="max-[699.98px]:sr-only">Columns</span>
              </Button>
            )}
            <button
              type="button"
              onClick={reset}
              disabled={busy}
              aria-label="Choose a different file"
              className="grid size-10 shrink-0 place-items-center rounded-full text-slate-500 transition hover:bg-surface-2 hover:text-slate-900 disabled:opacity-50 dark:hover:bg-foreground/7"
            >
              <X aria-hidden strokeWidth={1.8} className="size-5" />
            </button>
          </section>

          {/* Rule 74: the last commit held these rows because the account would go below zero on
              their date. Nothing is posted "anyway" — the user records the missing money (or
              changes the row) and commits again, or unticks a row to discard it. */}
          {heldResult && (
            <div
              data-strip="held"
              className="flex min-h-11 items-center gap-2.5 rounded-[10px] bg-bad-bg py-1.5 pr-1.5 pl-3.5 text-sm font-semibold text-bad shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-bad)_16%,transparent)] max-[699.98px]:pl-3 max-[699.98px]:text-[13px]"
            >
              <TriangleAlert aria-hidden strokeWidth={2} className="size-4 shrink-0" />
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span role="status" className="min-w-0">
                  {heldCount} row{heldCount === 1 ? ' was' : 's were'} held because the account would go below zero on {heldCount === 1 ? 'its' : 'their'}{' '}
                  date.
                  {/* The (i)'s two sentences, announced with the count (today's banner read all three). */}
                  <span className="sr-only">
                    {' '}
                    {HELD_HINT} {heldRest}
                  </span>
                </span>
                <InfoHint fixed label="About the held rows" buttonClassName={LINE_HINT}>
                  <span className="mb-1.5 block">{HELD_HINT}</span>
                  <span className="block">{heldRest}</span>
                </InfoHint>
              </span>
            </div>
          )}

          {/* One list card in the Transactions row style: the bar, then the rows. */}
          <section
            aria-label="Transactions to import"
            className={`dash-palette ${DASH_CARD} pt-3.5 pb-2.5 max-[699.98px]:px-4 max-[699.98px]:pt-2.5 max-[699.98px]:pb-1.5`}
          >
            <h2 ref={stepHeading} tabIndex={-1} className="sr-only">
              {heldMode ? 'Held rows' : `${preview.newCount} new transaction${preview.newCount === 1 ? '' : 's'} to review`}
            </h2>
            {/* The rows are what Import sends: they hold still while it is out, so an answer can't be
                given to a row that is already on its way (and lost when the server takes it). */}
            <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
              <div className="flex min-h-12 items-center gap-3 border-b border-line pb-2.5 max-[699.98px]:min-h-[52px] max-[699.98px]:gap-2.5">
                <label className={CHECK_WRAP}>
                  <input ref={allBox} type="checkbox" aria-label="Include all rows" checked={allIncluded} onChange={(e) => setAllIncluded(e.target.checked)} />
                </label>
                {(preview.skippedDuplicates > 0 || flaggedNotes.length > 0) && !heldMode && (
                  <div className="flex min-w-0 items-center gap-1.5">
                    <StatusChip tone="line" className={GIVES_WAY}>
                      <Check aria-hidden strokeWidth={2.2} />
                      <span className="min-w-0 truncate">
                        {preview.skippedDuplicates > 0
                          ? `${preview.skippedDuplicates} already imported`
                          : `${possibleDuplicateCount + reusedReferenceCount} unticked`}
                      </span>
                    </StatusChip>
                    <InfoHint fixed label="About skipped rows" buttonClassName={ROW_HINT}>
                      <span className="block">{SUMMARY_HINT}</span>
                      {flaggedNotes.length > 0 && <span className="mt-1.5 block">{flaggedNotes.join(' and ')} (tick to include).</span>}
                    </InfoHint>
                  </div>
                )}
                <span className="flex-1" />
                <RowMenu
                  label="Bulk actions"
                  actions={[
                    {
                      key: 'bulk-member',
                      label: 'Member for included rows',
                      icon: <Users aria-hidden />,
                      disabled: members.length === 0,
                      after: 'dialog',
                      onSelect: () => setBulkOpen('member'),
                    },
                    {
                      key: 'bulk-category',
                      label: 'Category for included expenses',
                      icon: <ReceiptText aria-hidden />,
                      disabled: expenseGroups.length === 0,
                      after: 'dialog',
                      onSelect: () => setBulkOpen('category'),
                    },
                  ]}
                />
              </div>
              <ul>{rows.map((r, index) => renderRow(r, index))}</ul>
            </fieldset>
            {/* Each unfinished row names its own reason; the rules sit behind the (i). */}
            {reviewIncomplete && (
              <p aria-live="polite" className="flex items-center gap-1 border-t border-line pt-2.5 text-[13px] font-medium text-bad">
                Finish the highlighted rows first.
                <InfoHint fixed label="What the highlighted rows need" buttonClassName={`${LINE_HINT} text-bad`}>
                  {INCOMPLETE_HINT}
                </InfoHint>
              </p>
            )}
          </section>

          {/* The page action on a phone: pinned above the tab bar (a real statement has 50+ rows). */}
          {!desktop && (
            <>
              <div aria-hidden className="h-10" />
              <div
                data-import-dock=""
                data-dock=""
                className="fixed inset-x-0 bottom-[var(--tabbar-h)] z-[19] border-t border-slate-200 bg-[color-mix(in_srgb,var(--color-card)_94%,transparent)] px-4 py-2.5 backdrop-blur-[12px]"
              >
                {importButton}
              </div>
            </>
          )}

          {renderColumnsDialog()}
          {renderTransferDialog()}
          {renderSplitDialog()}
          {renderMemberDialog()}
          {renderJarDialog()}
          {renderBulkDialog()}

          {/* Cross-month confirm: categorised rows dated outside the loaded budget month get
              budgeted to this month's lines — a deliberate choice, confirmed once per batch. */}
          {crossMonthAsk !== null && (
            <Modal
              sheet
              title="Budget to a different month?"
              onClose={() => setCrossMonthAsk(null)}
              footer={
                <div className="mt-[22px] flex justify-end gap-2 max-[699.98px]:mt-[18px]">
                  <Button variant="ghost" onClick={() => setCrossMonthAsk(null)} className={FOOT_GHOST}>
                    Go back
                  </Button>
                  <Button onClick={() => onCommit(true, !!crossMonthAsk.message)} disabled={busy} className={`${PRIMARY_BUTTON} ${FOOT_BTN}`}>
                    Import anyway
                  </Button>
                </div>
              }
            >
              {crossMonthAsk.message ? (
                <p className="text-sm text-slate-500">
                  {crossMonthAsk.message} Importing will count it toward that line{'’'}s month rather than the month it was spent.
                </p>
              ) : (
                <p className="text-sm text-slate-500">
                  {crossMonthAsk.count} transaction{crossMonthAsk.count === 1 ? ' is' : 's are'} dated outside{' '}
                  {month ? monthYear(`${month.year}-${String(month.month).padStart(2, '0')}-01`) : 'this month'} but assigned to its budget lines.
                  Importing will count {crossMonthAsk.count === 1 ? 'it' : 'them'} toward{' '}
                  {month ? monthYear(`${month.year}-${String(month.month).padStart(2, '0')}-01`) : 'this month'}
                  {'’'}s budget rather than the month {crossMonthAsk.count === 1 ? 'it was' : 'they were'} spent.
                </p>
              )}
            </Modal>
          )}
        </>
      )}

      {canWrite && phase === 'done' && results.length > 0 && (
        <div className="@container">
          <div className="grid grid-cols-1 items-start gap-4 min-[700px]:gap-6 @min-[940px]:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">{renderDone()}</div>
        </div>
      )}
    </AppShell>
  )
}

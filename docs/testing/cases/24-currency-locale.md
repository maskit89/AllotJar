# Currency & Locale Matrix

**ID prefix:** CURR | **Scope:** The cross-feature currency + number-format surface of AllotJar as a test matrix: the 24-currency sign-up/preferences shortlist (plus any ISO 4217 code reachable via API/import) and the 5 number-format presets, how each renders decimals, symbol and symbol-position in **every** money display (dashboard budget lines, transactions, transfers, jars, allocation, accounts, reconciliation, reports, import sums, hero labels), how a **number-format** change ripples app-wide, the household's **one budget currency** (W08, rules 42–44/85: the earliest month's `BaseCurrency`, else the owner's `preferredCurrency`, else EUR; fixed once the household holds an account, month or transaction; **no FX conversion, ever**) and the surfaces that label money with it, legacy accounts kept in another currency (left out of totals, cross-currency transfer guard, no manual entries on them, their rows keeping the account's amount and counting a confirmed budget figure beside it — "Support them"), money recorded in another currency (the "Needs {X} amount" waiting rows, suggested ECB conversions the user confirms, the add form's paid-abroad figure), the `ForeignAmounts` data migration ("Keep counting" / "Support them", and its stop on a household with months in two currencies), and locale-formatted amounts in imports. | **Out of scope:** area-level mechanics owned by sibling files — sign-up form/consent (`19-*` / register), account CRUD + reconciliation (`12-accounts-reconciliation.md`), transfer mechanics (`11-transfers.md`), transaction entry/parsing (`10-transactions.md`), import parser detail (`15-import.md`), allocation math (`14-allocation.md`), jar accrual (`13-jars.md`), reports (`18-reports.md`), month lifecycle (`23-time-date-lifecycle.md`). Reference those by ID; this file only exercises the **cross-feature currency/locale behaviour they cannot see**.

**Test data setup:** Unless a case says otherwise, assume a staging build. Shared fixtures:
- **U-EUR**: solo owner, preferredCurrency `EUR`, numberFormat `comma-dot` (en-GB, the app default), one EUR account "Joint" (balance 1,250.00), a current EUR-based budget month with a Rent line planned 1,100.00.
- **U-USD**: solo owner registered with preferredCurrency `USD`, numberFormat `comma-dot`.
- **U-DE**: solo owner, preferredCurrency `EUR`, numberFormat `dot-comma` (de-DE).
- **H-MIX**: shared household (budget currency EUR), 2 members, two accounts — "Joint" EUR (1,250.00) and **legacy** "UK Savings" GBP (800.00) — `multiCurrency` feature flag ON. Since W08 `POST /accounts` refuses any currency but the budget currency, so the GBP account must be seeded directly in the database (or kept from before the `ForeignAmounts` migration).
- Money is integer minor units at SCALE 4 client-side / `decimal(18,4)` server-side; actuals are always transaction-derived at read time. There is **no exchange rate** anywhere (W08 removed `ExchangeRate`/`BaseAmount`). Every month's `BaseCurrency` and every manual transaction's currency is the household's **budget currency** (`BudgetCurrency.ResolveAsync`); an import row in another currency is stored as it is, marked `fxPending` ("Needs {X} amount") and counts nowhere until the user confirms its budget-currency amount (`PUT /transactions/{id}/converted-amount`). Suggested amounts come from the ECB reference rate (Frankfurter) and are only ever suggestions.

---

## A. Sign-up currency & number-format defaults

### CURR-001 - Browser locale pre-fills currency + number format at sign-up
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Anonymous visitor; browser `navigator.language` = `de-DE`.
- **Steps:**
  1. Open `/login?register=1`.
  2. Inspect the **Currency** (`#currency`) and **Number format** (`#numberFormat`) selects before touching them.
- **Expected:** `detectLocaleDefaults()` pre-selects Currency = **Euro (€)** (region DE → EUR) and Number format = **1.234,56** (dot-comma). Both remain fully editable. The footer tagline reads "Give every **euro** a job." (see CURR-003 for its independence).
- **Automated:** Partial (client/src/lib/money.test.ts — `detectLocaleDefaults` returns a supported currency + known format key)

### CURR-002 - Unrecognised region falls back to the euro soul (EUR + comma-dot)
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Anonymous visitor; browser locale is an unmapped region (e.g. `en-KE`) or `navigator.language` is unavailable (SSR).
- **Steps:**
  1. Open `/login?register=1`.
- **Expected:** Currency defaults to **Euro (€)** (`DEFAULT_CURRENCY_CODE`) and Number format to **1,234.56** (`DEFAULT_FORMAT_KEY` comma-dot); tagline "Give every **euro** a job." The front door greets in euros when detection can't place the visitor.
- **Automated:** Partial (client/src/lib/money.test.ts)

### CURR-003 - Tagline noun tracks the DETECTED locale, not the live currency dropdown
- **Priority:** P2
- **Type:** Regression
- **Origin:** money.ts — `LoginPage` renders `Give every {currencyNoun(localeDefaults.currency)}` from the **once-computed** `localeDefaults`, not the live `currency` state.
- **Preconditions:** Anonymous visitor, detected currency EUR.
- **Steps:**
  1. Open `/login?register=1` (tagline shows "Give every euro a job.").
  2. Change the **Currency** select to **Japanese yen (¥)**.
- **Expected:** The dropdown value changes to JPY, but the footer tagline **stays** "Give every euro a job." (the noun is bound to the detected locale, computed once, not to the picker). No re-render of the tagline noun.
- **Automated:** No

### CURR-004 - Every currency in the 24-code shortlist is offered and persists
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Anonymous visitor.
- **Steps:**
  1. Open `/login?register=1`; open the **Currency** select.
  2. Confirm the option list, then register picking **US dollar ($)**.
  3. After landing, open `/account` → **Preferences** and read the Currency value.
- **Expected:** The select lists exactly the 24 `CURRENCY_OPTIONS` (EUR, GBP, USD, CHF, CAD, AUD, NZD, JPY, INR, SGD, HKD, SEK, NOK, DKK, PLN, CZK, HUF, RON, ZAR, BRL, MXN, AED, SAR, TRY) with symbol-bearing labels. Registration stores `preferredCurrency = USD`; `/account` Preferences shows **US dollar ($)**; `zbb.currency=USD` in localStorage.
- **Automated:** No

### CURR-005 - All five number-format presets are selectable and persist
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Anonymous visitor.
- **Steps:**
  1. Open `/login?register=1`; open **Number format**.
  2. Register choosing **1 234,56** (space-comma).
  3. Open `/account` → Preferences and read Number format.
- **Expected:** The select offers exactly 5 worked-example labels: **1,234.56**, **1.234,56**, **1 234,56**, **1'234.56**, **1,23,456.78** (comma-dot / dot-comma / space-comma / apostrophe / lakh). Stored `numberFormat = space-comma`; `zbb.numberFormat=space-comma` in localStorage.
- **Automated:** Partial (client/src/lib/money.test.ts — `NUMBER_FORMAT_OPTIONS` values; `setMoneyFormat` renders each style)

### CURR-006 - API accepts any valid ISO 4217 code; rejects a non-3-letter code
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** None (direct API).
- **Steps:**
  1. `POST /auth/register` with `preferredCurrency: "KWD"` (off the shortlist but valid ISO), valid format, `acceptedTerms: true`.
  2. Repeat with `preferredCurrency: "EU"` (2 letters) and `"E1R"` (digit).
- **Expected:** Step 1 succeeds — `NormalizeCurrency` accepts any `^[A-Z]{3}$` code (uppercased); the account stores `KWD` even though the UI picker never offers it. Steps 2 both 400 with `{"error":"That isn't a valid ISO 4217 currency code."}`. No user is created for the rejected cases.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Domain/CurrencyCodeTests.cs — `CurrencyCode.From` validation)

### CURR-007 - API rejects an unsupported number-format key
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** None (direct API).
- **Steps:**
  1. `POST /auth/register` with `numberFormat: "swiss"`, valid currency, `acceptedTerms: true`.
- **Expected:** 400 `{"error":"That number format isn't supported."}` (`NormalizeNumberFormat` only accepts comma-dot/dot-comma/space-comma/apostrophe/lakh). No user created. Same rule guards `PUT /auth/preferences`.
- **Automated:** No

### CURR-008 - The locale guess is fully overridable end to end
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Anonymous visitor, browser `de-DE` (guess = EUR + dot-comma).
- **Steps:**
  1. Open `/login?register=1`; override Currency → **Japanese yen (¥)**, Number format → **1,23,456.78** (lakh).
  2. Complete registration; open `/account` Preferences.
- **Expected:** Stored `preferredCurrency=JPY`, `numberFormat=lakh` — the pre-fill never sticks over an explicit choice. Jars/Allocation heroes now render ¥ with lakh grouping (see section C/D).
- **Automated:** No

---

## B. Per-currency decimals, symbol & symbol position

### CURR-009 - Two-decimal currencies render with correct symbol (EUR/USD/GBP)
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** U-EUR (comma-dot) with EUR "Joint", plus **legacy** accounts USD "Travel" (1,100.00) and GBP "UK" (45.50) seeded directly (the app no longer creates accounts in another currency than the budget's — CURR-050).
- **Steps:**
  1. On `/accounts`, read each card's balance.
- **Expected:** EUR "Joint" → `€1,250.00`, USD "Travel" → `$1,100.00`, GBP "UK" → `£45.50` — each formatted in the account's OWN currency at its ISO 2-minor-digit precision. `formatMoney(minor,'EUR')` contains `€` and `1,250.00`; GBP contains `£`. (The hero counts only Joint — CURR-034.)
- **Automated:** Partial (client/src/lib/money.test.ts — formats with budget currency, GBP `£`)

### CURR-010 - Zero-decimal currency (JPY) renders whole units, no decimal point
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** A household whose budget currency is JPY (JPY chosen at sign-up, CURR-008 user); a jar "Trip" balance 1,234.
- **Steps:**
  1. Open `/jars` and read the "Trip" jar balance and the "Total saved" hero.
- **Expected:** JPY uses its ISO minor-unit count of 0 → `¥1,234` (no `.00`). `formatMoney(fromAmount(1234),'JPY')` contains `1,234` and does **not** contain `1,234.0`. No fixed fraction digits are forced by the formatter.
- **Automated:** Partial (client/src/lib/money.test.ts — "uses each currency's natural fraction digits", JPY has no minor unit)

### CURR-011 - Three-decimal currency (KWD/BHD) renders three decimals
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** A household whose budget currency is `KWD` (registered via the off-list API path in CURR-006; the picker never offers it), with a counted transaction of 1,234.567.
- **Steps:**
  1. View the row in the transactions register (`/transactions`).
- **Expected:** `formatMoney(fromAmount(1234.567),'KWD')` renders three decimals — contains `1,234.567`. The Intl formatter honours each currency's own ISO minor-unit count (2/0/3) without the app pinning a digit count. (Contrast: a KWD row **waiting** in another budget currency is shown with `formatForeign` = code + `formatPlain`, which always shows 2 decimals — "KWD 1,234.57" — CURR-049.)
- **Automated:** Partial (client/src/lib/money.test.ts — KWD three decimals)

### CURR-012 - JPY amount entered WITH decimals: stored at scale 4, displayed rounded
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** A household whose budget currency is JPY; a jar/account displayed in JPY.
- **Steps:**
  1. In a JPY-displayed money input, type `1234.56` and save.
  2. Re-read the displayed value.
- **Expected:** `parseMinor` is currency-agnostic → stores `12,345,600` minor units (1234.56 at scale 4); the JPY Intl formatter rounds display to whole yen (`¥1,235`). The stored fraction is **not** lost (integer minor units keep it) — a money-integrity nuance: display precision ≠ stored precision for 0-decimal currencies. No input-level per-currency decimal restriction exists.
- **Automated:** No

### CURR-013 - Symbol POSITION follows the number-format locale, not the currency
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Same EUR figure viewed by U-EUR (comma-dot) and U-DE (dot-comma).
- **Steps:**
  1. As U-EUR, read the Rent line / a EUR hero.
  2. As U-DE, read the same EUR figure.
- **Expected:** comma-dot (en-GB) → **`€1,100.00`** (symbol prefix). dot-comma (de-DE) → **`1.100,00 €`** (symbol suffix). space-comma (fr-FR) → **`1 100,00 €`** (suffix). The €-symbol's side of the number is a property of the format-preset locale, not the currency — changing number format can move the symbol.
- **Automated:** Partial (client/src/lib/money.test.ts — `setMoneyFormat` renders `1.234,56` / `1,234.56` / space grouping)

### CURR-014 - Currency symbol is independent of the chosen number format
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** GBP-preferred user.
- **Steps:**
  1. Switch number format across all five presets in `/account` Preferences.
  2. After each, read a GBP figure and any inline money input's prefix.
- **Expected:** `currencySymbol('GBP')` stays `£` and `currencySymbol('EUR')` stays `€` under every format — the symbol is derived from the currency, the grouping/decimal from the format. Inline editable amount fields draw their own symbol via `currencySymbol` and the grouped value via `formatPlain` (no symbol), so the prefix never changes when only the format does.
- **Automated:** Partial (client/src/lib/money.test.ts — "keeps the currency symbol independent of the chosen number format")

### CURR-015 - Off-list/unknown currency code falls back to showing the code as symbol
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** A household whose budget currency is a code Intl has no symbol glyph for (e.g. `XAF`, registered via the API path in CURR-006), with a counted transaction.
- **Steps:**
  1. View the row in `/transactions`.
- **Expected:** `currencySymbol` returns the ISO code itself when no symbol part is produced (`part?.value ?? currency`), so the amount reads e.g. `XAF 1,234` rather than crashing or showing a blank symbol. Never throws. (A row in such a code waiting in another budget currency always reads "XAF 1,234.00" via `formatForeign`.)
- **Automated:** No

### CURR-016 - Lakh grouping only engages above 100,000 (INR)
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** INR-preferred user, numberFormat lakh; a jar balance 1,234,567.89 and another 999.00.
- **Steps:**
  1. Read both on `/jars`.
- **Expected:** `formatMoney(fromAmount(1234567.89),'INR')` → `12,34,567.89` (lakh/crore grouping). Values under a lakh (e.g. 999.00) group normally. Number format `lakh` maps to `en-IN`.
- **Automated:** Partial (client/src/lib/money.test.ts — "renders lakh grouping, dot-decimal (en-IN)")

---

## C. Number-format ripple across every money surface

### CURR-017 - Changing number format re-renders EVERY money surface at once
- **Priority:** P0
- **Type:** Regression
- **Origin:** `setMoneyFormat` mutates the module-level active locale; `numberFormat` is an auth-context dependency, so consumers re-render app-wide.
- **Preconditions:** U-EUR (comma-dot) with data on every screen (budget lines, a transaction, a transfer, a jar, an allocation preview, an account, a report month, a committed import).
- **Steps:**
  1. Open `/account` → Preferences, change **Number format** from **1,234.56** to **1.234,56** (dot-comma), Save preferences.
  2. Visit `/`, `/transactions`, `/jars`, `/allocation`, `/reports`, `/accounts`, `/import` result.
- **Expected:** On save, "Your preferences have been saved." Every money value across all surfaces switches grouping/decimal style (e.g. `1,100.00` → `1.100,00`, symbol moves to suffix) — dashboard hero + lines, register rows, transfer amounts, jar balances, allocation steps, report bars/table, account cards/hero, import commit sums, and delete/confirm text. Currency **codes/symbols are unchanged**; only formatting changes. No page reload required.
- **Automated:** No

### CURR-018 - Format preference is applied from localStorage before /auth/me returns
- **Priority:** P1
- **Type:** Regression
- **Origin:** AuthContext mount effect calls `setMoneyFormat(numberFormat)` from `zbb.numberFormat` once, so a hard reload renders in the chosen style pre-hydration.
- **Preconditions:** U-DE (dot-comma) already signed in (`zbb.numberFormat=dot-comma` in localStorage).
- **Steps:**
  1. Hard-reload `/` (drops the in-memory access token; session restores via refresh cookie).
  2. Observe the first paint of money values before `/auth/me` resolves.
- **Expected:** First paint already renders `1.100,00`-style (dot-comma) from the persisted key — no flash of the en-GB default. Once `/auth/me` confirms, `applyPrefs` re-applies the same value (idempotent). If localStorage is cleared, first paint uses the app default comma-dot until `/auth/me`.
- **Automated:** No

### CURR-019 - Amount input parsing is format-agnostic (accepts either separator)
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** U-DE (dot-comma display) adding an expense on `/transactions`; also verify as U-EUR.
- **Steps:**
  1. As U-DE, in the Amount field type `1,234.56` (en style) and submit.
  2. Repeat typing `1.234,56` (de style) and `1 234,56` (space) and `1'234.56` (apostrophe).
- **Expected:** All four parse to the SAME `12,345,600` minor units regardless of the user's chosen display format — `parseMinor` strips spaces/apostrophes, then takes the right-most of `.`/`,` as the decimal separator. The display format preference never constrains input. (Area coverage: TX-024, TRF-014, ACCT-015.)
- **Automated:** Yes (client/src/lib/money.test.ts — `parseMinor` `.each` incl. de-DE, en, de-CH, fr-FR, lakh grouped inputs)

### CURR-020 - Editable money fields pre-fill a plain, non-localized decimal
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** U-DE editing an account opening balance / budget line (values stored 1,100.50).
- **Steps:**
  1. Enter inline edit on a field showing `1.100,50`.
- **Expected:** The input pre-fills `1100.5` (`toEditString` — raw dot-decimal, no grouping, trailing zeros trimmed), **not** the localized `1.100,50`. Display uses `formatPlain`/`formatMoney`; editing uses the plain string so a European-format user isn't re-parsing their own grouping. (Area coverage: ACCT-025.)
- **Automated:** Partial (client/src/lib/money.test.ts — `toEditString`)

### CURR-021 - Blank/unknown stored format falls back to comma-dot rendering
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** A user record whose `numberFormat` is empty or a stale/unknown value (e.g. legacy data).
- **Steps:**
  1. Sign in; observe money rendering.
- **Expected:** `setMoneyFormat(null | "not-a-real-format")` resolves to the en-GB default (`1,234.56`). No crash; the app degrades to the neutral default rather than an unstyled number.
- **Automated:** Partial (client/src/lib/money.test.ts — "falls back to the default (en-GB) for an unknown/blank format")

### CURR-022 - Format also drives hero aria-labels and confirm text
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** U-DE with an over-budget month and an account.
- **Steps:**
  1. Inspect the dashboard hero's accessible name (`amountLabel`) and any money-bearing confirm/summary text (e.g. import commit "X imported", jar archive preview).
- **Expected:** Accessible labels use the same `formatMoney`, so a screen reader hears `1.100,00 €` (matching the visual). The format preference is not visual-only — it reaches aria labels and confirmation strings. (Note: the account delete modal shows only the name, no amount — ACCT-033.)
- **Automated:** No

### CURR-023 - Space-comma (fr-FR) uses NBSP grouping + comma decimal
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** User with numberFormat space-comma.
- **Steps:**
  1. Read a figure of 1234.56 on any surface.
- **Expected:** Rendered with a (non-breaking) space group and comma decimal — contains `234,56`, does **not** contain `.234` or `,234` as a group. Assertions must target the meaningful parts (NBSP varies by runtime).
- **Automated:** Partial (client/src/lib/money.test.ts — "renders space-grouping, comma-decimal (fr-FR)")

### CURR-024 - Apostrophe (de-CH) grouping renders 1'234.56
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** User with numberFormat apostrophe.
- **Steps:**
  1. Read a figure of 1234.56.
- **Expected:** Contains `234.56` (dot decimal) with an apostrophe group; not `1,234` and not `1.234`. Maps to `de-CH`. Input still accepts curly `’` and straight `'` (parseMinor strips both).
- **Automated:** Partial (client/src/lib/money.test.ts — apostrophe grouping)

### CURR-025 - Round-half-up beyond 4 dp is currency- and format-independent
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Any user, any format/currency, adding an amount.
- **Steps:**
  1. Enter `12.99999` in an amount field and submit.
- **Expected:** Parsed to `130,000` minor units (13.0000) — half-up on the 5th fractional digit — regardless of chosen currency or number format. Display then applies the currency's own decimals. (Area coverage: TX-025.)
- **Automated:** Yes (client/src/lib/money.test.ts — parses `12.99999` → 130000)

---

## D. One budget currency: source, lock, NO FX

### CURR-026 - Once the household holds anything its currency can't change, so Jars and Allocation are never relabelled
- **Priority:** P0
- **Type:** Regression
- **Origin:** W08 (rules 42/85) — JarsPage/AllocationPage used to format with the LIVE `preferredCurrency`, so a preference change turned €500.00 into $500.00 (an implicit 1:1 conversion). They now use the active household's `budgetCurrency`, and the preference is locked once money is recorded.
- **Preconditions:** U-EUR with a jar "Emergency" balance 500.00 and an allocation preview pool 2,000.00 (so `currencyLocked: true`).
- **Steps:**
  1. `/account` → Preferences: read "Currency".
  2. `PUT /auth/preferences` with `preferredCurrency: "USD"`.
  3. Visit `/jars` and `/allocation`.
- **Expected:** Step 1: a read-only "Euro (€)" with "Your budget currency is fixed once your budget has accounts, months or transactions." Step 2: 400 "Your budget is in EUR and already has accounts, months or transactions, so its currency can't be changed.". Step 3: "Emergency" and "Total saved" read **€500.00**; "Income to allocate" **€2,000.00** — unchanged symbol and number. (PREF-011/PREF-042.)
- **Automated:** Partial (client/src/pages/AccountPage.test.tsx — read-only locked currency; ForeignAmountsTests — `The_budget_currency_is_fixed_once_the_household_holds_anything`)

### CURR-027 - Every surface labels money in the same budget currency (no mixed-symbol app)
- **Priority:** P0
- **Type:** Regression
- **Origin:** Before W08, DashboardPage/ReportsPage used the frozen month currency while Jars/Allocation/Accounts used the live preference, so a USD sign-up saw € on the budget and $ elsewhere. Now months are stamped in the budget currency and the client labels with `budgetCurrency`.
- **Preconditions:** U-USD (preferredCurrency USD) after creating the first month, an account, a jar and a transaction.
- **Steps:**
  1. Visit `/`, `/reports`, `/jars`, `/allocation` (if shared), `/accounts`, `/transactions` and the user chip.
- **Expected:** Every surface reads **$** (the month's `baseCurrency` is USD, CURR-028; `budgetCurrency` is USD): dashboard hero and lines, the "Every dollar has a job" badge, reports, jars, accounts hero and cards, register rows, and the chip "USD · …". No surface shows €.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — `Create_FirstMonth_AdoptsTheUsersPreferredCurrency`; client/src/pages/AccountsPage.catalog.test.tsx — ACCT-018 hero labelled in the budget currency)

### CURR-028 - A USD sign-up's first budget month is USD — the budget currency
- **Priority:** P1
- **Type:** Regression
- **Origin:** `CreateBudgetMonthCommandHandler` used to default the first month to EUR (later, the creating login's preference); since W08 it stamps `BudgetCurrency.ResolveAsync` — the earliest month's `BaseCurrency`, else the **owner's** preference, else EUR. There is no request field or endpoint to set a month's base currency.
- **Preconditions:** U-USD (preferredCurrency USD), no months yet. Variant: a shared household whose owner chose GBP and a member (own preference EUR) creates the first month.
- **Steps:**
  1. Create the first budget month (blank or template) from the dashboard.
  2. Read the dashboard hero currency; `GET /budget/current`.
- **Expected:** `baseCurrency` = **USD**; the dashboard renders in $ like every other surface. Variant: the month is **GBP** (the owner's choice), never the member's EUR.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — `Create_FirstMonth_AdoptsTheUsersPreferredCurrency`; ForeignAmountsTests — `The_budget_currency_is_the_first_months_else_the_owners_choice`)

### CURR-029 - The Accounts hero is labelled in the budget currency and counts only budget-currency accounts
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Budget currency EUR; the household's only account is a **legacy** GBP one (balance 800.00).
- **Steps:**
  1. Open `/accounts`; read the "Total balance" hero, tiles and footnote.
- **Expected:** Hero and tiles read **€0.00** — the GBP account is not counted and never converted — with the pill "1 account in another currency is not counted."; the card itself reads **£800.00**. (Before W08 the hero adopted the single account's currency, £800.00.) (Area coverage: ACCT-005, ACCT-080.)
- **Automated:** Partial (client/src/pages/AccountsPage.catalog.test.tsx — ACCT-005)

### CURR-030 - Transactions register: counted rows in their currency, waiting rows as "{CODE} amount" with a tag
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** H-MIX with a counted EUR row (12.50) and an imported GBP row (12.50, on no account) that is waiting.
- **Steps:**
  1. Open `/transactions`; read the two rows' amounts and the hero.
- **Expected:** The EUR row reads `−€12.50` (`formatMoney` in its own `currency`); the GBP row reads **"GBP 12.50"** (never `£12.50`, so it can't pass for budget money) with **"Needs EUR amount"** and **Enter amount**; Money out is €12.50. After confirming €14.80 the row reads `−€14.80` with a grey "GBP 12.50" caption (title "Paid in GBP"). (Area coverage: TX-103/104, ACCT-048, TRF-027.)
- **Automated:** Yes (client/src/pages/TransactionsPage.test.tsx — "flags a row waiting for its budget-currency amount and leaves it out of the totals", "Enter amount: Suggest fills an editable amount without saving; Confirm saves it")

### CURR-031 - Every new month takes the budget currency — next, copied or backfilled
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** A household whose June month is GBP; the owner's preference reads USD (legacy mismatch, or a member created the months).
- **Steps:**
  1. Create July via "Copy last month"; create May (backfill, blank).
  2. Inspect both months' base currency.
- **Expected:** Both are **GBP** — the earliest month's currency — never the USD preference; the identity service isn't even consulted once a month exists. Existing months in another currency are never restamped (the `ForeignAmounts` migration leaves months alone — and refuses to run at all while a household's months are in more than one currency, CURR-056).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — `Create_AnyMonth_TakesTheBudgetCurrency_NotThePreference` [Theory: next month + backfill])

### CURR-032 - "Leave as is" — a name-only preferences save never resets currency/format
- **Priority:** P1
- **Type:** Regression
- **Origin:** AuthController preferences endpoint: blank `preferredCurrency`/`numberFormat` in the payload means "leave as is" (`string.IsNullOrWhiteSpace(...) ? user.X : request.X`).
- **Preconditions:** User with preferredCurrency JPY, numberFormat lakh (set via API).
- **Steps:**
  1. `PUT /auth/preferences` with only `firstName`/`lastName` populated and blank currency/format.
- **Expected:** Names update; `preferredCurrency` stays JPY and `numberFormat` stays lakh (not reset to EUR/comma-dot). 200 with the unchanged prefs echoed. (Note: the `/account` form always submits the selected values, so this guards direct/partial API callers.)
- **Automated:** No

### CURR-033 - A household switch changes the currency label, never the number format or the preference
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** A login (preferredCurrency USD, numberFormat comma-dot) in 2 households: its own (budget currency USD) and a joined one (budget currency GBP).
- **Steps:**
  1. Use the household switcher to switch to the joined household (full re-bootstrap); then back.
  2. Leave the joined household.
- **Expected:** After each re-bootstrap `/auth/me` re-applies USD + comma-dot as the login's preferences (per-login), and `budgetCurrency` follows the ACTIVE household: money and the chip read £/"GBP · …" in the joined household and $/"USD · Your household" in the own one; grouping style is the same everywhere. `zbb.budgetCurrency` tracks the active household. (PREF-044.)
- **Automated:** No

---

## E. Legacy accounts kept in another currency (no new ones since W08)

### CURR-034 - A legacy account in another currency is left out of the totals (never a raw cross-currency sum)
- **Priority:** P0
- **Type:** Regression
- **Origin:** Before W08 the hero showed the raw arithmetic sum `1250 + 800 = €2,050.00` with "Totals shown in EUR; some accounts hold another currency."
- **Preconditions:** H-MIX (EUR 1,250.00 + legacy GBP 800.00), budget currency EUR.
- **Steps:**
  1. Open `/accounts`; read the "Total balance" hero, the "Available" tile, and the footnote.
- **Expected:** Hero **€1,250.00**, Available €1,250.00 (no Owed tile since rule 74) — only budget-currency accounts count — plus the pill "**1 account in another currency is not counted.**". Per-account cards still render each in its own currency (€1,250.00, £800.00). The GBP account's rows still count in the budget by their confirmed figure, never their pounds (CURR-057). (Area coverage: ACCT-005, ACCT-042.)
- **Automated:** Yes (client/src/pages/AccountsPage.catalog.test.tsx — ACCT-005)

### CURR-035 - Cross-currency transfer is rejected and moves nothing
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** H-MIX (legacy GBP account); attempt to transfer 100 from EUR "Joint" to GBP "UK Savings".
- **Steps:**
  1. On `/transactions` (or the transfer entry), pick From = Joint (EUR), To = UK Savings (GBP), amount 100, submit.
- **Expected:** Server rejects with 400 field error on `ToAccountId`: "**Both accounts must use the same currency to transfer between them.**". No transaction is created; both balances unchanged (€1,250.00 / £800.00). Blocks the money-vanish where €100 debited would credit £100. Without legacy data the situation can't arise: the GBP account itself is refused (CURR-050, TRF-021).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Transactions/TransfersTests.cs — `Transfer_BetweenDifferentCurrencies_IsRejected_AndMovesNothing`; client/e2e-journey/transfers-balances.spec.ts — the other-currency account is refused on the real stack)

### CURR-036 - Same-currency transfer stamps the source account's currency
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Two GBP accounts "UK A" and "UK B" (a GBP-budget household, or legacy accounts in an EUR one).
- **Steps:**
  1. Transfer £50 from UK A to UK B.
  2. Inspect the stored transfer's currency and both registers.
- **Expected:** The transfer is stamped `GBP` (from `from.Currency`, not a hardcoded EUR) and is never `fxPending`, even in an EUR budget (transfers never wait); both account-detail registers render it as `£50.00` with direction-appropriate sign. (Area coverage: TRF-008, TRF-022, TRF-027.)
- **Automated:** Yes (tests/AllotJar.Application.Tests/Transactions/TransfersTests.cs — `Transfer_StampsCurrencyFromSource_NotHardcodedEur`; ForeignAmountsTests — `A_transfer_never_waits`)

### CURR-037 - New accounts take the budget currency; an existing account's currency is fixed
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** H-MIX, legacy GBP "UK Savings".
- **Steps:**
  1. On `/accounts`, open the add-account modal.
  2. Enter inline edit on "UK Savings".
- **Expected:** The add modal has **no** Currency select; it reads "The account holds EUR, your budget currency." and posts `currency: "EUR"`. The edit card shows a read-only line "Currency **GBP** — fixed once created." with no editable control. `PUT /accounts/{id}` carries no currency field. (Area coverage: ACCT-018, ACCT-024.)
- **Automated:** Yes (client/src/pages/AccountsPage.catalog.test.tsx — ACCT-018, ACCT-024)

### CURR-038 - A manual entry is always in the budget currency, so it is refused on a legacy account in another currency
- **Priority:** P1
- **Type:** Negative
- **Origin:** Before #210/W08 a manual entry on a GBP account was stamped in the EUR month base and the GBP balance dropped by the raw number (a silent corruption). `CreateTransactionCommandHandler` now stamps the budget currency and `TransactionInvariants.EnsureAccountCurrency` rejects an account in another currency.
- **Preconditions:** H-MIX, legacy GBP "UK Savings" (£800.00), budget currency EUR.
- **Steps:**
  1. On `/transactions`, add an expense of 100 with Account = UK Savings.
  2. Add the same expense with Account = Joint and **Paid in another currency** GBP 100 (Amount 117.00).
- **Expected:** Step 1: 400 `AccountId` → "This account is in GBP, but the transaction is in EUR. Record it in GBP, or choose an account in the transaction's currency."; nothing is created; UK Savings stays £800.00. Step 2: created in **EUR** 117.00 on Joint (Joint −€117.00) with `originalAmount 100`, `originalCurrency GBP` kept for reference only — the paid-abroad figure never touches a balance.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Application/TTransactionsCoverageTests.cs — `Create_OnAnAccountOfADifferentCurrency_IsRejected`; ForeignAmountsTests — `A_manual_entry_paid_abroad_counts_the_confirmed_amount_and_keeps_what_was_paid`)

### CURR-039 - Reconciliation formats each account row in its own currency
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** H-MIX where a EUR account and a GBP account each back a jar.
- **Steps:**
  1. Open `/accounts`; read the "Jar reconciliation" table Balance/In jars/Float cells.
- **Expected:** Each row's three money cells use `currencyById[accountId]` (the account's own currency) — EUR rows show €, GBP rows show £; the table never sums across currencies into one figure. Negative float renders rose. (Area coverage: ACCT-056, ACCT-054.)
- **Automated:** No

### CURR-040 - The multiCurrency flag only hides the paid-abroad option and account currency labels
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Two builds: multiCurrency ON vs OFF (server `Features:MultiCurrency=false`); H-MIX with a waiting GBP row on no account.
- **Steps:**
  1. In each build open the add-account modal, the account cards, the add-transaction modal, and the waiting row.
- **Expected:** Both: no account currency picker (every new account is EUR); the waiting row keeps "Needs EUR amount" + **Enter amount**. ON: every card has a currency chip and edit cards the "fixed once created" note; the add-transaction modal offers **Paid in another currency**. OFF: only the GBP card keeps its chip/note; no **Paid in another currency** option. (Area coverage: ACCT-018, ACCT-019, TX-111.)
- **Automated:** Partial (client/src/pages/AccountsPage.catalog.test.tsx — ACCT-019)

---

## F. Import with locale-formatted amounts; rows in another currency wait (no FX)

### CURR-041 - Import number-format selector drives amount parsing
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** A generic CSV whose amounts are `1.234,56`-style (dot grouping, comma decimal).
- **Steps:**
  1. Upload on `/import`; in the mapping, set **Number format** (aria "Number format") to **1.234,56** (Comma = 2) and re-scan.
- **Expected:** Amounts parse under the Comma style (`.` grouping stripped, `,` → decimal) → `1.234,56` becomes `1234.56`. Selecting **1,234.56** (Dot = 1) instead strips `,` grouping and keeps `.` decimal. **Auto-detect** (0) resolves per the right-most-separator/trailing-digit heuristic. (Area coverage: IMP-030, IMP-034.)
- **Automated:** Yes (tests/AllotJar.Application.Tests/Imports/GenericCsvImporterTests.cs, ParserToleranceTests.cs)

### CURR-042 - Auto-detect resolves the decimal separator ambiguously but consistently
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** CSV under Auto-detect with rows `1.234` (grouping), `1.23` (decimal), `2.500,00` (mixed), `1,234.56` (mixed).
- **Steps:**
  1. Import with Number format = Auto-detect.
- **Expected:** `AutoNormalize` — when both separators present, right-most wins as decimal; a single separator is a decimal only with 1–2 trailing digits, else grouping. So `1.234` → 1234, `1.23` → 1.23, `2.500,00` → 2500.00, `1,234.56` → 1234.56. Consistent across the file.
- **Automated:** Yes (tests/AllotJar.Application.Tests/Imports/ParserToleranceTests.cs)

### CURR-043 - Currency column maps per-row currency; "Use EUR for every row" → the default currency
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** CSV with a Currency column containing EUR and GBP rows; budget currency EUR; no import account.
- **Steps:**
  1. Import; confirm the currency column is mapped, then re-run mapping it to **"Use EUR for every row"** (null column).
- **Expected:** Mapped column → each row stamped its own code (GBP rows → GBP transactions, which arrive **waiting** — CURR-044). Null column → `ResolveCurrency` falls back to `DefaultCurrency` for every row — the client sends the import account's currency, else the budget currency (EUR). A cell whose value isn't a 3-letter code also falls back to the default. (Area coverage: IMP-021.)
- **Automated:** Yes (tests/AllotJar.Application.Tests/Imports/GenericCsvImporterTests.cs — reads currency + default; client/src/pages/ImportPage.test.tsx — the fallback is the import account's currency)

### CURR-044 - A foreign-currency import row waits; only the user's confirmed amount makes it count
- **Priority:** P0
- **Type:** Regression
- **Origin/behaviour:** W08 (rules 42–44) replaced the automatic conversion (`FxRateResolver`: rate looked up by booking date, `BudgetActuals` rolled up `Amount × ExchangeRate`) with `ForeignAmounts.MarkWaiting`: no rate is applied by the app, ever.
- **Preconditions:** EUR budget; import (no import account) a GBP row of 40.00 dated 2026-06-01, assigned to the expense line Groceries.
- **Steps:**
  1. Commit the import; open `/` (June 2026) and `/transactions`.
  2. On the row, **Enter amount** → **Suggest** (rate e.g. 1.15) → **Confirm amount** with 46.00.
  3. Re-open `/`.
- **Expected:** Step 1: the row stores `amount 40.00, currency GBP, fxPending true` (no rate); Groceries' actual is **unchanged** and the dashboard notice says 1 transaction is waiting for its amount in EUR; the register shows "GBP 40.00" + "Needs EUR amount". Step 2: Suggest fills 46.00 (40 × 1.15, rounded to cents) but saves nothing; Confirm stores `amount 46.00, currency EUR, originalAmount 40.00, originalCurrency GBP`. Step 3: Groceries' actual rises by **€46.00** and the notice is gone. Same-currency (EUR) rows count at once with no lookup. Manual entries never wait (they are entered in EUR — CURR-038).
- **Automated:** Yes (ForeignAmountsTests — `An_imported_row_in_another_currency_waits_and_nothing_converts_it`, `Confirming_makes_the_row_a_budget_currency_row_and_keeps_the_foreign_figure`; FxPendingAggregatesTests — `BudgetActuals_ExcludePendingRows_AndReportTheCount`, `A_confirmed_amount_counts_on_its_line_and_leaves_the_waiting_count`)

### CURR-045 - Rate-provider failure never blocks anything: imports don't use it, and a missing suggestion means typing the amount
- **Priority:** P1
- **Type:** Negative
- **Origin:** Before W08 a provider failure left the row at `ExchangeRate = 1` (face value) until a background job (`FxReconciliationService`, deleted) retried. Now the provider (`FrankfurterExchangeRateProvider`, null on any network/parse error) only feeds **Suggest**.
- **Preconditions:** EUR budget; Frankfurter unreachable (or an unknown pair / a date with no rate).
- **Steps:**
  1. Import a statement with a GBP row; commit.
  2. On the waiting row, **Enter amount** → **Suggest**.
  3. Type 46.00 and **Confirm amount**.
- **Expected:** Step 1: the import succeeds exactly as when the provider is up (no rate is looked up); no 500. Step 2: `GET /transactions/conversion-suggestion` → 200 with `rate: null, suggestedAmount: null`; the modal says "No suggestion is available for GBP on this date. Enter the amount in EUR yourself." Step 3: saved; the row counts at €46.00. Nothing ever counts a foreign figure at face value.
- **Automated:** Yes (ForeignAmountsTests — `No_rate_means_no_suggestion_and_the_user_types_the_amount`; tests/AllotJar.Application.Tests/Imports/FrankfurterExchangeRateProviderTests.cs; client/src/pages/TransactionsPage.test.tsx — "Enter amount: says so when no suggestion is available and shows a refusal")

### CURR-046 - Mixed-currency import reports honest sums PER currency
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** A CSV mixing EUR and GBP rows.
- **Steps:**
  1. Commit; read the success summary.
- **Expected:** The commit summary reports money **grouped per currency** (e.g. "€X in, €Y out" and "£A in, £B out"), never a single blended cross-currency total, and reports honest money sums rather than counts. (Area coverage: IMP-067, IMP-068.)
- **Automated:** Partial (tests/AllotJar.Application.Tests/Imports/ImportPreviewCommitTests.cs)

### CURR-047 - Trailing-sign and parenthesised negatives are read as debits under any style
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** CSV with amounts `35.00-` (SAP/DATEV trailing sign) and `(35.00)` (accounting parens).
- **Steps:**
  1. Import under Dot, Comma, and Auto styles.
- **Expected:** Both parse to −35.00 (debit) regardless of the chosen decimal style — `TryParseSignedAmount` handles leading/trailing `-` and `(...)`. Currency stamping proceeds normally (a row in another currency than the budget's waits). (Area coverage: IMP-033.)
- **Automated:** Yes (tests/AllotJar.Application.Tests/Imports/ParserToleranceTests.cs)

### CURR-048 - Currency symbols and separators in the amount cell are stripped before parsing
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** CSV amount cells like `£1,234.56`, `€ 1.234,56`, `$1,234.56`.
- **Steps:**
  1. Import with the matching (or Auto) number style.
- **Expected:** `TryParseSignedAmount` keeps only digits/`.`/`,`/sign, dropping symbols, spaces and letters, so `£1,234.56` → 1234.56. The stamped transaction currency comes from the currency column/default (CURR-043), NOT from the symbol in the amount cell.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Imports/ParserToleranceTests.cs)

### CURR-049 - An off-list ISO currency in the CSV currency column is honoured and shown by its code
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** CSV whose Currency column contains `KWD` (3-decimal, off the 24-code picker); budget currency EUR; no import account.
- **Steps:**
  1. Map the currency column and commit; view the row in `/transactions`.
- **Expected:** `ResolveCurrency` accepts any `^[A-Za-z]{3}$` code (uppercased) → the transaction is stamped KWD even though the UI never offers KWD. Being in another currency than EUR it **waits**: the register reads "KWD 1,234.57" (`formatForeign` = code + the active format's 2-decimal plain number) with "Needs EUR amount", and it counts nowhere until confirmed (CURR-044). Three-decimal KWD rendering applies only to counted KWD money (CURR-011).
- **Automated:** Partial (tests/AllotJar.Application.Tests/Imports/GenericCsvImporterTests.cs — currency code parsing)

---

## G. One budget currency & money paid in another currency (W08)

### CURR-050 - Accounts, months and manual entries all take the budget currency; another is refused
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** U-EUR (budget currency EUR, locked); a second login U-GB whose household has no month yet and whose owner chose GBP.
- **Steps:**
  1. As U-EUR: `POST /accounts` with `currency: "USD"`; open **+ Add account**.
  2. As U-EUR: create a jar held in a legacy GBP account (seeded) — `POST /jars` with that `fundingAccountId`.
  3. As U-GB: `POST /accounts` with `currency: "EUR"`, then `"GBP"`; create the first month.
- **Expected:** 1: 400 `Currency` → "This budget is in EUR, so its accounts are too. A bank converts payments in other currencies into EUR itself."; the modal has no picker ("The account holds EUR, your budget currency."). 2: 400 `FundingAccountId` → "{name} is in GBP, but the budget is in EUR. Choose an account in EUR." 3: EUR refused ("This budget is in GBP, …"), GBP created; the first month is GBP.
- **Automated:** Yes (ForeignAmountsTests — `A_new_account_must_be_in_the_budget_currency`, `A_jar_cannot_live_in_an_account_kept_in_another_currency`, `The_budget_currency_is_the_first_months_else_the_owners_choice`; client/src/pages/AccountsPage.catalog.test.tsx — ACCT-018)

### CURR-051 - Suggest: the ECB reference rate for that date, rounded to cents half away from zero, saving nothing
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** U-EUR; a rate provider returning GBP→EUR 1.17055 for 2026-06-03 (stub or a known historical date).
- **Steps:**
  1. `GET /api/transactions/conversion-suggestion?currency=gbp&amount=45.50&date=2026-06-03`.
  2. Same with an amount whose product ends in exactly half a cent (e.g. rate 1.005, amount 1.00 → 1.005).
  3. `…?currency=EUR&amount=10&date=…`; `…?currency=EURO…`; `…?currency=USD&amount=0…`; `…?currency=USD&amount=10&date={tomorrow, UTC}`.
  4. Count transactions before and after.
- **Expected:** 1: 200 `{currency: "GBP", amount: 45.5, budgetCurrency: "EUR", date: "2026-06-03", rate: 1.17055, suggestedAmount: 53.26, source: "European Central Bank reference rate"}` (45.50 × 1.17055 = 53.260025 → 53.26). 2: **1.01** (`MidpointRounding.AwayFromZero`, not banker's 1.00). 3: 400 `Currency` → "The budget is in EUR already; there is nothing to convert."; 400 "Currency must be a 3-letter ISO 4217 code."; 400 `Amount` → "Enter an amount greater than zero."; 400 `Date` → "There is no reference rate for a future date yet. Enter the amount yourself." (the source would otherwise answer with its latest rate) — the provider is not called for any of them. 4: unchanged — a suggestion records nothing and infers no fee; the UI shows it as "Suggested from the European Central Bank reference rate: 1 GBP = 1.17055 EUR. Check it matches what you paid." (rate formatted up to 6 decimals in the user's number format).
- **Automated:** Yes (ForeignAmountsTests — `A_suggestion_is_the_reference_rate_rounded_to_cents_and_records_nothing`, `A_suggestion_needs_another_currency_a_positive_amount_and_a_day_that_has_a_rate` [Theory, including tomorrow]; the half-cent midpoint is not asserted)

### CURR-052 - A waiting row counts in no figure anywhere until its amount is confirmed
- **Priority:** P0
- **Type:** Regression
- **Origin:** W08 (rule 44) — waiting rows used to count at face value (rate 1) until reconciled.
- **Preconditions:** H-MIX, June 2026 month; a waiting GBP 30.00 expense "London Cab" (on no account) assigned to Groceries and attributed to Alex; a waiting GBP 200.00 income "Freelance" attributed to Robin; a jar with its own savings line.
- **Steps:**
  1. Read the dashboard (Groceries, hero, notice), `/reports` (June trend and breakdown), `/people` (Alex spent, Robin received), `/jars`, `/transactions` hero.
  2. Confirm London Cab at €35.10 and Freelance at €233.00; re-read everything.
- **Expected:** Step 1: neither row is in any figure — Groceries spent, Remaining, report totals, Alex's Spent, Robin's Received, jar balances and the Transactions hero all exclude them; each surface flags them instead: dashboard "2 transactions in another currency are waiting for their amount in EUR and aren’t counted until it’s entered. Enter them on Transactions"; People "+1 needs EUR amount" beside Alex and "+1 income row in another currency, not counted until its amount in EUR is entered."; reports carry the waiting count. Step 2: the confirmed EUR amounts (35.10 / 233.00) appear everywhere and the flags disappear — never the GBP figures.
- **Automated:** Yes (FxPendingAggregatesTests — `BudgetActuals_ExcludePendingRows_AndReportTheCount`, `BudgetActuals_ExcludeSlicesOfAPendingParent`, `JarBalances_ExcludePendingSpending`, `A_confirmed_amount_counts_on_its_line_and_leaves_the_waiting_count`; ReportFiguresTests — `MonthReport_LeavesPendingFxRowsOut_AndCountsThem`; MemberFiguresRule28Tests — `GetMemberSpending_WithAMonth_CountsOnlyThatMonth_AndSkipsWaitingRows`, `GetMemberIncome_Received_CountsConfirmedAmounts_AndSkipsWaitingRows_CountingThem`; client DashboardPage.catalog.test.tsx and PeoplePage.catalog.test.tsx — PPL-082 notices)

### CURR-053 - Migration "Keep counting": a converted row keeps exactly the figure it counted
- **Priority:** P0
- **Type:** Regression
- **Origin:** W08 `ForeignAmounts` migration (`20260929134603_ForeignAmounts`; Christopher's decision "Keep counting", 29 Sep 2026): `ExchangeRate` is dropped; figures that counted must keep counting exactly as before. The old rate lookup converted a row into its month's `BaseCurrency`, or into **EUR** when that month had no budget, so a row keeps its figure only when that figure was in the household's budget currency (CURR-055 covers the rest).
- **Preconditions:** A database at the migration before `ForeignAmounts`, with household H (owner EUR, June 2026 month in EUR), rows dated 10 June 2026 on **no** account: a GBP 100.00 expense at rate 1.17 (not pending); a USD 10.00 expense at rate 1.123457 split into slices 3.33 / 3.33 / 3.34; a USD 64.00 row at rate **1** (the old app's edit of a waiting row, where the user typed the budget figure); an EUR 30.00 row on an EUR account. Household G (no month, owner chose GBP): a GBP 8.00 row.
- **Steps:**
  1. Deploy / run `dotnet ef database update` (or start the API, which migrates).
  2. Read the rows, their slices, and the dashboard/reports for June.
- **Expected:** GBP 100 row → `amount 117.0000 EUR`, `originalAmount 100 GBP`, not waiting (Amount × Rate at 4 decimals). USD 10 row → `11.2346 EUR` (`originalAmount 10 USD`); slices restated at the same rate — 3.7411 / 3.7411 / 3.7524 — the largest absorbing the rounding so they still add up to 11.2346; no slice gets a `budgetAmount`. USD 64 row → `64 EUR` with **no** original figure (at rate 1 the amount already was the budget figure; there is no foreign figure to keep). EUR row unchanged. G's GBP row unchanged (GBP is G's budget currency: first month's, else owner's preference, else EUR). Every figure (line actuals, reports, People) is the same as before the deploy; the register now shows the restated EUR amount with a grey "GBP 100.00" caption. Months are never restamped. Rows on an account are covered by CURR-054.
- **Automated:** Yes (tests/AllotJar.IntegrationTests/ForeignAmountsMigrationTests.cs — `Converted_rows_keep_counting_the_figure_they_counted_and_the_rest_wait_or_count_as_they_are`)

### CURR-054 - Migration "Support them": a row on an account keeps its amount and counts its figure beside it; waiting rows already in the budget currency now count
- **Priority:** P0
- **Type:** Regression
- **Origin:** W08 `ForeignAmounts` migration — a row on an account is that account's money, so restating it would change the balance. The first W08 migration made such rows wait with no way to confirm them; Christopher's "Support them" (29 Sep 2026) keeps their figure as `BudgetAmount` instead. A row "pending a rate" that needs no rate should never have waited.
- **Preconditions:** As CURR-053 (household H, EUR; EUR account "Joint" and a legacy **GBP** account "UK Pot"), plus rows dated 10 June 2026: a GBP 25.00 expense on UK Pot at rate 1.2 (not pending); a GBP 10.00 expense on UK Pot at rate 1.123457 split 3.33 / 3.33 / 3.34; a GBP 45.50 expense on **Joint** at rate 1.17 (a row whose currency differed from its account, possible before #210); a USD 10.00 expense on Joint at rate 1.123457 split 3.33 / 3.33 / 3.34; a GBP 7.00 row on UK Pot pending a rate; a USD 40.00 row on no account pending a rate; an EUR 12.00 row wrongly pending; an EUR 50.00 transfer.
- **Steps:**
  1. Run the migration; read the rows, their slices, both balances and `/transactions`.
- **Expected:** GBP 25 on UK Pot → still `25.00 GBP`, not waiting, `budgetAmount 30.0000` (25 × 1.2); the register reads "−£25.00" with "Counts as €30.00". GBP 10 split on UK Pot → amount and slices unchanged (3.33 / 3.33 / 3.34), row `budgetAmount 11.2346`, slice `budgetAmount`s 3.7411 / 3.7411 / 3.7524 (largest absorbs the rounding; they add up to the row's). GBP 45.50 on Joint → still `45.50 GBP`, `budgetAmount 53.2350`. USD 10 split on Joint → likewise `budgetAmount 11.2346` with slices 3.7411 / 3.7411 / 3.7524. No original figure is kept on any of them. Both balances are exactly as before (balances sum `amount`). GBP 7 pending on UK Pot → still waiting, no `budgetAmount` — it can now be confirmed like any waiting row (TX-112). USD 40 pending → unchanged, still waiting. EUR 12 pending → counts (`fxPending` cleared, 12.00 EUR). Transfer → untouched. `ExchangeRate` no longer exists. `Down` (lossy by design) re-adds `ExchangeRate` at 1 and drops `BudgetAmount` and the original figures, so a row on an account counts its raw amount again and rows made waiting or counting keep their new state.
- **Automated:** Yes (tests/AllotJar.IntegrationTests/ForeignAmountsMigrationTests.cs — `Converted_rows_keep_counting_the_figure_they_counted_and_the_rest_wait_or_count_as_they_are`; `Down` is not exercised)

### CURR-055 - Migration: a figure the old lookup made in its EUR default is never read as the budget currency
- **Priority:** P0
- **Type:** Regression
- **Origin:** W08 adversarial review — the old rate lookup converted a row dated in a month with no budget into **EUR**; the first W08 migration then read that figure as the household's budget currency, so a GBP household's USD row counted a USD→EUR figure as pounds.
- **Preconditions:** A database at the migration before `ForeignAmounts`: household g (owner GBP) whose only month is **July 2026, GBP**, and a legacy USD account; rows dated 10 June 2026 (no June month, so the old base was EUR): a GBP 100.00 row at rate 1.17 on no account; a USD 100.00 row at rate 0.92 on no account; a USD 50.00 row at rate 0.92 on the USD account; plus a USD 100.00 row dated 10 July 2026 at rate 0.79 on no account. None pending.
- **Steps:**
  1. Run the migration; read the rows and `/transactions`.
- **Expected:** GBP 100 (June) → unchanged `100.00 GBP`, counts, no original figure — it is already in the budget currency; the old €117 figure was the mistake. USD 100 (June) → `100.00 USD`, **waiting** ("USD 100.00" + "Needs GBP amount"): there is no figure in pounds to keep. USD 50 on the USD account → `50.00 USD`, waiting, no `budgetAmount`; Enter amount stores the user's figure as `budgetAmount` (TX-112). USD 100 (July, a GBP month) → `79.0000 GBP`, `originalAmount 100 USD`, counts (CURR-053). Nothing is relabelled 1:1.
- **Automated:** Yes (tests/AllotJar.IntegrationTests/ForeignAmountsMigrationTests.cs — `Rows_the_old_lookup_converted_into_its_EUR_default_are_never_read_as_the_budget_currency`)

### CURR-056 - Migration: a household with months in two currencies stops it before anything changes
- **Priority:** P0
- **Type:** Negative
- **Origin:** W08 adversarial review (PR #278, census Q2) — on the old app a month with no earlier month took the creating login's preference, so a household could hold months in two currencies; it has no single budget currency to keep counting in, and picking one would relabel the other months' money (rule 42).
- **Preconditions:** A database at the migration before `ForeignAmounts`; household m (owner EUR) with a **May 2026 GBP** month and a **June 2026 EUR** month; a USD 20.00 row at rate 0.92.
- **Steps:**
  1. Run `dotnet ef database update` (or start the API).
  2. Read `__EFMigrationsHistory` and the row.
- **Expected:** Step 1 fails with a SQL error (THROW 50001): "ForeignAmounts: a household has budget months in more than one currency, so its budget currency is ambiguous. Nothing was changed. See PR #278." Step 2: `ForeignAmounts` is **not** recorded as applied; the row still has `ExchangeRate 0.92` and no new columns were kept — nothing changed. The deploy stops until the owner decides which currency the household keeps and the data is corrected; then the migration runs as in CURR-053–CURR-055.
- **Automated:** Yes (tests/AllotJar.IntegrationTests/ForeignAmountsMigrationTests.cs — `A_household_with_months_in_two_currencies_stops_the_migration_before_anything_changes`)

### CURR-057 - A row on a legacy account counts its budget figure on every budget surface; the account keeps its own money
- **Priority:** P1
- **Type:** Regression
- **Origin:** W08 adversarial review / "Support them" (29 Sep 2026): every budget, report, People and refund figure reads `budgetAmount ?? amount`; account and jar balances keep reading `amount`.
- **Preconditions:** H-MIX (EUR 1,250.00 + legacy GBP "UK Savings" 800.00), June 2026 month; on UK Savings: a GBP 25.00 expense with `budgetAmount 30.00` assigned to Groceries and attributed to Alex, and a GBP 50.00 income with `budgetAmount 58.00` attributed to Robin, no line (both confirmed via Enter amount, or kept by the migration — CURR-054).
- **Steps:**
  1. Read the dashboard (Groceries), `/reports` (June), `/people` (Alex's Spent, Robin's Received), the `/transactions` hero and rows, and `/accounts`.
- **Expected:** Groceries' actual counts **€30.00**; the June report counts €30.00 of spending and the €58.00 income as Uncategorised income; Alex's Spent includes €30.00 and Robin's Received €58.00; the Transactions hero adds €30.00 to Money out and €58.00 to Money in. The rows read "−£25.00" / "+£50.00", each with a grey "Counts as €30.00" / "Counts as €58.00" caption. UK Savings' balance is **£825.00** (800 − 25 + 50, its own money) and stays out of the Accounts hero (CURR-034). Nowhere is £25 or £50 counted as euros, and nowhere is a rate applied. A refund of the expense is measured against €30.00 (TX-115).
- **Automated:** Partial (ForeignAmountsTests — `A_waiting_row_on_an_account_kept_in_another_currency_counts_its_confirmed_figure_and_the_balance_stays` (line actual and balance), `A_refund_is_measured_against_what_its_purchase_counts_not_its_accounts_amount`; client/src/pages/TransactionsPage.test.tsx — the "Counts as" caption; reports, People and the Transactions hero are not asserted for `budgetAmount`)

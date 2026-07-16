# Currency & Locale Matrix

**ID prefix:** CURR | **Scope:** The cross-feature currency + number-format surface of AllotJar as a test matrix: the 24-currency sign-up/preferences shortlist (plus any ISO 4217 code reachable via API/import) and the 5 number-format presets, how each renders decimals, symbol and symbol-position in **every** money display (dashboard budget lines, transactions, transfers, jars, allocation, accounts, reconciliation, reports, import sums, hero labels), how a **number-format** change ripples app-wide while a **currency-label** change relabels *some* surfaces with **no FX conversion**, the per-surface currency source (frozen `BudgetMonth.BaseCurrency` vs live `preferredCurrency` vs per-account vs per-transaction stamp), mixed per-account currencies in one household (per-currency net footer, cross-currency transfer guard, manual-entry stamping quirk), and locale-formatted amounts in imports with real FX resolution. | **Out of scope:** area-level mechanics owned by sibling files — sign-up form/consent (`19-*` / register), account CRUD + reconciliation (`12-accounts-reconciliation.md`), transfer mechanics (`11-transfers.md`), transaction entry/parsing (`10-transactions.md`), import parser detail (`15-import.md`), allocation math (`14-allocation.md`), jar accrual (`13-jars.md`), reports (`18-reports.md`), month lifecycle (`23-time-date-lifecycle.md`). Reference those by ID; this file only exercises the **cross-feature currency/locale behaviour they cannot see**.

**Test data setup:** Unless a case says otherwise, assume a beta build. Shared fixtures:
- **U-EUR**: solo owner, preferredCurrency `EUR`, numberFormat `comma-dot` (en-GB, the app default), one EUR account "Joint" (balance 1,250.00), a current EUR-based budget month with a Rent line planned 1,100.00.
- **U-USD**: solo owner registered with preferredCurrency `USD`, numberFormat `comma-dot`.
- **U-DE**: solo owner, preferredCurrency `EUR`, numberFormat `dot-comma` (de-DE).
- **H-MIX**: shared household, 2 members, two accounts — "Joint" EUR (1,250.00) and "UK Savings" GBP (800.00) — `multiCurrency` feature flag ON.
- Money is integer minor units at SCALE 4 client-side / `decimal(18,4)` server-side; actuals are always transaction-derived at read time. `BudgetMonth.BaseCurrency` defaults to EUR and is **inherited from the previous month, never derived from `preferredCurrency`**. Manual transactions are stamped in the month's `BaseCurrency` (not the account's currency); imports stamp the row/column currency and resolve FX to the month base.

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
- **Preconditions:** U-EUR (comma-dot).
- **Steps:**
  1. On `/accounts`, add a USD account "Travel" opening 1,100.00, and a GBP account "UK" opening 45.50 (multiCurrency ON).
  2. Read each card's balance.
- **Expected:** EUR "Joint" → `€1,250.00`, USD "Travel" → `$1,100.00`, GBP "UK" → `£45.50` — each formatted in the account's OWN currency at its ISO 2-minor-digit precision. `formatMoney(minor,'EUR')` contains `€` and `1,250.00`; GBP contains `£`.
- **Automated:** Partial (client/src/lib/money.test.ts — formats with budget currency, GBP `£`)

### CURR-010 - Zero-decimal currency (JPY) renders whole units, no decimal point
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** U-USD switched to preferredCurrency JPY (or CURR-008 user); a jar "Trip" balance 1,234.
- **Steps:**
  1. Open `/jars` and read the "Trip" jar balance and the "Total saved" hero.
- **Expected:** JPY uses its ISO minor-unit count of 0 → `¥1,234` (no `.00`). `formatMoney(fromAmount(1234),'JPY')` contains `1,234` and does **not** contain `1,234.0`. No fixed fraction digits are forced by the formatter.
- **Automated:** Partial (client/src/lib/money.test.ts — "uses each currency's natural fraction digits", JPY has no minor unit)

### CURR-011 - Three-decimal currency (KWD/BHD) renders three decimals
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** A transaction/account stamped `KWD` (reachable via import currency column or the off-list API path in CURR-006; the picker never offers it).
- **Steps:**
  1. View the KWD-stamped row in the transactions register (`/transactions`).
- **Expected:** `formatMoney(fromAmount(1234.567),'KWD')` renders three decimals — contains `1,234.567`. The Intl formatter honours each currency's own ISO minor-unit count (2/0/3) without the app pinning a digit count.
- **Automated:** Partial (client/src/lib/money.test.ts — KWD three decimals)

### CURR-012 - JPY amount entered WITH decimals: stored at scale 4, displayed rounded
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** JPY-preferred user; a jar/account whose display currency is JPY.
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
- **Preconditions:** A transaction stamped with a code Intl has no symbol glyph for (e.g. a rare/off-list ISO code).
- **Steps:**
  1. View the row in `/transactions`.
- **Expected:** `currencySymbol` returns the ISO code itself when no symbol part is produced (`part?.value ?? currency`), so the amount reads e.g. `XAF 1,234` rather than crashing or showing a blank symbol. Never throws.
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

## D. Currency-label change, NO FX, and per-surface currency source

### CURR-026 - Changing preferred currency relabels Jars + Allocation with NO conversion
- **Priority:** P0
- **Type:** Regression
- **Origin:** JarsPage/AllocationPage format with the LIVE `preferredCurrency`; there is no FX applied to the display — same digits, new label.
- **Preconditions:** U-EUR with a jar "Emergency" balance 500.00 and an allocation preview pool 2,000.00.
- **Steps:**
  1. `/account` → Preferences, change **Currency** from Euro (€) to **US dollar ($)**, Save.
  2. Visit `/jars` and `/allocation`.
- **Expected:** Jars "Total saved" hero and the "Emergency" jar now read **$500.00** (was €500.00) — the number is **identical**, only the symbol changed. Allocation "Income to allocate" reads **$2,000.00**. No exchange-rate conversion happens on a preference change; the currency label is cosmetic for these surfaces.
- **Automated:** No

### CURR-027 - Currency change does NOT relabel dashboard budget or reports
- **Priority:** P0
- **Type:** Regression
- **Origin:** DashboardPage uses `month.currency` (frozen `BudgetMonth.BaseCurrency`); ReportsPage uses `breakdownMonth.baseCurrency ?? 'EUR'`. Neither reads `preferredCurrency`.
- **Preconditions:** U-EUR whose current month has `BaseCurrency=EUR`; Rent line 1,100.00.
- **Steps:**
  1. Change preferred currency EUR → USD (as CURR-026), Save.
  2. Visit `/` (dashboard) and `/reports`.
- **Expected:** Dashboard hero ("Remaining to budget"), the "Every {noun} has a job" badge noun, budget lines, and all Reports figures **stay in €** (the month's base currency), even though `/jars` now shows $. This intentional split (frozen month base vs live preference) means a currency change produces a **mixed-symbol app** — document as expected, not a bug to "fix" by relabelling the dashboard.
- **Automated:** No

### CURR-028 - A USD sign-up still gets a EUR-based first budget month
- **Priority:** P1
- **Type:** Regression
- **Origin:** `CreateBudgetMonthCommandHandler` sets `BaseCurrency = previous?.BaseCurrency ?? CurrencyCode.Eur` — never from `preferredCurrency`. There is no request field or endpoint to set a month's base currency.
- **Preconditions:** U-USD (preferredCurrency USD), no months yet.
- **Steps:**
  1. Create the first budget month (blank or template) from the dashboard.
  2. Read the dashboard hero currency vs the sign-up tagline / Jars currency.
- **Expected:** The month's `baseCurrency` is **EUR**; the dashboard budget renders in € while the tagline noun and Jars/Allocation render in $ (USD). A user who chose USD still plans their budget in EUR. Known limitation — budget base currency is decoupled from the display preference.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — BaseCurrency default EUR / inherited)

### CURR-029 - Single-currency Accounts hero labels in the ACCOUNT currency, not the preference
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** A household whose only account is GBP (balance 800.00); user preferredCurrency EUR.
- **Steps:**
  1. Open `/accounts`; read the "Total balance" hero and tiles.
  2. Change preferred currency to USD; return to `/accounts`.
- **Expected:** With one currency present, `heroCurrency` = that account's currency (GBP) → hero and tiles read **£800.00**, and there is **no** mixed-currency footnote. Changing the preference to USD does **not** relabel the account cards or the single-currency hero (still £). (Area coverage: ACCT-004.)
- **Automated:** No

### CURR-030 - Transactions register formats each row in its own stamped currency
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** H-MIX with an EUR-stamped row and a GBP-stamped (imported) row.
- **Steps:**
  1. Open `/transactions`; read the two rows' amounts.
  2. Change preferred currency; re-read.
- **Expected:** Each amount uses the transaction's OWN `currency` stamp (`€…` vs `£…`), never the preference; a preference change doesn't relabel existing rows. (Area coverage: TX/ACCT-048, TRF-027.)
- **Automated:** No

### CURR-031 - New months inherit the previous month's base currency (chain from EUR)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** U-EUR with a June month (BaseCurrency EUR); preferred currency later changed to USD.
- **Steps:**
  1. Create July via "Copy last month" (or blank).
  2. Inspect July's base currency.
- **Expected:** July `baseCurrency` = **EUR** (inherited from June), unaffected by the USD preference change. The base-currency chain propagates from the first month's default and never resynchronises to the current preference.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs — "july.BaseCurrency ... inherited")

### CURR-032 - "Leave as is" — a name-only preferences save never resets currency/format
- **Priority:** P1
- **Type:** Regression
- **Origin:** AuthController preferences endpoint: blank `preferredCurrency`/`numberFormat` in the payload means "leave as is" (`string.IsNullOrWhiteSpace(...) ? user.X : request.X`).
- **Preconditions:** User with preferredCurrency JPY, numberFormat lakh (set via API).
- **Steps:**
  1. `PUT /auth/preferences` with only `firstName`/`lastName` populated and blank currency/format.
- **Expected:** Names update; `preferredCurrency` stays JPY and `numberFormat` stays lakh (not reset to EUR/comma-dot). 200 with the unchanged prefs echoed. (Note: the `/account` form always submits the selected values, so this guards direct/partial API callers.)
- **Automated:** No

### CURR-033 - Display preferences survive a household switch / leave
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** A login in 2 households, preferredCurrency USD + numberFormat comma-dot.
- **Steps:**
  1. Use the household switcher to switch to the other household (full re-bootstrap).
  2. Then leave a joined household.
- **Expected:** After each re-bootstrap, `/auth/me` → `applyPrefs` re-applies USD + comma-dot (preferences are per-login, not per-household). Money everywhere renders in the same style before and after the switch/leave. Currency preference is a user attribute, not a household attribute.
- **Automated:** No

---

## E. Mixed per-account currencies in one household

### CURR-034 - Mixed accounts show a raw cross-currency sum + footnote (deferred FX)
- **Priority:** P0
- **Type:** Edge
- **Preconditions:** H-MIX (EUR 1,250.00 + GBP 800.00), preferredCurrency EUR.
- **Steps:**
  1. Open `/accounts`; read the "Total balance" hero, "Available"/"Owed" tiles, and the footnote.
- **Expected:** With >1 currency, `heroCurrency` falls back to `preferredCurrency` (EUR); the hero shows the **raw arithmetic sum** `1250 + 800 = 2050` labelled **€2,050.00** — a deliberately-uncoverted, technically-meaningless figure — plus the pill "**Totals shown in EUR; some accounts hold another currency.**". Per-account cards still render each in its own currency (€1,250.00, £800.00). (Area coverage: ACCT-005, ACCT-042.)
- **Automated:** No

### CURR-035 - Cross-currency transfer is rejected and moves nothing
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** H-MIX; attempt to transfer 100 from EUR "Joint" to GBP "UK Savings".
- **Steps:**
  1. On `/transactions` (or the transfer entry), pick From = Joint (EUR), To = UK Savings (GBP), amount 100, submit.
- **Expected:** Server rejects with 400 field error on `ToAccountId`: "**Both accounts must use the same currency to transfer between them.**". No transaction is created; both balances unchanged (€1,250.00 / £800.00). Blocks the money-vanish where €100 debited would credit £100. (Area coverage: TRF-017, TX-083.)
- **Automated:** Yes (tests/AllotJar.Application.Tests/Transactions/TransfersTests.cs — `Transfer_BetweenDifferentCurrencies_IsRejected_AndMovesNothing`)

### CURR-036 - Same-currency transfer stamps the source account's currency
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Two GBP accounts "UK A" and "UK B".
- **Steps:**
  1. Transfer £50 from UK A to UK B.
  2. Inspect the stored transfer's currency and both registers.
- **Expected:** The transfer is stamped `GBP` (from `from.Currency`, not a hardcoded EUR) with `ExchangeRate=1`; both account-detail registers render it as `£50.00` with direction-appropriate sign. (Area coverage: TRF-008, TRF-027.)
- **Automated:** Yes (tests/AllotJar.Application.Tests/Transactions/TransfersTests.cs — `Transfer_StampsCurrencyFromSource_NotHardcodedEur`)

### CURR-037 - An account's currency is fixed at creation (immutable on edit)
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** H-MIX, GBP "UK Savings".
- **Steps:**
  1. On `/accounts`, add-account modal: confirm the note "**An account's currency is fixed once created.**".
  2. Enter inline edit on "UK Savings".
- **Expected:** The add modal offers a Currency select (multiCurrency ON); the edit card shows a read-only line "Currency **GBP** — fixed once created." with no editable control. `PUT /accounts/{id}` carries no currency field. (Area coverage: ACCT-024.)
- **Automated:** No

### CURR-038 - Manual entry on a foreign-currency account is stamped in the MONTH BASE, not the account
- **Priority:** P1
- **Type:** Edge
- **Origin:** `CreateTransactionCommandHandler` sets `currency = month?.BaseCurrency ?? EUR` (comment: "Manual entries are in the budget's base currency"); `AccountBalances` sums raw `Amount` "in the account's own currency".
- **Preconditions:** H-MIX, GBP "UK Savings", current month `BaseCurrency=EUR`.
- **Steps:**
  1. On `/transactions`, add a manual £-intended expense of 100 with Account = UK Savings (GBP).
  2. Read the register row's currency and the account card balance.
- **Expected:** The stored transaction is stamped **EUR** (the month base), `ExchangeRate=1` — so the register row renders **€100.00** even though the account is GBP. The GBP account balance drops by the raw 100 (`AccountBalances` adds `Amount` with no FX/currency check), shown as **£700.00**. Cross-feature quirk/limitation: manual entries never adopt the account currency, and the balance mixes the numeric value across the currency label. Document; do not silently "fix" by converting.
- **Automated:** No

### CURR-039 - Reconciliation formats each account row in its own currency
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** H-MIX where a EUR account and a GBP account each back a jar.
- **Steps:**
  1. Open `/accounts`; read the "Jar reconciliation" table Balance/In jars/Float cells.
- **Expected:** Each row's three money cells use `currencyById[accountId]` (the account's own currency) — EUR rows show €, GBP rows show £; the table never sums across currencies into one figure. Negative float renders rose. (Area coverage: ACCT-056, ACCT-054.)
- **Automated:** No

### CURR-040 - Currency picker visibility follows the multiCurrency flag
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Two builds: multiCurrency ON vs OFF.
- **Steps:**
  1. With the flag ON, open the add-account modal → Currency select present, defaults to `preferredCurrency`, resets to it after each add.
  2. With the flag OFF (server `Features:MultiCurrency=false`), open the add-account modal.
- **Expected:** ON: currency select + "fixed once created" note shown; new account uses the chosen currency; the per-card currency chip renders. OFF: no currency picker, no chip, no reconciliation currency mismatch — every new account silently takes `preferredCurrency`. (Area coverage: ACCT-018, ACCT-019.)
- **Automated:** No

---

## F. Import with locale-formatted amounts & real FX

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

### CURR-043 - Currency column maps per-row currency; "Use EUR for every row" → default EUR
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** CSV with a Currency column containing EUR and GBP rows.
- **Steps:**
  1. Import; confirm the currency column is mapped, then re-run mapping it to **"Use EUR for every row"** (null column).
- **Expected:** Mapped column → each row stamped its own code (GBP rows → GBP transactions). Null column → `ResolveCurrency` falls back to `DefaultCurrency` (EUR) for every row. A cell whose value isn't a 3-letter code also falls back to the default. (Area coverage: IMP-021.)
- **Automated:** Yes (tests/AllotJar.Application.Tests/Imports/GenericCsvImporterTests.cs — reads currency + default)

### CURR-044 - A foreign-currency import row gets a real FX rate into the month base
- **Priority:** P0
- **Type:** Happy
- **Origin/behaviour:** `FxRateResolver` sets rate 1 for same-currency, else resolves via the ECB/Frankfurter provider by booking date; `BudgetActuals` rolls up `Amount × ExchangeRate`.
- **Preconditions:** EUR-based month; import a GBP row of 40.00 dated 2026-06-01, assigned to an expense line.
- **Steps:**
  1. Commit the import; open `/` and read the line's actual.
- **Expected:** The GBP transaction stores an `ExchangeRate` from GBP→EUR for that date (e.g. 1.15) so its contribution to the EUR budget line is `40 × 1.15 = 46.00 €` (BaseAmount), while the register row still shows `£40.00`. Same-currency (EUR) rows keep rate 1 with no lookup. This is the ONLY path that resolves FX — manual entries do not (CURR-038).
- **Automated:** Yes (tests/AllotJar.Application.Tests/Transactions/FxRateResolverTests.cs — `Apply_ConvertsForeignToBaseAndSetsRate` 40 GBP × 1.15 = 46.00; BudgetActualsTests)

### CURR-045 - FX-provider failure degrades to rate 1 so the import still completes
- **Priority:** P1
- **Type:** Negative
- **Origin:** `FxRateResolver` keeps `ExchangeRate = 1m` when the provider returns null/≤0; `FrankfurterExchangeRateProvider` returns null on any network/parse error.
- **Preconditions:** EUR-based month; import a foreign row when the rate is unavailable (unknown pair or provider offline).
- **Steps:**
  1. Commit the import.
- **Expected:** The import succeeds; the foreign transaction gets `ExchangeRate = 1`, so its actual counts at face value in its own currency (a known deferred-FX limitation) rather than blocking the import. No 500. FX "must never break an import."
- **Automated:** Partial (tests/AllotJar.Application.Tests/Transactions/FxRateResolverTests.cs; TestDoubles/FakeExchangeRateProvider.cs)

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
- **Expected:** Both parse to −35.00 (debit) regardless of the chosen decimal style — `TryParseSignedAmount` handles leading/trailing `-` and `(...)`. Currency stamping and FX proceed normally. (Area coverage: IMP-033.)
- **Automated:** Yes (tests/AllotJar.Application.Tests/Imports/ParserToleranceTests.cs)

### CURR-048 - Currency symbols and separators in the amount cell are stripped before parsing
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** CSV amount cells like `£1,234.56`, `€ 1.234,56`, `$1,234.56`.
- **Steps:**
  1. Import with the matching (or Auto) number style.
- **Expected:** `TryParseSignedAmount` keeps only digits/`.`/`,`/sign, dropping symbols, spaces and letters, so `£1,234.56` → 1234.56. The stamped transaction currency comes from the currency column/default (CURR-043), NOT from the symbol in the amount cell.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Imports/ParserToleranceTests.cs)

### CURR-049 - An off-list ISO currency in the CSV currency column is honoured and renders correctly
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** CSV whose Currency column contains `KWD` (3-decimal, off the 24-code picker).
- **Steps:**
  1. Map the currency column and commit; view the row in `/transactions`.
- **Expected:** `ResolveCurrency` accepts any `^[A-Za-z]{3}$` code (uppercased) → the transaction is stamped KWD even though the UI never offers KWD; the register renders it with three decimals (e.g. `KWD 1,234.567` / with symbol where Intl has one). If the row's currency ≠ the EUR month base, FX resolves per CURR-044/045.
- **Automated:** Partial (tests/AllotJar.Application.Tests/Imports/GenericCsvImporterTests.cs — currency code parsing)

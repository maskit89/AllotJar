# Currency & Locale Matrix

**ID prefix:** CURR | **Scope:** The whole-app behaviour of the ~24 supported currencies and the 5 number-format presets, treated as a cross-feature matrix rather than one page at a time. Covers: the curated `CURRENCY_OPTIONS` shortlist and the engine's "any 3 letters" tolerance; per-currency fraction digits (0-dp JPY, 2-dp majors, 3-dp KWD/BHD reached via API); the comma-dot ↔ dot-comma ↔ space-comma ↔ apostrophe ↔ lakh grouping styles and the fact that each preset also drives **symbol position** (prefix vs suffix) uniformly across EVERY money surface (budget lines, transactions, transfers, jars, allocation, import sums, reports, account balances/detail, the AppShell chip, delete/confirm dialogs); the **three coexisting currency sources** in one household (`month.baseCurrency` = EUR always → dashboard/register/reports; `preferredCurrency` → jars page, allocation page, account-add default, chip, import default stamp; per-`account.currency` → account cards/hero) and how a preference change relabels each with NO FX conversion; mixed per-account currencies (raw-summed accounts hero with a footnote, per-currency-grouped import totals, the cross-currency transfer guard, the EUR-hardcoded allocation transfer, the month-base vs account-currency stamping mismatch); and locale-formatted import files. **Out of scope (owned by sibling files, referenced not repeated):** the signup currency/format pickers and locale pre-selection — `02-registration-login.md` (REG-030..035); the `/account` preferences save mechanics, relabel-not-convert, blank-means-leave-as-is, second-tab lag — `04-account-preferences.md` (PREF-011..021); per-account currency display, the mixed hero, reconciliation cells, server currency validation — `12-accounts-reconciliation.md` (ACCT-005/008/009/021/035/036/037/038/040/049/057); transfer amount parsing and the base cross-currency guard — `11-transfers.md` (TRF-016/017/021/022); the dashboard hero currency-aware noun/symbol/digits — `06-dashboard-budget-view.md` (DASH-021/039); reports formatting in the breakdown month's currency — `18-reports.md` (RPT-035); the end-to-end multi-currency journey — `20-journeys.md` (JRN-011). Transactions- and import-page money-input parsing that is purely on-page also lives in those suites when written; here we assert only the cross-surface invariants.

**Test data setup:** Unless a case says otherwise, assume a beta build (`app.allotjar.com`) with all feature flags ON, including `multiCurrency` (so the account currency picker renders). Shared personas: **(A) "Euro soul"** — a default account: `preferredCurrency = EUR`, `numberFormat = comma-dot` (renders `en-GB`: `€1,234.56`). **(B) "Dollar/dot-comma"** — `preferredCurrency = USD`, `numberFormat = dot-comma` (renders `de-DE`: `1.234,56 $`). **(C) "Mixed household"** — one household, `multiCurrency` on, three accounts created via the Add-account modal: `EUR "Joint"` (opening 1,250.00), `GBP "UK Savings"` (opening 800.00), `JPY "Tokyo Cash"` (opening 90,000). All months in every persona have `BaseCurrency = EUR` (there is no path that sets a month base otherwise). Amounts are integer minor units at scale 4 client-side, `decimal(18,4)` server-side; `ExchangeRate` is 1 app-wide outside statement imports.

---

## The currency shortlist & the per-currency symbol/digit matrix

### CURR-001 - Every one of the 24 curated currencies formats with its correct symbol, position and fraction digits
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Persona A signed in; the 24-entry `CURRENCY_OPTIONS` list (`client/src/lib/money.ts:69-94`).
- **Steps:**
  1. For each currency code in `CURRENCY_OPTIONS` (EUR, GBP, USD, CHF, CAD, AUD, NZD, JPY, INR, SGD, HKD, SEK, NOK, DKK, PLN, CZK, HUF, RON, ZAR, BRL, MXN, AED, SAR, TRY), drive a surface that formats in that code — most directly, create an account of that currency (Add account → "Currency" select → the option, opening `1234.5`) and read its card balance; or set it as `preferredCurrency` and read the Jars "Total saved".
  2. Compare the rendered string against `Intl.NumberFormat('en-GB', {style:'currency', currency})` (the comma-dot default locale).
- **Expected:** Each renders with that currency's ISO symbol/label and its natural minor-unit digit count: EUR `€1,234.50`, GBP `£1,234.50`, USD `$1,234.50`, JPY `JP¥1,235` (0 dp), INR `₹1,234.50`, CHF `CHF 1,234.50`, HUF `Ft 1,234.50`, etc. No option renders raw minor units, and no code is silently coerced to EUR. The picker's label glyph (e.g. "Turkish lira (₺)") matches the symbol Intl emits.
- **Automated:** Partial (`client/src/lib/money.test.ts` — "formatting with budget currency + per-currency natural fraction digits", "currency symbol independent of number format"; the full 24-code sweep is manual)

### CURR-002 - Currency noun matrix drives the "give every ___ a job" tagline for all 24 codes plus the unit fallback
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Persona A; `currencyNoun` map (`money.ts:102-133`). Note the tagline on the dashboard reads `currencyNoun(month.currency)` (EUR today), while the login/landing footer reads the locale-detected noun and onboarding uses `currencyNoun(month.currency)` too — this case verifies the map itself.
- **Steps:**
  1. Enumerate `currencyNoun` for every `CURRENCY_OPTIONS` code and confirm the singular noun.
  2. Call `currencyNoun('ZZZ')`, `currencyNoun('')`, `currencyNoun(null)`.
- **Expected:** EUR→euro, GBP→pound, USD/CAD/AUD/NZD/SGD/HKD→dollar, CHF→franc, JPY→yen, INR→rupee, SEK→krona, NOK/DKK→krone, PLN→złoty, CZK→koruna, HUF→forint, RON→leu, ZAR→rand, BRL→real, MXN→peso, AED→dirham, SAR→riyal, TRY→lira. Unknown/blank/null → `unit`. Input is trimmed and upper-cased before lookup.
- **Automated:** Yes (`client/src/lib/money.test.ts` — "currencyNoun tagline nouns + unit fallback")

### CURR-003 - A zero-decimal currency (JPY) renders with no decimal places on every money surface, not just /account
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Persona set to `preferredCurrency = JPY`; the Mixed household's "Tokyo Cash" JPY account exists; a month with income/expense/jar lines. (`04-account-preferences.md` PREF-013 already covers JPY 0-dp on `/account` only.)
- **Steps:**
  1. Visit `/jars` (formats in `preferredCurrency` = JPY): read "Total saved" and a jar card "¥X of ¥Y".
  2. Visit `/allocation`: read "Income to allocate" and a step total.
  3. Visit `/accounts` → open "Tokyo Cash" (`/accounts/:id`): read the account hero and any JPY-stamped rows.
- **Expected:** Every JPY figure renders with 0 fraction digits (`JP¥1,235`, never `JP¥1,234.56`). The editable/plain representations never inject `.00`. Amounts are still stored at scale 4 internally; only the display truncates to the currency's ISO digit count.
- **Automated:** Partial (`client/src/lib/money.test.ts` — per-currency fraction digits, JPY specifically; the cross-surface sweep is manual)

### CURR-004 - A three-decimal currency (KWD/BHD) reached via the API renders 3 fraction digits though storage is scale 4
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** A currency the picker does NOT list but the engine accepts. Set it via `PUT /api/auth/preferences {preferredCurrency:"KWD"}` (server accepts any `^[A-Z]{3}$`, `CurrencyCode.From`), or create an account with currency `KWD` via `POST /api/accounts` (the picker won't offer it, but the API validator accepts any 3 letters).
- **Steps:**
  1. Enter a jar target of `1.2345` (scale-4) for a KWD-preference persona, or an opening balance `1.2345` on a KWD account.
  2. Read the rendered figure.
- **Expected:** `Intl.NumberFormat(locale, {style:'currency', currency:'KWD'})` renders 3 fraction digits, e.g. `KWD 1,234.500` for 1234.5; the 4th stored decimal is not shown. No crash; the shortlist picker still shows only its 24 codes, so this state is only reachable via API/preference injection.
- **Automated:** No

### CURR-005 - An unknown-but-well-formed ISO code (ZZZ/XXX) renders the code as its own symbol with the "unit" noun, and euro stays the default soul
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** `preferredCurrency = ZZZ` set via `PUT /api/auth/preferences` (any 3 letters pass — see `02-registration-login.md` REG-034 / `04-account-preferences.md` PREF-014).
- **Steps:**
  1. Read a `preferredCurrency`-formatted surface (Jars "Total saved", Allocation hero, the AppShell chip).
  2. Read a `month.baseCurrency` surface (dashboard hero).
- **Expected:** `Intl.NumberFormat` does not throw for the well-formed code; it renders the code itself as the symbol (`ZZZ 1,234.56`, 2 default fraction digits) on `preferredCurrency` surfaces, and the tagline noun is `unit`. Meanwhile every `month.baseCurrency` surface still shows `€` (the euro soul), since the month base is EUR regardless of the garbage preference. No blank symbol, no NaN.
- **Automated:** Partial (`client/src/lib/money.test.ts` — unknown code falls back to en-GB default digits; "unit" noun fallback)

---

## Number-format preset ↔ currency independence (grouping + symbol position)

### CURR-006 - The number-format preset is orthogonal to the currency — every combination renders correctly
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ability to set `numberFormat` (comma-dot/dot-comma/space-comma/apostrophe/lakh) and `preferredCurrency` independently on `/account`.
- **Steps:**
  1. Set EUR + dot-comma; read a `preferredCurrency` surface (Jars "Total saved" with 1234.56).
  2. Set USD + comma-dot; read the same.
  3. Set EUR + space-comma, then EUR + apostrophe, then INR + lakh.
- **Expected:** EUR+dot-comma → `1.234,56 €`; USD+comma-dot → `$1,234.56`; EUR+space-comma → `1 234,56 €` (NBSP group); EUR+apostrophe → `€1'234.56`; INR+lakh → `₹1,23,456.78` for 123456.78. The grouping/decimal glyphs come purely from the format preset (`FORMAT_LOCALES`, `money.ts:46-52`); the symbol/digit count comes purely from the currency. The two never interfere.
- **Automated:** Partial (`client/src/lib/money.test.ts` — setMoneyFormat de-DE/en-GB/fr-FR/de-CH/en-IN groupings; symbol independent of number format)

### CURR-007 - The chosen format preset also flips the currency symbol between prefix and suffix, uniformly on every surface
- **Priority:** P1
- **Type:** Regression
- **Origin:** Locale-driven `Intl` symbol placement — dot-comma (`de-DE`) and space-comma (`fr-FR`) suffix the symbol; comma-dot (`en-GB`), apostrophe (`de-CH`) and lakh (`en-IN`) prefix it.
- **Preconditions:** Persona A; a fully-populated month (income, expense, savings lines, a jar, a shared household with allocation, some transactions).
- **Steps:**
  1. With comma-dot, snapshot the dashboard hero, a budget line, the Transactions register amount, the Jars page, the Allocation hero, and the Reports hero.
  2. On `/account`, switch "Number format" to `1.234,56` (dot-comma), Save, and re-read every surface without a reload.
- **Expected:** With comma-dot the symbol is a **prefix** everywhere (`€1,234.56`); after switching to dot-comma it becomes a **suffix** everywhere (`1.234,56 €`) — dashboard, budget lines, register, jars, allocation, reports all flip together in the same session (`setMoneyFormat` sets a module-level `activeLocale` applied app-wide). No surface is left on the old placement; the underlying digits are unchanged (no FX).
- **Automated:** Partial (`client/src/lib/money.test.ts` covers the format→locale mapping; the cross-surface symbol-position flip is manual — no e2e asserts it)

### CURR-008 - One format token renders identically across ALL money surfaces in a single session (consistency sweep)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Persona A switched to `numberFormat = apostrophe` (de-CH, `1'234.56`); Mixed household so accounts, transfers, import and allocation are all reachable; `camtImport` on.
- **Steps:**
  1. Read every money-bearing surface in one session: dashboard hero + budget/bill/savings lines; Transactions register + hero "Money in/out"; the transfer modal preview; `/accounts` hero + cards; `/accounts/:id` hero + register; `/jars` hero + cards; `/allocation` hero + waterfall steps + per-member tiles; `/reports` hero + trend titles + breakdown rows; the import review table + the "Import complete" tiles; the AppShell chip.
- **Expected:** Wherever a grouped decimal appears it uses the apostrophe group and dot decimal (`1'234.56`); no surface falls back to `en-GB` commas. The only text that is not a grouped decimal is the raw preference code in the chip (`CHF · Household`) and any 0-dp/3-dp currency truncation. There is exactly one active locale per session.
- **Automated:** No

### CURR-009 - Space-comma (NBSP), apostrophe and lakh grouping survive on a large income figure across surfaces
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** A month with a large income line planned at 1234567.80 (income figures are the largest in a budget); persona toggled between the three presets.
- **Steps:**
  1. With space-comma, read the income line, the hero "Income", and the allocation "Income to allocate".
  2. Switch to lakh; re-read.
  3. Switch to apostrophe; re-read.
- **Expected:** space-comma → `1 234 567,80` (each group a NBSP, not a normal space; the parser later strips both); lakh → `12,34,567.80` (Indian grouping — 2-digit groups after the first 3); apostrophe → `1'234'567.80`. The grouping is consistent on every surface for the chosen preset.
- **Automated:** Partial (`client/src/lib/money.test.ts` — en-IN lakh + fr-FR + de-CH groupings on formatting)

### CURR-010 - Money display and money input use different formatters — the display shows the symbol, the inline editor shows a plain decimal
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Persona A on the dashboard; a planned amount click-to-edit control ("Planned amount for {name}").
- **Steps:**
  1. Read a planned line's display: `formatMoney` with the symbol.
  2. Click the amount to open the inline editor; read the input's value.
- **Expected:** The display carries the currency symbol and grouping (`€1,100.00`); the editable input is seeded via `toEditString` — a plain non-localized decimal (`1100`) with no symbol and no grouping, so the user edits an unambiguous number. Committing re-renders through `formatMoney`. (Note: `formatPlain` — a grouped-no-symbol formatter — exists in `money.ts` but is not wired to any surface today; do not test it as user-facing.)
- **Automated:** Partial (`client/src/lib/money.test.ts` — plain editable string round-trip; `client/src/pages/DashboardPage.test.tsx` — optimistic planned edit)

---

## Format-agnostic input parsing across every money input

### CURR-011 - Amount inputs accept BOTH "1,234.56" and "1.234,56" regardless of the user's display preference
- **Priority:** P0
- **Type:** Boundary
- **Preconditions:** Persona B (dot-comma display); every money input reachable (budget planned, transaction amount, transfer amount, jar target/opening, account opening, split slice, import split, allocation pocket money/lean).
- **Steps:**
  1. As the dot-comma user, into each input type `1,234.56` (comma-group/dot-decimal — the "wrong" style for their preference) and commit; separately type `1.234,56` (their own style).
  2. Read back the committed value on each surface.
- **Expected:** Both inputs resolve to the same 1234.56 (12,345,600 minor units) on every surface — `parseMinor` (`money.ts:264-299`) resolves the decimal by the **right-most** separator and strips the other as grouping, independent of `activeLocale`. The user's display preference constrains OUTPUT only, never INPUT. No surface rejects the non-preferred style.
- **Automated:** Partial (`client/src/lib/money.test.ts` — parseMinor accept table incl. both styles; per-surface pins exist in `11-transfers.md` TRF-016, `12-accounts-reconciliation.md` ACCT-012, `06-dashboard-budget-view.md` DASH-039, `13-jars.md` JAR-029)

### CURR-012 - More than four decimal places rounds half-up to scale 4 uniformly on every money input
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Any money input.
- **Steps:**
  1. Enter `1.23445` and `1.23455` into a planned amount, a transaction amount, a jar target, and an account opening balance.
- **Expected:** Each parses to scale-4 with half-up rounding on the 5th digit: `1.23445` → 1.2345 (12,345 ten-thousandths → since 4th digit region: 1.2344|5 rounds the 4-dp value up to 1.2345), `1.23455` → 1.2346. Identical rounding on every surface (single `parseMinor` engine). No floating-point drift.
- **Automated:** Partial (`client/src/lib/money.test.ts` — >4 dp rounds half-up)

### CURR-013 - A single separator is always the decimal point, even when it contradicts the user's grouping preference
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Persona A (comma-dot) and Persona B (dot-comma).
- **Steps:**
  1. As each persona, type `1234,5` (single comma) and `1234.5` (single dot) into a transaction amount.
- **Expected:** Both resolve to 1234.5 for both personas — with only one separator present, `parseMinor` treats it as the decimal separator (`,`→`.`), regardless of whether the persona's preset uses that glyph for grouping. `1.234` (single dot) is 1.234, NOT 1234. (This is the documented single-separator convention; multi-group inputs like `1.234.567` fail the strict check and revert.)
- **Automated:** Partial (`client/src/lib/money.test.ts` — parseMinor accept/reject table)

### CURR-014 - Grouping glyphs are stripped and malformed multi-separator inputs revert, with no partial money committed
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Any money input.
- **Steps:**
  1. Enter `1 234,56`, `1'234.56`, `1 234 567,80` (NBSP) — all valid grouped forms.
  2. Enter `1.2.3`, `1,2,3`, `-5`, `` (empty), `abc`.
- **Expected:** Spaces (incl. NBSP), straight and curly apostrophes are stripped first, so the grouped forms parse cleanly. The malformed/negative/empty/non-numeric inputs return null → the field reverts to its prior value silently with no API call and no zero written. A negative amount is never accepted (all money inputs are positive; direction is separate).
- **Automated:** Partial (`client/src/lib/money.test.ts` — rejects `''`/`-5`/`abc`/`1.2.3`/`1,2,3`)

---

## The three currency sources — cross-surface display split

### CURR-015 - Same household, same session: preferred-currency surfaces show the picked symbol while month-base surfaces show euro
- **Priority:** P1
- **Type:** Regression
- **Origin:** Three coexisting currency sources — `preferredCurrency` (`JarsPage.tsx:88`, `AllocationPage.tsx:46`, AppShell chip, account-add default, import default stamp) vs `month.baseCurrency` (always EUR — `CreateBudgetMonthCommandHandler.cs:95`, never seeded from the user's preference) vs `account.currency`.
- **Preconditions:** Persona B: `preferredCurrency = USD`, on a populated month whose `BaseCurrency = EUR`.
- **Steps:**
  1. Read `/jars` "Total saved" and `/allocation` "Income to allocate" and the AppShell chip.
  2. Read the dashboard hero + a budget line, the `/transactions` register amounts, and the `/reports` hero.
- **Expected:** Jars page, Allocation page and the chip show **USD** (`$`, or `USD` in the chip text); the dashboard, transactions register and reports show **EUR** (`€`, tagline "give every euro a job") — because those surfaces format in `month.baseCurrency`/`t.currency`, which is EUR and is never derived from the preferred currency. This split is the current, verifiable behaviour (a known display-consistency gap, not FX). QA should record both symbols in one session.
- **Automated:** No

### CURR-016 - Changing the preferred currency relabels the preferred-currency surfaces only, with identical digits (no FX)
- **Priority:** P0
- **Type:** Regression
- **Origin:** No-FX relabel — `ExchangeRate` is 1 app-wide; a currency change is a label swap. (`04-account-preferences.md` PREF-011 covers the `/account` relabel; this asserts the cross-surface ripple.)
- **Preconditions:** Persona A (EUR) with a jar "Total saved" of `€2,480.00` and an allocation "Income to allocate" of `€3,000.00`.
- **Steps:**
  1. On `/account`, change "Currency" from `Euro (€)` to `US dollar ($)`, Save.
  2. Re-read `/jars` and `/allocation` (preferred-currency surfaces) and the dashboard hero (month-base surface).
- **Expected:** Jars now reads `$2,480.00` and allocation `$3,000.00` — the exact same digits, only the symbol changed; no value was multiplied by any rate. The dashboard hero is UNCHANGED (`€…`) because it formats in `month.baseCurrency`. The change is display-only and instant, no reload.
- **Automated:** Partial (`client/src/lib/money.test.ts` — symbol independent of number format underpins the no-convert relabel; the multi-surface ripple is manual)

### CURR-017 - Reports follow the breakdown month's base currency, not the preferred currency; changing the preference never relabels reports
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Persona B (USD preference); `/reports` with data. `ReportsPage` formats in `breakdownMonth.baseCurrency ?? 'EUR'` (`ReportsPage.tsx:85`), which is EUR.
- **Steps:**
  1. On `/reports`, read the hero "Saved this month", "Avg monthly spend", the Annual table and the "Spending by category" rows.
  2. On `/account`, change the preferred currency to a different code; return to `/reports`.
  3. (If a household ever had a non-EUR-base month) select a breakdown month with a different `baseCurrency` in the "Breakdown month" select.
- **Expected:** All Reports cards format in EUR regardless of the USD preference (they use the month base, not the preference); the preference change does not touch Reports. Selecting a breakdown month whose `baseCurrency` differs would re-label ALL cards to that month's currency (annual totals included) — but since every month is EUR-based today, in practice reports stay EUR. Until the breakdown month loads, the transient fallback is EUR too.
- **Automated:** Partial (`client/src/pages/ReportsPage.test.tsx` — breakdown month select; `18-reports.md` RPT-035 owns the page-currency behaviour)

### CURR-018 - The AppShell chip shows the raw preferred-currency code, and it tracks a preference change
- **Priority:** P3
- **Type:** Happy
- **Preconditions:** Persona A; the user-chip menu (aria-label "Account menu").
- **Steps:**
  1. Read the chip subtitle: `{preferredCurrency} · {household label}`.
  2. Change the preferred currency on `/account` and re-read.
- **Expected:** The chip shows the literal 3-letter code (`EUR · Your household`), not a symbol; after the change it shows the new code (`USD · Your household`). This is the one place the raw code text is surfaced.
- **Automated:** No

### CURR-019 - Delete/confirm dialogs deliberately carry no money, so there is no unformatted-amount leak
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Persona A with an account holding a non-zero balance, a budget line, a jar, a transaction.
- **Steps:**
  1. Open the account delete-confirm ("Delete {name}?"), the group inline delete confirm, the jar archive confirm ("Really archive?").
  2. Delete a transaction (no confirmation exists) and a budget line.
- **Expected:** No confirm dialog renders any money value — the account modal shows only the name in the title and the "transactions are kept" copy (`12-accounts-reconciliation.md` ACCT-028), never the balance/currency; jar and group confirms show only names. There is therefore no surface where an amount could render in the wrong currency or unformatted at delete time.
- **Automated:** Partial (`client/src/pages/AccountsPage.test.tsx` — delete-confirm shows the name; `client/src/pages/DashboardPage.test.tsx` — group delete confirm)

---

## Mixed per-account currencies in one household

### CURR-020 - Three-currency household: each account card and detail hero renders in its own currency
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Persona C (Mixed household: EUR "Joint", GBP "UK Savings", JPY "Tokyo Cash"); `multiCurrency` on.
- **Steps:**
  1. On `/accounts`, read the three cards' balances and "Opening" captions.
  2. Open each account (`/accounts/:id`) and read its hero amount.
- **Expected:** "Joint" → `€1,250.00`, "UK Savings" → `£800.00`, "Tokyo Cash" → `JP¥90,000` (0 dp) — each in `a.currency`, with the correct symbol, grouping (per the active format preset) and per-currency digit count. A currency chip ("EUR"/"GBP"/"JPY") shows on each card. Currency is immutable on edit (a read-only note; `12-accounts-reconciliation.md` ACCT-021).
- **Automated:** Partial (`client/src/pages/AccountsPage.test.tsx`, `AccountDetailPage.test.tsx` — per-account balance rendering; `12-accounts-reconciliation.md` ACCT-036 owns per-account display)

### CURR-021 - The accounts hero raw-sums mixed currencies and flags it in the preferred currency (deferred no-FX)
- **Priority:** P1
- **Type:** Regression
- **Origin:** Deferred FX — `AccountBalances` and the hero raw-sum across currencies; hero label = `preferredCurrency` when currencies diverge, plus a footnote (`AccountsPage.tsx:181-211`).
- **Preconditions:** Persona C (EUR preference); the three accounts above.
- **Steps:**
  1. Read the `/accounts` hero "Total balance", "Available", "Owed" and the footnote.
- **Expected:** The three balances are summed as raw minor units with NO conversion (`1250 + 800 + 90000` in ten-thousandths, mixing EUR/GBP/JPY as if one number — a deliberately meaningless figure), formatted in `preferredCurrency` (EUR), with the footnote "Totals shown in {heroCurrency}; some accounts hold another currency." (heroCurrency = EUR here). If all three accounts shared one currency the hero would use that currency and drop the footnote. This documents current deferred behaviour; do not expect real FX.
- **Automated:** Partial (`12-accounts-reconciliation.md` ACCT-035/037; `tests/AllotJar.Application.Tests/Application/AccountsTests.cs` — derivation)

### CURR-022 - Cross-currency transfer guard across the three-currency household (which pairs are allowed)
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** Persona C; a second EUR account "Joint 2" added so a same-currency pair exists; `POST /api/transactions/transfer`.
- **Steps:**
  1. In the "Record a transfer" modal, attempt EUR "Joint" → GBP "UK Savings"; then EUR "Joint" → JPY "Tokyo Cash"; then GBP → JPY.
  2. Attempt EUR "Joint" → EUR "Joint 2" (same currency, different accounts).
- **Expected:** Every cross-currency pair is rejected with the handler ValidationException keyed `ToAccountId`: "Both accounts must use the same currency to transfer between them." and moves nothing (`CurrencyCode` value-equality guard, PR #167). The same-currency pair succeeds, the row is stamped in the source account's currency (EUR), `ExchangeRate = 1`. (`11-transfers.md` TRF-021/022 own the two-account base cases; this is the 3-currency pair matrix.)
- **Automated:** Yes (`tests/AllotJar.Application.Tests/Transactions/TransfersTests.cs` — "cross-currency transfer rejected and moves nothing", "currency stamped from source not hardcoded EUR")

### CURR-023 - A manual transaction is stamped in the month base (EUR), not the account currency — the account-detail mismatch
- **Priority:** P1
- **Type:** Regression
- **Origin:** Deferred quirk — manual create stamps `month?.BaseCurrency ?? EUR` (`CreateTransactionCommandHandler.cs:87`), not the assigned account's currency; the detail register formats each row in `t.currency`.
- **Preconditions:** Persona C; the GBP "UK Savings" account; the current month `BaseCurrency = EUR`.
- **Steps:**
  1. Add a manual expense of `50.00` on `/transactions`, assign it to the "UK Savings" (GBP) account.
  2. Read the row on `/transactions`; open `/accounts/UK-Savings` and read the account hero vs the register row.
- **Expected:** The transaction row displays `€50.00` (stamped EUR from the month base), while the account hero shows the balance in GBP (`£…`). The account balance derivation sums the raw amount (50) into the GBP ledger regardless of the stamped EUR — so the number moves the balance but the row's symbol (€) mismatches the account's (£). This is documented deferred behaviour (accounts map §7); record the mismatch, do not treat it as a new bug.
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Transactions/BudgetActualsTests.cs`, `AccountsTests.cs` — derivation ignores currency; the display mismatch itself is manual)

### CURR-024 - Cross-currency arithmetic is forbidden in the domain Money type (server safety net)
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Server domain `Money` value object.
- **Steps:**
  1. Attempt to add two `Money` values of different `CurrencyCode` in any handler path that constructs them.
- **Expected:** Adding/subtracting across currencies throws (Money enforces same-currency). This guards budget totals from silently mixing currencies at the domain layer even though the account/hero raw-sums bypass Money (they sum minor-unit primitives, a deliberate deferral). `RemainingToBudgetMoney` carries the month's `BaseCurrency`.
- **Automated:** Yes (`tests/AllotJar.Application.Tests/Domain/MoneyTests.cs` — "cross-currency add throws"; `CurrencyCodeTests.cs` — normalise/reject/equality/EUR default)

---

## Import & allocation currency handling

### CURR-025 - Import "Number format" control parses locale-formatted amount columns independent of the user's display preference
- **Priority:** P1
- **Type:** Boundary
- **Preconditions:** Persona A (comma-dot display); `/import`, "Bank CSV (auto-detect)"; a generic CSV whose amounts are de-DE formatted (`1.234,56`, `-45,30`).
- **Steps:**
  1. Upload; in the "Column mapping" card set "Number format" to `1.234,56` (or leave "Auto-detect"), re-scan.
  2. Read the parsed amounts in the review table.
- **Expected:** The server's `GenericCsvImporter` parses `1.234,56` → 1234.56 and `-45,30` → 45.30 debit (decimal style Dot/Comma/Auto; both-separator right-most-is-decimal; single-separator decimal only with 1–2 trailing digits else grouping). The display in the review table then formats in the user's comma-dot preference (`1,234.56`), so the on-disk locale and the display locale are decoupled. Auto-detect resolves one decimal style per file.
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Imports/GenericCsvImporterTests.cs` — "chosen decimal style honored [Theory]"; `ParserToleranceTests.cs` — trailing-sign + comma decimals)

### CURR-026 - Import currency column vs the "Use {preferredCurrency} for every row" default stamp
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Persona B (USD preference); a generic CSV, once with a currency column (values `GBP`,`EUR`) and once without.
- **Steps:**
  1. Upload the file WITH a currency column; map "Currency column" to it; review.
  2. Upload the file WITHOUT one; leave "Currency column" on its first option "Use USD for every row".
- **Expected:** With the column, each row keeps its own 3-letter currency (uppercased; non-3-letter cells fall back). Without it, every row is stamped with the client-sent `defaultCurrency` = the user's `preferredCurrency` (USD here) — NOT EUR, and NOT the month base. The first select option label literally reads "Use USD for every row".
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Imports/ImportPreviewCommitTests.cs` — "generic CSV layout detection + default currency stamp"; `GenericCsvImporterTests.cs` — default currency without a currency column)

### CURR-027 - Import "Money in/out" totals are grouped per currency and joined with " + " for a mixed-currency file
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** `/import`; a file (or reviewed rows) carrying at least two currencies (e.g. EUR credits + GBP debits) — the ONE surface that truly groups net footers per currency (`ImportPage.tsx:140-150,1174-1179`).
- **Steps:**
  1. Review a mixed-currency statement; commit.
  2. Read the "Import complete" tiles "Money in" and "Money out".
- **Expected:** Each tile sums the included, non-transfer rows in minor units **per currency** and renders `formatMoney(minor, currency)` for each group joined by " + " (e.g. `€2,500.00 + £120.00`). Zero groups render as `formatMoney(0, preferredCurrency)`. "Transfers" stays a plain count. This is the accurate "net footers grouped per currency" behaviour (contrast the accounts hero, which raw-sums — CURR-021).
- **Automated:** Partial (`client/src/pages/ImportPage.test.tsx` — success shows real money sums, PR #160; `client/e2e-journey/import.spec.ts` — real `Money in 2,500.00`/`Money out 46.30`, single-currency)

### CURR-028 - Allocation commit hard-codes EUR on the transfer rows regardless of household/account currency
- **Priority:** P1
- **Type:** Regression
- **Origin:** Deferred systemic label limit — `AllocateIncomeCommandHandler.cs:71` stamps `Currency = CurrencyCode.Eur` on every allocation transfer.
- **Preconditions:** Persona B (USD preference) shared household; a GBP source account and GBP member savings accounts; a saved allocation profile with members holding residuals.
- **Steps:**
  1. On `/allocation`, read the preview (formats in `preferredCurrency` = USD).
  2. Click "Allocate {month}" to commit; then open a member's savings account (`/accounts/:id`) and read the created transfer row; and read the transfer on `/transactions`.
- **Expected:** The allocation preview shows USD (`$`), but each committed transfer row (`Payee "Income allocation — {name}"`, `BankReference "alloc:{year}-{month}:{memberId}"`) is stamped **EUR** and displays `€…` on the register — a documented display-only mismatch (the amounts and re-run idempotency are correct; only the currency label is EUR). Do not file as new.
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Application/AllocationTests.cs` + `tests/AllotJar.IntegrationTests/AllocationRerunTests.cs` — transfers created + idempotent; the EUR stamp is asserted implicitly, the display mismatch is manual)

---

## Locale defaults, the euro soul & preference propagation

### CURR-029 - Browser-locale detection pre-selects a supported currency + format at signup, always overridable, euro as the floor
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Anonymous visitor at `/login?register=1` under different `navigator.language` values (`detectLocaleDefaults`, `money.ts:145-195`). (`02-registration-login.md` REG-031 owns the signup form pre-selection; here we pin the detection matrix.)
- **Steps:**
  1. Load the register tab with `en-US`, `de-DE`, `en-IN`, `de-CH`, `fr-FR`, and an unmapped locale (e.g. `xx`).
- **Expected:** `en-US`→USD + comma-dot; `de-DE`→EUR + dot-comma; `en-IN`→INR + lakh; `de-CH`→CHF + apostrophe; `fr-FR`→EUR + space-comma; unmapped/absent `navigator`→EUR + comma-dot (the euro/`en-GB` floor). Region→currency uses the 24-entry `REGION_CURRENCY` map (unlisted → EUR); format uses IN→lakh, CH/LI→apostrophe, else inferred from the locale's group/decimal glyphs. The "Give every {noun} a job" footer noun follows the detected currency.
- **Automated:** Yes (`client/src/lib/money.test.ts` — "detectLocaleDefaults returns supported currency + known format key")

### CURR-030 - Before /auth/me resolves, money renders in the euro/en-GB soul, then swaps to the saved preference with no persisted flash
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Persona B (USD + dot-comma) on a cold hard reload; `activeLocale` defaults to `en-GB` until `setMoneyFormat` runs (on mount from the `zbb.numberFormat` hint, then again on `/auth/me`).
- **Steps:**
  1. Hard-reload an authed page; observe the first paint's grouping/symbol placement then the settled state.
- **Expected:** The very first frames use the `en-GB` default locale (comma-dot, symbol prefix) only until the stored `zbb.numberFormat` hint is applied on mount; because the hint is read synchronously the user should not see a persisted flash of the wrong grouping (`04-account-preferences.md` PREF-017 pins "no flash of the default"). On logout the locale resets to the `en-GB` default. The currency symbol on month-base surfaces stays EUR throughout (the format changes, not the currency).
- **Automated:** Partial (`client/src/pages/AccountPage.test.tsx` / `client/src/auth/AuthContext.test.tsx` — prefs applied on load; the first-paint timing is manual)

### CURR-031 - A currency change never migrates existing stored data — months, transactions and jars keep their stored currency
- **Priority:** P1
- **Type:** Regression
- **Origin:** No-FX, no-migration — `preferredCurrency` is a user-preference label; stored `BudgetMonth.BaseCurrency`, `Transaction.Currency`, `Account.Currency` are independent and are not rewritten on a preference change.
- **Preconditions:** Persona A with an established EUR month, EUR-stamped transactions, and a EUR account.
- **Steps:**
  1. Change the preferred currency to USD on `/account`.
  2. Inspect the dashboard, the transactions register, the account card, and (via API) `GET /budget/{y}/{m}` `baseCurrency` and `GET /transactions` `currency`.
- **Expected:** `baseCurrency` stays `EUR`, transaction `currency` stays `EUR`, account `currency` stays `EUR` — no stored value changes. The dashboard/register still show €; only `preferredCurrency`-driven surfaces (jars page, allocation, chip, account-add default) show $. A preference change is purely cosmetic on its own surfaces and touches no persisted money.
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Infrastructure/UserPreferencesTests.cs` — preference normalisation; stored-data invariance across a preference change is manual)

### CURR-032 - Number-format preference propagates to a second tab only on its next /auth/me; currency symbol source is unaffected
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Persona A signed in in two tabs of the same browser.
- **Steps:**
  1. In tab 1, change "Number format" to dot-comma and Save.
  2. Read tab 2 immediately, then trigger a `/auth/me` in tab 2 (focus/refetch).
- **Expected:** Tab 2 keeps the old grouping until its next `/auth/me` re-runs `setMoneyFormat` (`04-account-preferences.md` PREF-019 owns this). Both tabs' month-base surfaces stay EUR throughout; only the grouping/symbol-position lags in tab 2. No cross-tab money corruption.
- **Automated:** Partial (`04-account-preferences.md` PREF-019 references the same behaviour)

---

## Server-side currency validation & storage

### CURR-033 - Server accepts any 3-letter code and normalises it; rejects non-3-letter across registration, preferences and accounts
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** `POST /api/auth/register`, `PUT /api/auth/preferences`, `POST /api/accounts` — all funnel currency through `CurrencyCode.From` / the account validator regex.
- **Steps:**
  1. Submit `eur` (lowercase), ` gbp ` (padded), `xxx` on each endpoint.
  2. Submit `EU`, `EURO`, `12A`, empty.
- **Expected:** Case/whitespace are normalised to upper-trimmed 3-letter (`eur`→`EUR`); any well-formed 3-letter code passes (no ISO allowlist — `XXX` is accepted). Non-3-letter/blank on register/preferences → 400 `{error:"That isn't a valid ISO 4217 currency code."}` (blank currency falls back to EUR on register/preferences per UserPreferences); on accounts → 400 "Currency must be a 3-letter ISO 4217 code." The engine's tolerance is intentional; the picker's 24-code shortlist is the only curation.
- **Automated:** Yes (`tests/AllotJar.Application.Tests/Domain/CurrencyCodeTests.cs`, `Infrastructure/UserPreferencesTests.cs`; `12-accounts-reconciliation.md` ACCT-057, `02-registration-login.md` REG-033/034)

### CURR-034 - Blank currency/number-format on a preferences save means "leave as is", never a reset to EUR/comma-dot
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Persona B (USD + dot-comma) doing a name-only save.
- **Steps:**
  1. `PUT /api/auth/preferences` with `preferredCurrency` and `numberFormat` blank but first/last name set.
- **Expected:** The blank currency/format are ignored (a name-only save cannot reset them, `AuthController.cs:390-403`); the user keeps USD + dot-comma. Contrast the register path, where blank currency falls back to EUR and blank format to comma-dot. (`04-account-preferences.md` PREF-021 owns this; included here to close the currency-source matrix.)
- **Automated:** Partial (`client/src/pages/AccountPage.test.tsx` — save prefs; `04-account-preferences.md` PREF-021)

### CURR-035 - Every month is EUR-based today: there is no in-app or API path to a non-EUR budget month
- **Priority:** P2
- **Type:** Regression
- **Origin:** `CreateBudgetMonthCommandHandler.cs:95` sets `BaseCurrency = previous?.BaseCurrency ?? EUR`; no seeder/bootstrap/endpoint ever writes a non-EUR month base, so the chain can never leave EUR.
- **Preconditions:** Any persona, including one who signed up with a non-EUR preferred currency and opted into the sample budget.
- **Steps:**
  1. As a USD-preference user, register with sample data; create further months (blank, copy, template).
  2. Inspect `GET /budget/{y}/{m}` `baseCurrency` for each.
- **Expected:** Every month — the seeded sample month and every subsequently created month — has `baseCurrency = "EUR"`. The user's preferred currency never reaches the month base; there is no UI or request field to set it. Consequently the dashboard, register and reports render in EUR for everyone until (if ever) FX/base-currency selection ships. Record this as the current invariant so a future base-currency feature does not regress silently.
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Application/CreateBudgetMonthTests.cs` — copy/blank/template paths; the EUR-base invariant is implied, not asserted as a dedicated case)

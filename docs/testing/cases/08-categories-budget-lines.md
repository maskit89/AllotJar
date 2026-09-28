# Categories & budget lines
**ID prefix:** CAT | **Scope:** Category-group CRUD (create expense/savings groups, rename, delete — including groups holding lines and assigned transactions; the Income group being uncreatable and undeletable), budget-line CRUD (add/rename/delete lines including lines with assigned transactions), group- and line-level reordering + display-order persistence, savings lines and their backing-jar link (the `SavingsId` FK and the add-savings-line crash regression), and name-input boundaries (empty/whitespace/very-long/unicode/duplicate) with their exact validator messages. Covers both the Budget dashboard UI affordances (`CategoryAccordion`, `SavingsGroup`, `IncomeGroup`, `BudgetItemRow`, the "+ Add group" reveal) and the underlying `/api/budget/categories*` + `/api/budget/…/items*` endpoints. | **Out of scope:** month create/copy/template & the not-found create UI (see `07-month-lifecycle.md`); the Hero/remaining banner, bills strip, paid toggle, planned-amount editing semantics & tx-derived actuals (see `06-dashboard-budget-view.md`); jar shaping/accrual/archive, the "Your jars" shelf and `SavingsAvailable` vs `currentBalance` maths (see `13-jars.md`); role/permission matrix depth (see the auth/roles file); transactions & splits (see the transactions file).
**Test data setup:** Unless a case says otherwise, act as **Owner "Ana"** (household A, role Owner ⇒ `canWrite` + `canEnterData`) signed in, viewing **July 2026** (the current calendar month; `today = 2026-07-16`) which has a saved budget:
- **Income** group (Kind=Income, DisplayOrder 0) with one line **"Salary"**, planned €2,000.00.
- **"Housing"** expense group (Kind=Expense, DisplayOrder 0) with lines **"Rent"** (planned €900.00) and **"Utilities"** (planned €150.00).
- **"Savings"** group (Kind=Savings, DisplayOrder 0) with one jar-backed line **"Emergency Fund"** (planned €100.00, `SavingsId` → a real `Jars` row).
- Derived: TotalIncome €2,000.00, Allotted (planned) €1,150.00, RemainingToBudget €850.00, `IsBalanced=false`.
Also available: **"Blank July"** fixture — a freshly created blank month for a jar-less household (only the seeded Income group, no lines); **Owner "Bob"** (household B, separate `OwnerId`) for cross-owner checks; a **Limited** login and a **ReadOnly** login on household A. "Rent" has one assigned expense transaction of €900.00 for the delete-with-transactions cases. Money is `decimal(18,4)` server-side / integer minor units client-side; every mutating endpoint returns the full recomputed `BudgetMonthDto` (categories ordered Income→Expense→Savings, then `DisplayOrder`; items by `DisplayOrder`).

---

## Category group creation

### CAT-001 - Create an expense group appends it after existing expense groups
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026 (Housing = the only expense group, DisplayOrder 0).
- **Steps:**
  1. Scroll to the bottom of the budget and click **"+ Add group"** (aria "Add a group").
  2. In the revealed row type `Subscriptions` into the input (placeholder "Add a category group (e.g. Subscriptions, Insurance)…", aria "New category group name").
  3. Leave the kind `<select>` (aria "New group kind") on its default **Expense**.
  4. Click **"Add"** (aria "Add category group").
- **Expected:** A temp group appears instantly, then reconciles from `POST /api/budget/categories {budgetMonthId, name:"Subscriptions", isSavings:false}`. New group renders inside the "Everyday spending" card below Housing with `DisplayOrder = 1` (max same-kind order +1), empty ("No lines yet — add one below."), Kind Expense. TotalIncome/Allotted/Remaining unchanged (€2,000 / €1,150 / €850). The add row resets and collapses.
- **Automated:** Yes (`client/src/pages/DashboardPage.test.tsx` "adds a category group and reconciles from the server response"; `tests/AllotJar.Application.Tests/Application/BudgetCategoryCrudHandlerTests.cs` `Add_CreatesExpenseGroup_AppendedAfterExistingExpenses`)

### CAT-002 - Create a savings group
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026.
- **Steps:**
  1. Click **"+ Add group"**.
  2. Change the kind `<select>` to **Savings** — note the placeholder switches to "Add a savings group (e.g. Travel, Big purchases)…".
  3. Type `Travel` and click **"Add"**.
- **Expected:** `POST /api/budget/categories {name:"Travel", isSavings:true}` → server creates a **Savings**-kind group (`AddBudgetCategoryRequest.IsSavings` → `CategoryKind.Savings`, controller line 122). It renders as its own violet-dot `SavingsGroup` card below expenses with `DisplayOrder = 1` (Housing-independent per-kind ordering; Emergency Fund's "Savings" group is DisplayOrder 0), empty ("No savings goals yet — add one below."). Adding the *group* alone mints **no** jar (a jar is minted only when a *line* is added to it — see CAT-034).
- **Automated:** Yes (`DashboardPage.test.tsx` "creates a fund group when the kind is set to Fund"; `tests/AllotJar.Application.Tests/Application/SavingsTests.cs` "AddCategory can create a Fund group")

### CAT-003 - Cancel adding a group discards the draft
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Ana on July 2026.
- **Steps:**
  1. Click **"+ Add group"**, type `Insurance`.
  2. Click **"Cancel"** (aria "Cancel adding group") — or press **Escape** in the input.
- **Expected:** The row collapses back to the **"+ Add group"** button, the draft name is cleared, and **no** `POST` fires. No group is created.
- **Automated:** No

### CAT-004 - New-group name is empty/whitespace — client never submits
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Ana on July 2026.
- **Steps:**
  1. Click **"+ Add group"**.
  2. Leave the input blank (or type only spaces) and click **"Add"** / press Enter.
- **Expected:** `submitNewCategory` trims and returns early on empty (`DashboardPage.tsx:467-469`); **no** `POST` is sent, no group appears, no error strip. The row stays open. (Server-side, the same input would be rejected — see CAT-005.)
- **Automated:** No

### CAT-005 - API rejects a whitespace-only group name
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Direct `POST /api/budget/categories` (bypassing the client trim), Ana authenticated, valid `budgetMonthId`.
- **Steps:**
  1. `POST /api/budget/categories` with body `{budgetMonthId, name:"   ", isSavings:false}`.
- **Expected:** 400 "Validation failed" with `errors.Name = ["A category group needs a name."]` — FluentValidation `NotEmpty()` treats whitespace-only as empty (`AddBudgetCategoryCommandValidator.cs:13-15`). No group created.
- **Automated:** Yes (`BudgetCategoryCrudHandlerTests.cs` `AddValidator_RejectsEmptyName` [Theory])

### CAT-006 - Cannot create an Income group
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Direct `POST /api/budget/categories`. (The UI kind `<select>` only offers Expense/Savings, so this is only reachable via API.)
- **Steps:**
  1. Attempt to create a category with `Kind = Income` (e.g. the AddCategory command with `CategoryKind.Income`).
- **Expected:** 400 "Validation failed", `errors.Kind = ["A group can only be an expense or a fund group."]` (`AddBudgetCategoryCommandValidator.cs:18-20`). A month keeps exactly the one seeded Income group; income groups are never user-created.
- **Automated:** Yes (`SavingsTests.cs` "AddCategory validator rejects Income kind")

### CAT-007 - Group name at the 120-char boundary
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Ana on July 2026 (or direct API).
- **Steps:**
  1. Create a group with a name of **exactly 120** characters.
  2. Create another with **121** characters.
- **Expected:** 120 chars → created successfully (`MaximumLength(120)` inclusive). 121 chars → 400 "Validation failed" with a length message on `Name` ("… must be 120 characters or fewer …"). Note `MaximumLength` counts UTF-16 code units, so ~60 astral emoji already reach the cap. Via the dashboard, the server 400 is swallowed into the generic strip "Could not add that group — reverted." (the row's optimistic temp group rolls back).
- **Automated:** Partial (`BudgetItemCrudHandlerTests.cs` `Validator_Rejects_NameLongerThan120` covers the line analogue; no group-specific 120/121 test)

### CAT-008 - Group name accepts unicode & emoji
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Ana on July 2026.
- **Steps:**
  1. Create a group named `Ahorros 🏦 — Straße/日本語`.
- **Expected:** Created and rendered verbatim (name is only `.Trim()`med server-side, `AddBudgetCategoryCommandHandler.cs:53`). No transliteration/stripping. Persists across reload.
- **Automated:** No

### CAT-009 - Duplicate group names are allowed
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Ana on July 2026 (a "Housing" expense group exists).
- **Steps:**
  1. Create a second expense group also named `Housing`.
- **Expected:** Succeeds — there is **no** uniqueness constraint on category names. Two distinct "Housing" groups render (different ids, DisplayOrder 0 and 1). Totals sum across both.
- **Automated:** No

### CAT-010 - Group name is trimmed server-side
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** Direct `POST /api/budget/categories`.
- **Steps:**
  1. Create a group with `name = "  Utilities  "`.
- **Expected:** Stored as `"Utilities"` (`request.Name.Trim()`). The returned DTO shows no leading/trailing spaces.
- **Automated:** No

### CAT-011 - Add-group optimistic rollback on server failure
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Ana on July 2026; `POST /api/budget/categories` will fail (e.g. network/500).
- **Steps:**
  1. Add a group `Gifts`.
- **Expected:** The temp group flashes in optimistically, then on failure the month reverts to the snapshot and the rose strip shows **"Could not add that group — reverted."** (savings kind shows **"Could not add that savings group — reverted."**, `DashboardPage.tsx:369`). No phantom group remains.
- **Automated:** No

---

## Category group rename

### CAT-012 - Rename an expense group
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026.
- **Steps:**
  1. Hover the "Housing" header; click into its name input (aria "Rename group Housing").
  2. Change it to `Home` and blur (or press Enter to blur-commit).
- **Expected:** Optimistic `withCategoryName`, then `PUT /api/budget/categories/{id} {name:"Home"}`. Header now reads "Home"; totals unchanged. Server trims the name (`RenameBudgetCategoryCommandHandler.cs:39`).
- **Automated:** Partial (`BudgetCategoryCrudHandlerTests.cs` `Rename_ChangesTheName`; `client/src/budgetModel.test.ts` `withCategoryName` immutability — no dashboard rename-group UI test)

### CAT-013 - Rename a savings group
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Ana on July 2026 (the "Savings" group).
- **Steps:**
  1. Edit the "Savings" group header (aria "Rename group Savings") to `Sinking Funds` and blur.
- **Expected:** `PUT /api/budget/categories/{id} {name:"Sinking Funds"}` succeeds; the violet-dot card header updates. The backing jar's name is untouched (renaming a *group* never touches jars; renaming a *line* also never renames its jar — CAT-036).
- **Automated:** Partial (backend `Rename_ChangesTheName`)

### CAT-014 - Empty / Escape rename reverts silently
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Ana on July 2026.
- **Steps:**
  1. Clear the "Housing" name input entirely and blur.
  2. Repeat: type `Home`, then press **Escape**.
- **Expected:** Step 1 — `commitName` sees an empty trimmed value and restores "Housing"; no `PUT`. Step 2 — Escape resets the field to "Housing" without committing. In both cases the name is unchanged and no request fires.
- **Automated:** No

### CAT-015 - Income group can be renamed via API but has no UI affordance
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Ana on July 2026.
- **Steps:**
  1. In the dashboard, confirm the Income card header is **plain text** (`IncomeGroup.tsx:47` `<h2>`), not an input — there is no rename control.
  2. Via API, `PUT /api/budget/categories/{incomeGroupId} {name:"Earnings"}`.
- **Expected:** UI: no way to rename the Income group. API: **200**, the Income group is renamed (`RenameBudgetCategoryCommandValidator`/handler apply no kind check). This asymmetry is intentional (map §7 gotcha #13) — the group stays Kind=Income and still renders first.
- **Automated:** No

### CAT-016 - Rename group at the 120-char boundary / rollback
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Direct `PUT /api/budget/categories/{id}` or via UI.
- **Steps:**
  1. Rename a group to a 121-char string.
- **Expected:** 400 "Validation failed" on `Name` (length rule, `RenameBudgetCategoryCommandValidator.cs:12-14`). Via UI the optimistic rename rolls back with **"Could not rename that group — reverted to the previous name."**
- **Automated:** No

### CAT-017 - Rename a group owned by another household is refused
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Ana authenticated; `{id}` is one of **Bob's** category groups.
- **Steps:**
  1. `PUT /api/budget/categories/{bobsCategoryId} {name:"Mine now"}`.
- **Expected:** **403** (ownership re-check `category.BudgetMonth.OwnerId != userId`, empty message). Bob's group is unchanged. (A genuinely non-existent id → 404 "Budget category {guid} was not found.")
- **Automated:** Yes (`BudgetCategoryCrudHandlerTests.cs` `Rename_Throws_WhenUserDoesNotOwnTheCategory`)

---

## Category group deletion

### CAT-018 - Delete an empty expense group behind an inline confirm
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026 with an empty "Subscriptions" group (from CAT-001).
- **Steps:**
  1. Hover the "Subscriptions" header; click **🗑** (aria "Delete group Subscriptions").
  2. In the inline confirm, click **"Delete"** (aria "Confirm delete Subscriptions").
- **Expected:** Optimistic `withoutCategory`, then `DELETE /api/budget/categories/{id}` → the group disappears and the month reconciles from the response. Totals unchanged (it was empty).
- **Automated:** Yes (`DashboardPage.test.tsx` "deletes a category group only after confirming"; `BudgetCategoryCrudHandlerTests.cs` `Delete_RemovesGroupAndItsLines`)

### CAT-019 - Cancel the delete confirm keeps the group
- **Priority:** P2
- **Type:** Happy
- **Preconditions:** Ana on July 2026.
- **Steps:**
  1. Click **🗑** on "Housing".
  2. Click **"Cancel"** (aria "Cancel delete").
- **Expected:** The confirm collapses; **no** `DELETE` fires; "Housing" and its lines remain.
- **Automated:** No

### CAT-020 - Delete a group that contains lines removes the whole group
- **Priority:** P0
- **Type:** Happy
- **Preconditions:** Ana on July 2026; "Housing" holds Rent (€900) + Utilities (€150).
- **Steps:**
  1. Delete the "Housing" group (🗑 → Delete).
- **Expected:** `DELETE /api/budget/categories/{id}` removes the group **and both lines** (`DeleteBudgetCategoryCommandHandler` `RemoveRange(category.Items)` + cascade). Allotted drops by €1,050 (€1,150→€100), Remaining rises to €1,900 (€850→€1,900). The recomputed month no longer lists Housing.
- **Automated:** Yes (`BudgetCategoryCrudHandlerTests.cs` `Delete_RemovesGroupAndItsLines`)

### CAT-021 - Deleting a group unassigns its lines' transactions (keeps them)
- **Priority:** P0
- **Type:** Edge
- **Preconditions:** Ana on July 2026; Rent (in "Housing") has one assigned €900 expense transaction.
- **Steps:**
  1. Delete the "Housing" group.
  2. Open the transactions register.
- **Expected:** The group + lines are gone, but the €900 transaction still exists — its `BudgetItemId` is set to null (FK `OnDelete(SetNull)`, `BudgetItemConfiguration.cs:46-49`), so it shows as **Unassigned**, not deleted. Budget history isn't destroyed; the actual is simply no longer attributed to any line. (Note: EF InMemory does not enforce SetNull, so this behavior only reproduces on SQL Server / manual QA.)
- **Automated:** No

### CAT-022 - The Income group cannot be deleted
- **Priority:** P0
- **Type:** Negative
- **Preconditions:** Ana on July 2026. The Income card has **no** 🗑 affordance in the UI.
- **Steps:**
  1. Via API, `DELETE /api/budget/categories/{incomeGroupId}`.
- **Expected:** **400** "Validation failed" with `errors.CategoryId = ["The Income group cannot be deleted."]` (thrown in the handler, `DeleteBudgetCategoryCommandHandler.cs:42-48`, not the validator). The Income group and its lines survive. A blank month always keeps exactly one Income group.
- **Automated:** Yes (`BudgetCategoryCrudHandlerTests.cs` `Delete_Throws_WhenDeletingTheIncomeGroup`)

### CAT-023 - Deleting a savings group does NOT delete its jars
- **Priority:** P1
- **Type:** Edge
- **Preconditions:** Ana on July 2026; the "Savings" group holds the jar-backed "Emergency Fund" line.
- **Steps:**
  1. Delete the "Savings" group.
  2. Open `/jars`.
  3. Create the **next** month (August 2026).
- **Expected:** The group + its savings line disappear from July, but the **Emergency Fund jar still exists** and is active (the `SavingsId` FK is `OnDelete(SetNull)`; deleting the budget category never removes the `Jars` row). When August is created, month-create re-appends a savings line for every active jar (into the first Savings group, creating one named "Savings" if none), so Emergency Fund reappears (map §6/§7 gotcha #9). Jar shaping details → `13-jars.md`.
- **Automated:** Partial (`JarBudgetLinkTests.cs` `CreateMonth_*_*` covers re-appending jar lines on month create)

### CAT-024 - Delete a group owned by another household is refused
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Ana authenticated; `{id}` is Bob's group.
- **Steps:**
  1. `DELETE /api/budget/categories/{bobsCategoryId}`.
- **Expected:** **403** (ownership re-check). Bob's data is unchanged. Non-existent id → 404 "Budget category {guid} was not found."
- **Automated:** Yes (`BudgetCategoryCrudHandlerTests.cs` `Delete_Throws_WhenUserDoesNotOwnTheCategory`)

### CAT-025 - Delete-group optimistic rollback on failure
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Ana on July 2026; `DELETE` will fail.
- **Steps:**
  1. Delete "Housing" (🗑 → Delete) with the request failing.
- **Expected:** The group vanishes optimistically, then reappears on rollback with the strip **"Could not delete that group — reverted."** Totals restored to €850 remaining.
- **Automated:** No

---

## Category group reordering

### CAT-026 - Move an expense group up / down
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026 with two expense groups: "Housing" (order 0), "Subscriptions" (order 1).
- **Steps:**
  1. Hover "Subscriptions"; click **▲** (aria "Move Subscriptions up").
- **Expected:** Optimistic `withReorderedExpenseCategories`, then `PUT /api/budget/categories/order {budgetMonthId, orderedCategoryIds:[Subscriptions, Housing]}`. The handler sets `DisplayOrder = index` for the listed ids (`ReorderBudgetCategoriesCommandHandler.cs:45-48`). "Subscriptions" now renders above "Housing" inside the Everyday-spending card. The ▲ button is disabled on the first group and ▼ on the last (`isFirst`/`isLast`).
- **Expected (bounds):** ▲ on the top group and ▼ on the bottom group are `disabled` and no-op.
- **Automated:** Yes (`DashboardPage.test.tsx` "reorders expense groups via the move buttons"; `tests/AllotJar.Application.Tests/Application/ReorderBudgetCategoriesTests.cs` `Reorder_SetsDisplayOrder_ToMatchTheGivenOrder`)

### CAT-027 - Reorder cannot move the Income group out of first position
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Direct `PUT /api/budget/categories/order` (the client only ever sends expense ids).
- **Steps:**
  1. Send `orderedCategoryIds` that lists the Income group's id in the middle, mixed with expense ids.
- **Expected:** The endpoint accepts any month-owned ids and assigns `DisplayOrder = index` blindly, **but** rendering always orders Income→Expense→Savings by Kind first, then DisplayOrder (`BudgetMonthMapping.cs:27-33`). So the Income group still renders first regardless of the order sent.
- **Automated:** Yes (`ReorderBudgetCategoriesTests.cs` `Reorder_KeepsIncomeGroupFirst_RegardlessOfOrder`)

### CAT-028 - Reorder rejects an id not in this month
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Ana authenticated; a category id from Bob's month (or a random Guid).
- **Steps:**
  1. `PUT /api/budget/categories/order {budgetMonthId: anaJulyId, orderedCategoryIds:[…, foreignId]}`.
- **Expected:** **404** "One or more categories do not belong to this budget." (`ReorderBudgetCategoriesCommandHandler.cs:39-43`); no order change persists. Empty `orderedCategoryIds` → 400 "Provide the category order." A month owned by Bob → 403.
- **Automated:** Yes (`ReorderBudgetCategoriesTests.cs` `Reorder_Throws_WhenACategoryIsNotInThisMonth`, `Reorder_Throws_WhenUserDoesNotOwnTheMonth`)

### CAT-029 - Reorder persists and survives reload; rollback on failure
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026, two expense groups.
- **Steps:**
  1. Reorder them, then hard-reload the page (re-`GET /api/budget/2026/7`).
  2. Separately, trigger a reorder whose `PUT` fails.
- **Expected:** After reload the new order is preserved (`DisplayOrder` persisted). On a failed reorder the optimistic order rolls back with **"Could not reorder the groups — reverted."**
- **Automated:** Partial (persistence implied by `Reorder_SetsDisplayOrder`; no dedicated reload/rollback test)

---

## Budget line creation

### CAT-030 - Add an expense line to a group
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026, "Housing" group.
- **Steps:**
  1. Hover "Housing"; click **"+ Add a line"** (aria "Add a line to Housing").
  2. Type `Water` (placeholder "Add a line (e.g. Groceries, Fuel)…") and click **"Add"** (aria "Add line to Housing") or press Enter.
- **Expected:** A temp row appears (`plannedMinor 0`, `displayOrder MAX_SAFE_INTEGER`), then reconciles from `POST /api/budget/categories/{HousingId}/items {name:"Water", plannedAmount:0}`. "Water" persists as the last Housing line with `DisplayOrder = 2` (next order), planned €0.00, `SavingsId` null (expense group). Allotted/Remaining unchanged (planned 0). Escape while typing cancels; blur with empty text closes the add row.
- **Automated:** Yes (`DashboardPage.test.tsx` "adds an expense line to a group"; `tests/AllotJar.Application.Tests/Application/BudgetItemCrudHandlerTests.cs` `Add_ExpenseLine_LowersRemainingOnly`, `Add_AssignsNextDisplayOrder`)

### CAT-031 - Add an income source line
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026, Income card.
- **Steps:**
  1. In the Income card's always-visible add row type `Freelance` (placeholder "Add income source (e.g. Freelance, Child Benefit)…", aria "New income source name").
  2. Click **"+ Add"** (aria "Add income source") or press Enter.
- **Expected:** `POST /api/budget/categories/{incomeGroupId}/items {name:"Freelance", plannedAmount:0}`; the line appears under Salary with received €0.00, planned €0.00. TotalIncome unchanged until a planned amount is set (planned-editing → `06-dashboard-budget-view.md`). Empty input never submits.
- **Automated:** Yes (`DashboardPage.test.tsx` "adds an income source and reconciles from the server response"; `BudgetItemCrudHandlerTests.cs` `Add_IncomeLine_RaisesTotalIncomeAndRemaining`)

### CAT-032 - New line name empty / whitespace is rejected
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Ana on July 2026 (UI) and direct API.
- **Steps:**
  1. UI: open "+ Add a line", leave blank, press Enter.
  2. API: `POST /api/budget/categories/{id}/items {name:"   ", plannedAmount:0}`.
- **Expected:** UI: `submitNewItem` trims and returns on empty — no `POST`, add row stays open. API: 400 "Validation failed", `errors.Name = ["A line needs a name."]` (`AddBudgetItemCommandValidator.cs:12-13`, `NotEmpty` also rejects whitespace).
- **Automated:** Yes (`BudgetItemCrudHandlerTests.cs` `Validator_Rejects_InvalidInput` [Theory])

### CAT-033 - Line name at the 120-char boundary + unicode/duplicate
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Ana on July 2026, "Housing".
- **Steps:**
  1. Add a line named with exactly **120** chars, then one with **121**.
  2. Add a line named `Café ☕ Straße` and a second line also named `Rent`.
- **Expected:** 120 → created; 121 → 400 length message on `Name` (`MaximumLength(120)`), via UI swallowed into **"Could not add that line — reverted."** Unicode/emoji stored verbatim (`.Trim()` only). Duplicate line names within a group are allowed (no uniqueness). New lines carry contiguous `DisplayOrder`.
- **Automated:** Partial (`BudgetItemCrudHandlerTests.cs` `Validator_Rejects_NameLongerThan120`; no unicode/duplicate test)

### CAT-034 - Adding a line to a Savings group mints a backing jar
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026, the "Savings" group.
- **Steps:**
  1. Hover the "Savings" card; click **"+ Add a savings goal"** (aria "Add a savings goal to Savings").
  2. Type `Car` (placeholder "Add a savings goal (e.g. Car, Holiday, Christmas)…") and click **"Add"**.
- **Expected:** `POST /api/budget/categories/{savingsGroupId}/items {name:"Car", plannedAmount:0}` → the handler sees `category.Kind == Savings` and mints a **real backing jar** via `SavingsLines.AddBackingJar` (`AddBudgetItemCommandHandler.cs:51-53`), so the new line's `SavingsId` points at a fresh `Jars` row (Kind=Goal, Accrual=TargetByDate, target 0, named "Car" — `Jar.ForSavingsLine`). The fund line renders with a violet bar and "€0.00 avail." A new "Car" jar now exists on `/jars`. Contrast: the same POST to an **expense** group mints no jar (`SavingsId` null).
- **Automated:** Yes (`tests/AllotJar.Application.Tests/Application/JarBudgetLinkTests.cs` `AddItem_ToSavingsGroup_CreatesTheBackingJar`, `AddItem_ToExpenseGroup_CreatesNoJar`)

### CAT-035 - Regression: add-savings-line must not violate the SavingsId FK (no 500)
- **Priority:** P0
- **Type:** Regression
- **Origin:** PR #142 / SavingsId-FK crash — `AddBudgetItemCommandHandler` previously minted a bare `Guid.NewGuid()` as `SavingsId` referencing no `Jars` row, which passes EF InMemory but throws an FK violation → **500** on SQL Server (also hit the template-create path). Fixed by routing every SavingsId write through `SavingsLines.AddBackingJar` (map §7 gotcha #8, jar-flow-audit).
- **Preconditions:** Real SQL Server (or LocalDB), Ana with a Savings group.
- **Steps:**
  1. `POST /api/budget/categories/{savingsGroupId}/items {name:"Boiler", plannedAmount:0}`.
  2. Query `BudgetItems` and `Jars`.
- **Expected:** **200**, not 500. The persisted line's `SavingsId` equals a real `Jars.Id` owned by the same household (every persisted `SavingsId` FK-resolves). No orphan/dangling SavingsId. Any **new** enforced-FK writer must keep this invariant (integration-test convention).
- **Automated:** Yes (`tests/AllotJar.IntegrationTests/SavingsForeignKeyTests.cs` `AddBudgetItem_ToSavingsGroup_PersistsLineBackedByAJar`; template path: `CreateBudgetMonth_FromTemplate_PersistsSavingsLinesBackedByJars` [Theory essentials/student/family])

### CAT-036 - Add-line to a not-found / foreign category is refused
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Ana authenticated.
- **Steps:**
  1. `POST /api/budget/categories/{randomGuid}/items {name:"X", plannedAmount:0}`.
  2. `POST /api/budget/categories/{bobsCategoryId}/items {…}`.
- **Expected:** (1) 404 "Budget category {guid} was not found." (2) 403 (ownership re-check `category.BudgetMonth.OwnerId != userId`). No line created.
- **Automated:** Yes (`BudgetItemCrudHandlerTests.cs` `Add_Throws_WhenCategoryDoesNotExist`, `Add_Throws_WhenUserDoesNotOwnTheCategory`)

### CAT-037 - Add-line optimistic rollback on failure
- **Priority:** P2
- **Type:** Negative
- **Preconditions:** Ana on July 2026; the `POST` will fail.
- **Steps:**
  1. Add a line `Fuel` to "Housing" with the request failing.
- **Expected:** The temp row appears then disappears on rollback; strip shows **"Could not add that line — reverted."** No temp/orphan row lingers.
- **Automated:** No

---

## Budget line rename

### CAT-038 - Rename a line in place
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026, "Rent" line.
- **Steps:**
  1. Click the "Rent" name field (aria "Rename Rent"); change to `Mortgage`; blur (or Enter to blur-commit).
- **Expected:** Optimistic `withItemName`, then `PUT /api/budget/items/{id} {plannedAmount:<current>, name:"Mortgage"}` — the rename endpoint takes the planned amount too, so the client sends the line's **current** planned alongside the name (`DashboardPage.tsx:269-272`). The line reads "Mortgage", planned €900 preserved. Escape reverts the field; clearing to empty restores "Rent" and sends nothing (`commitName`, `BudgetItemRow.tsx:95-103`).
- **Automated:** Partial (`budgetModel.test.ts` `withItemName`; `UpdateBudgetItemHandlerTests.cs` covers the update path; no dedicated rename-line dashboard test)

### CAT-039 - Line rename endpoint has no empty-name guard (API-level)
- **Priority:** P2
- **Type:** Boundary
- **Preconditions:** Direct `PUT /api/budget/items/{id}` (the UI never sends this — it trims + reverts empty).
- **Steps:**
  1. `PUT /api/budget/items/{rentId} {plannedAmount:900, name:"   "}`.
  2. `PUT /api/budget/items/{rentId} {plannedAmount:900, name:"  Rent  "}`.
- **Expected:** Both **200**. `UpdateBudgetItemCommandValidator` only checks `MaximumLength(120)` **when Name is non-null** — there is **no `NotEmpty`** — and the handler assigns `item.Name = request.Name` **without trimming** (`UpdateBudgetItemCommandHandler.cs:44-47`). So a whitespace-only line name and untrimmed padding are both accepted server-side (asymmetric with add-line's `NotEmpty` + trim). Flag as a validation gap; the UI shields it. `name:null` keeps the existing name (planned-only update).
- **Automated:** No

### CAT-040 - Rename racing a planned edit can clobber the planned amount
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Ana on July 2026, "Utilities" planned €150.
- **Steps:**
  1. Begin editing Utilities' planned amount to €175 and let that `PUT` be in flight/slow.
  2. Immediately rename Utilities to `Power` from a view whose local `current.plannedMinor` still reads €150.
- **Expected:** The rename `PUT /api/budget/items/{id}` sends `{plannedAmount:150, name:"Power"}` (it always re-sends the line's *current* planned, map §7 gotcha #12). If it lands after the €175 edit, it can overwrite planned back to €150. Document as a known race; not a crash. (Deep planned-edit semantics → `06-dashboard-budget-view.md`.)
- **Automated:** No

### CAT-041 - Rename a line at the 120-char boundary / rollback
- **Priority:** P3
- **Type:** Boundary
- **Preconditions:** Ana on July 2026.
- **Steps:**
  1. Rename a line to a 121-char string (via API, or a paste in the field).
- **Expected:** 400 "Validation failed" on `Name` (`UpdateBudgetItemCommandValidator.cs:19-21`). Via UI the optimistic rename rolls back with **"Could not rename that line — reverted to the previous name."**
- **Automated:** No

---

## Budget line deletion

### CAT-042 - Delete a line (no confirm, immediate)
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026; "Utilities" line (no transactions).
- **Steps:**
  1. Hover the "Utilities" row; click **✕** (aria "Delete Utilities", title "Delete line").
- **Expected:** Optimistic `withoutItem` (line vanishes immediately — **no** confirm dialog for lines, unlike group delete), then `DELETE /api/budget/items/{id}` and reconcile from the response. Allotted drops €150 (€1,150→€1,000), Remaining €850→€1,000. Income-line delete uses the same ✕ (title "Delete income source", `IncomeLineRow.tsx:143`). A **jar's** line in a Savings group is the exception: its ✕ opens the skip-or-archive dialog instead (W04, rule 60 — CAT-044, BUDG-034).
- **Automated:** Yes (`DashboardPage.test.tsx` "deletes an income source"; `BudgetItemCrudHandlerTests.cs` `Delete_IncomeLine_LowersTotalIncomeAndRemaining`)

### CAT-043 - Delete a line that has assigned transactions unassigns them
- **Priority:** P0
- **Type:** Edge
- **Preconditions:** Ana on July 2026; "Rent" has one assigned €900 transaction.
- **Steps:**
  1. Delete the "Rent" line (✕).
  2. Open the transactions register.
- **Expected:** The line disappears and the month recomputes, but the €900 transaction is **kept** with `BudgetItemId` set to null (FK `OnDelete(SetNull)`, `BudgetItemConfiguration.cs:46-49`) → shows as **Unassigned**. Deleting a line never deletes spending history. (SetNull is enforced by SQL Server, not EF InMemory — verify on a real DB.)
- **Automated:** No

### CAT-044 - A savings line is a jar's contribution and cannot be deleted; skip the month or archive the jar (W04, rule 60)
- **Priority:** P1
- **Type:** Negative
- **Origin:** W04 — the old behaviour (delete the line, it re-appears next month) silently undid the user's action.
- **Preconditions:** Ana on the current month; "Emergency Fund" savings line (jar-backed).
- **Steps:**
  1. Hover the "Emergency Fund" row and click **✕** (aria "Remove Emergency Fund this month").
  2. Send `DELETE /api/budget/items/{id}` directly.
- **Expected:** 1: no optimistic removal; the skip-or-archive dialog opens (BUDG-034) — **Skip this month** keeps the line at €0 with a Skipped tag and spreads the rest over the months left (BUDG-060); **Archive the jar** stops future contributions (BUDG-061). 2: 400 "Emergency Fund is a jar's monthly contribution. Skip this month's contribution, or archive the jar to stop future ones."; the line and the **Emergency Fund jar stay** exactly as they were. Jar detail → `13-jars.md` (JAR-094–099).
- **Automated:** Yes (`CCategoriesLinesCoverageTests.cs` `DeleteSavingsLine_IsRefused_TheLineAndItsJarStay`; `DashboardPage.skip.test.tsx` BUDG-034)

### CAT-045 - Delete a line owned by another household is refused; rollback
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Ana authenticated; `{id}` is Bob's line, and separately a failing `DELETE`.
- **Steps:**
  1. `DELETE /api/budget/items/{bobsLineId}`.
  2. In the UI, delete a line where the `DELETE` fails.
- **Expected:** (1) 403 (ownership re-check); a random id → 404 "Budget item {guid} was not found." (2) The line reappears on rollback with **"Could not delete that line — reverted."**
- **Automated:** Yes (backend `BudgetItemCrudHandlerTests.cs` `Delete_Throws_WhenUserDoesNotOwnTheItem`, `Delete_Throws_WhenItemDoesNotExist`; UI rollback not automated)

---

## Line reordering, savings-line jar link & state variants

### CAT-046 - Reorder lines within a group via move buttons
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026; "Housing" holds Rent (order 0), Utilities (order 1).
- **Steps:**
  1. Hover the Utilities row; click **▲** in the left gutter (aria "Move Utilities up").
- **Expected:** `CategoryAccordion.moveItem` swaps them and calls `PUT /api/budget/categories/{HousingId}/items/order {orderedItemIds:[Utilities, Rent]}`; the handler sets `DisplayOrder = index` within the category (`ReorderBudgetItemsCommandHandler.cs:46-49`). Utilities renders above Rent. ▲ is disabled on the first line, ▼ on the last. Savings and income lines have **no** reorder controls (only expense rows pass `onMove`).
- **Automated:** Yes (`DashboardPage.test.tsx` "reorders lines within a group via the move buttons"; `tests/AllotJar.Application.Tests/Application/ReorderBudgetItemsTests.cs` `Reorder_SetsTheLineOrder`)

### CAT-047 - Reorder rejects a line not in the category
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** Ana authenticated; a line id from a different category/owner.
- **Steps:**
  1. `PUT /api/budget/categories/{HousingId}/items/order {orderedItemIds:[…, foreignLineId]}`.
- **Expected:** 404 "One or more lines do not belong to this category." (`ReorderBudgetItemsCommandHandler.cs:41-44`). Empty list → 400 "Provide the line order." A category owned by Bob → 403. On UI failure: **"Could not reorder the lines — reverted."**
- **Automated:** Yes (`ReorderBudgetItemsTests.cs` `Reorder_Throws_WhenALineIsNotInThisCategory`, `Reorder_Throws_WhenUserDoesNotOwnTheCategory`)

### CAT-048 - Display order persists and round-trips through GET
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** Ana on July 2026 after reordering both groups (CAT-026) and lines (CAT-046).
- **Steps:**
  1. `GET /api/budget/2026/7` (or reload the dashboard).
- **Expected:** Categories come back ordered Income→Expense→Savings then by `DisplayOrder`; items ordered by `DisplayOrder` (`BudgetMonthMapping.cs`). The manual order set in CAT-026/CAT-046 is exactly what renders — no drift, no re-sort by name/id.
- **Automated:** Partial (order-setting covered by reorder tests; explicit GET round-trip not separately asserted)

### CAT-049 - Repeated template creates mint duplicate jars (jar-link side effect)
- **Priority:** P2
- **Type:** Edge
- **Preconditions:** Ana; create two months (e.g. via API for two different months) each **from the Essentials template**, whose "Savings" group has an "Emergency Fund" line.
- **Steps:**
  1. Create month #1 from `essentials`; note the "Emergency Fund" jar id.
  2. Create month #2 from `essentials`; check `/jars`.
- **Expected:** Each template create mints a **new** backing jar per savings line (`SavingsLines.AddBackingJar` per line), so two separate "Emergency Fund" jars now exist (map §7 gotcha #9). This is a known consequence of the FK invariant, not deduped by name. (Month-create mechanics → `07-month-lifecycle.md`; jar management → `13-jars.md`.)
- **Automated:** Yes (`JarBudgetLinkTests.cs` `CreateMonth_FromTemplate_BacksEverySavingsLineWithAJar`; FK persistence `SavingsForeignKeyTests.cs` [Theory])

### CAT-050 - First-ever use: only the Income group, then add the first expense group
- **Priority:** P1
- **Type:** Happy
- **Preconditions:** "Blank July" fixture — a jar-less household's freshly created blank month (only the seeded "Income" group, DisplayOrder 0, no lines; no expense/savings groups).
- **Steps:**
  1. Confirm the dashboard shows only the Income card (no "Everyday spending" panel — it renders only when ≥1 expense group exists, `DashboardPage.tsx:698-700`) and the **"+ Add group"** button.
  2. Add an expense group `Bills`.
- **Expected:** The "Everyday spending" card appears once "Bills" exists, `DisplayOrder 0`, empty ("No lines yet — add one below."). Income group stays first. A jar-less blank month legitimately has no Savings group until one is added or a jar is created.
- **Automated:** Partial (`DashboardPage.test.tsx` empty-month cases; `BudgetCategoryCrudHandlerTests.cs` `Add_CreatesExpenseGroup_*`)

### CAT-051 - Limited & ReadOnly logins cannot alter budget structure
- **Priority:** P1
- **Type:** Negative
- **Preconditions:** July 2026; test once as the **Limited** login and once as **ReadOnly** on household A.
- **Steps:**
  1. Observe the group/line controls in the dashboard.
  2. Attempt any structural command via API (e.g. `POST /api/budget/categories`, `PUT /api/budget/items/{id}`, `DELETE /api/budget/categories/{id}`, reorder).
- **Expected:** UI: group names/line names render as **static text** (not inputs), with no ▲▼ reorder, no 🗑/✕ delete, no "+ Add group / + Add a line / + Add a savings goal" affordances (all gated on `canWrite`). API: every structural command → **403** "Your access level ({role}) does not permit this action." (MediatR `AuthorizationBehaviour`; only `SetBudgetItemPaidCommand` is `[AllowLimited]`, and that's a bill-paid toggle, not structure — see `06`). ReadOnly is refused all commands.
- **Automated:** Partial (`tests/AllotJar.Application.Tests/Application/AuthorizationBehaviourTests.cs` command gating by role; `client/src/pages/RoleGating.test.tsx` covers tx/accounts, not budget-structure affordances specifically)

### CAT-052 - Solo vs shared household: identical category/line structure
- **Priority:** P3
- **Type:** Edge
- **Preconditions:** The same July 2026 budget viewed by the Owner and by a second Admin member of the shared household.
- **Steps:**
  1. Compare the group/line list, ordering and totals across both logins.
- **Expected:** No difference — the budget is household-scoped by `OwnerId`; both see the same groups, lines, order and totals, and both (Admin+) can edit structure. Sharing only changes greeting banners and the household switcher (not this page).
- **Automated:** No

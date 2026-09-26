# AllotJar — User Guide

AllotJar is a zero-based budgeting app crafted in Europe and at home anywhere: every unit of your income gets a job before the month starts, in whatever currency you budget. This guide walks through every page of the app, what each control does, and how the numbers behind them are calculated.

---

## Contents

1. [The idea: zero-based budgeting](#1-the-idea-zero-based-budgeting)
2. [Signing in & getting around](#2-signing-in--getting-around)
   - [Registering and signing in](#registering-and-signing-in)
   - [The layout: sidebar, top bar and your account menu](#the-layout-sidebar-top-bar-and-your-account-menu)
3. [The Budget page](#3-the-budget-page)
   - [Choosing a month](#choosing-a-month)
   - [Creating a month](#creating-a-month)
   - [The Remaining-to-Budget banner](#the-remaining-to-budget-banner)
   - [Income](#income)
   - [Expense groups and lines](#expense-groups-and-lines)
   - [Spent: tracked from transactions](#spent-tracked-from-transactions)
   - [Savings groups](#savings-groups)
   - [Bills and reminders](#bills-and-reminders)
   - [Organising groups and lines](#organising-groups-and-lines)
4. [Transactions](#4-transactions)
   - [Adding a transaction](#adding-a-transaction)
   - [Assigning to a budget line](#assigning-to-a-budget-line)
   - [Splitting a transaction](#splitting-a-transaction)
   - [Editing, deleting, finding](#editing-deleting-finding)
5. [Accounts](#5-accounts)
6. [Jars (savings goals)](#6-jars-savings-goals)
7. [Reports](#7-reports)
8. [People & sharing](#8-people--sharing)
   - [Adding people](#adding-people)
   - [Inviting someone to sign in](#inviting-someone-to-sign-in)
   - [Roles and access](#roles-and-access)
   - [Multiple households](#multiple-households)
9. [Income allocation](#9-income-allocation)
10. [Your account & settings](#10-your-account--settings)
11. [Appearance: light & dark](#11-appearance-light--dark)
12. [Feature flags (for self-hosters)](#12-feature-flags-for-self-hosters)
13. [Everyday tips](#13-everyday-tips)

---

## 1. The idea: zero-based budgeting

In a zero-based budget you don't just track spending after the fact — you **assign every part of your income a job before you spend it**. Each month:

1. Enter the income you expect.
2. Assign all of it across your spending lines (Rent, Groceries, …), your savings goals, and your jars.
3. The goal is **Remaining to Budget = 0** — no money left unassigned, none over-assigned.
4. During the month, record what you actually spend; AllotJar compares it to the plan for you.

AllotJar's big banner tracks that goal live as you type.

## 2. Signing in & getting around

### Registering and signing in

- Open the app and you land on the sign-in card. New here? Switch to **Create account** and fill in your **name**, **email**, a **password of at least 8 characters**, your **preferred currency** and **number format**, and accept the **Terms**. Registration signs you in immediately.
- Your **preferred currency** and **number format** are display preferences — they control how amounts are shown and entered. They are *not* an exchange-rate conversion; AllotJar keeps your figures in one currency.
- Your data is private to your login. (You can deliberately share a household with other people — see [People & sharing](#8-people--sharing).)
- Your session is kept alive securely in the background, so you stay signed in between visits without re-entering your password.
- Forgot your password? Use the **Forgot password?** link on the sign-in card — we'll email you a reset link (valid for 2 hours). Setting a new password signs you out everywhere else and signs you straight in on the device you used.
- Prefer not to manage a password? Use **Continue with Google** on the sign-in card — it both signs you in and, the first time, creates your account (you'll just confirm the Terms). If you already have a password account with the same Google email, signing in with Google links to it, so either method works from then on. A Google-only account has no password; to add one later, use **Forgot password** with that email from the Account page.

### The layout: sidebar, top bar and your account menu

Every signed-in page shares the same chrome:

- **The sidebar** (left on desktop; a scrollable row of pills along the top on a narrow screen) is the primary navigation: **Budget · Transactions · Accounts · Jars · Reports · People · Help**. An **Allocation** item joins them once you share your household with someone.
- **The top bar** opens every data screen with a **month picker** (`‹ June 2026 ›`), the signature **Zero-based** pill, and the **light/dark** theme toggle.
- **Your account menu** is the chip with your initials at the bottom of the sidebar (top-right on mobile). It holds **Account settings**, **switching households** (if you belong to more than one), and **Sign out**.

The **Help** page is a quick reference to everything below, with a button to replay the welcome tour.

## 3. The Budget page

This is the home page — your plan for one calendar month.

### Choosing a month

Use the **‹ / ›** arrows in the top bar to move between months. Every month-scoped screen (Budget, Reports, allocation) follows the month you pick here, so they always agree.

### Creating a month

If the month you're viewing has no budget yet, you'll see three ways to start:

- **Copy last month's budget** — brings over your whole structure and planned amounts (actuals reset to zero, bills reset to unpaid). This is the normal month-to-month flow.
- **Start blank** — an empty budget with just an Income group.
- **Start from a template** — quick-start layouts (**Essentials**, **Student**, **Family**), each a ready set of groups and lines with amounts at zero for you to fill in.

### The Remaining-to-Budget banner

The large coloured banner shows **Income**, **Assigned**, and the difference — **Remaining to Budget** — recalculated instantly on every edit:

| Colour | Meaning |
|---|---|
| 🟡 Amber — "Still to assign" | Income not yet given a job. Keep assigning. |
| 🟢 Green — "Every [currency] has a job 🎉" | Nothing left to assign (the banner names your currency). The budget is balanced. |
| 🔴 Red — "Over-budgeted — trim a category" | You've planned more than you earn. Reduce something. |

**How it works:** Income = the sum of your income lines' *planned* amounts. Assigned = the sum of every expense line *and* every savings contribution. Putting money into a savings line counts as giving it a job, so the budget only balances once your savings are funded too.

### Income

The Income group is pinned to the top and can't be deleted. Each income line (e.g. "Salary", "Freelance") has:

- **Planned** — what you expect to receive. This feeds the pool the banner divides up.
- **Received** — what actually arrived, totalled from the income transactions you've assigned to this line (read-only; €0 until you assign some).

If your pay arrives in several deposits, add an income line per source (e.g. "Salary", "Benefits") — each has its own planned and received amount.

### Expense groups and lines

Below Income come your expense groups ("Housing", "Food", …). Each line shows **Planned**, **Spent** and **Remaining** (planned − spent; turns negative when overspent). Click any name or amount to edit it in place — **Enter** or clicking away saves, **Escape** cancels.

- **Add group** creates a new group (choose *Expense* or *Savings*).
- Each group has an "add line" affordance for new lines within it.
- Delete a line or group with its delete control — any transactions assigned to a deleted line simply become unassigned, they are not lost.

### Spent: tracked from transactions

Every line's **Spent** value is the live total of the transactions assigned to that line — it's always read-only, and there is no manual entry. To fill it in, assign transactions to the line (or split one across several lines); a line with no transactions shows **€0**.

**How it works:** spent values are never stored as a separate number that can drift — they're recomputed from your transaction register every time the page loads. Income lines total *income* transactions; expense lines total *expense* transactions; split transactions contribute exactly their slice.

### Savings groups

A **Savings** group (shown in violet) holds savings goals — "Car repairs", "Holidays", "Christmas" — whose money **rolls over from month to month** instead of resetting.

- The **Planned** amount on a savings line is this month's *contribution*. It counts toward Assigned, just like an expense.
- The violet **Available** figure is the line's running balance: every contribution you've ever planned, minus everything you've ever spent from it, across all months up to the one you're viewing.
- Spend from savings the same way you spend from any line — assign a transaction to it. The Available balance falls accordingly.

When you copy a month, savings lines keep their identity, so the balance keeps accumulating. To track a goal visually — with a target, a date and a progress bar — pair a savings line with a **Jar** (see [Jars](#6-jars-savings-goals)).

### Bills and reminders

Any expense line can be marked as a **bill**:

1. Use the **due-date** affordance on the line and set the day of the month it's due (1–31). The line gains a due-day pill and a **Paid** checkbox.
2. Tick **Paid** when you've paid it this month.
3. A summary banner above the groups counts your bills; when you're viewing the *current* month it warns about urgency:
   - **Overdue** (rose, ⚠) — the due day has passed and the bill isn't ticked.
   - **Due soon** (amber) — due within the next 7 days.

Due days recur: copying a month keeps the due day and resets Paid to unticked. For months shorter than the due day (e.g. day 31 in February), the bill is treated as due on the month's last day. Clear the due day to stop treating the line as a bill.

### Organising groups and lines

- Reorder controls in group headers move groups; the controls on rows move lines within their group.
- Groups always display income first, then expenses, then savings; your custom order applies within each kind.
- Rename a group or line by clicking its name.

## 4. Transactions

The register of real money movements.

### Adding a transaction

Use the **Add a transaction** form: date, payee, amount, type (**Expense** or **Income**), optionally assign it to a budget line right away, and — if you use [Accounts](#5-accounts) — the account it happened on. Amounts accept a decimal point or comma ("12.50" or "12,50"), and tolerate thousands separators.

If you don't pick a budget line, AllotJar quietly fills one in for you: it assigns the new transaction to the same line as your **most recent earlier transaction with the same description**. So once you've categorised "REWE" or your landlord once, repeat payees sort themselves — with no rules to set up. Whatever it can't match is left *Unassigned* for you to place.

### Recording a transfer between your own accounts

With two or more accounts, the add form has a **Transfer** mode. A transfer is not income or spending — it never touches a budget line — but it does move money between two accounts, and each bank posts its own side on its own date:

- Enter the amount, the **From** and **To** accounts, and the date the money **left the source account**. Tick **I've completed this transfer** to record it; AllotJar only records transfers you have actually made.
- If you already know when it **arrived**, enter that date too. Otherwise leave it blank: the amount is shown as **in transit** — debited from the source, not yet credited to the destination — until you confirm the receipt from the register row (**Confirm receipt**). AllotJar never guesses an arrival date.
- When importing a statement, a debit you mark as a transfer records the departure in the same way. A credit you mark as a transfer is a receipt whose departure isn't known yet: it is held as **pending review** and doesn't change either balance until you add the departure date (**Add departure date** on the register) or, when the other account's statement already recorded the movement, pick that transfer from the **Already recorded?** list — both statement references are then kept on the one transfer, and nothing moves twice. Candidates with the same amount are only suggestions; nothing is matched for you.
- Deleting a transfer removes both sides at once. An account can't be deleted while it is a side of a recorded transfer.

### Assigning to a budget line

Every transaction row has an assignment dropdown grouped by category. Once assigned, the line's Spent (or an income line's Received) includes this transaction — Spent is always the live total of a line's assigned transactions.

Choose "Unassigned" to detach a transaction again.

### Splitting a transaction

One supermarket receipt, several budget lines? Use the **split** control on the row:

- Add two or more split rows, each with a line and an amount.
- The editor shows the **remainder** live; **Save split** only enables when the rows add up *exactly* to the transaction total.
- Expenses split across expense/savings lines; income across income lines.

A split transaction shows a **Split** badge listing its slices, and each slice counts toward its own line. **Remove split** (or re-assigning the whole transaction) undoes it.

### Editing, deleting, finding

- The edit control changes date, payee, amount and type in place; the delete control removes the transaction.
- The search box filters by payee as you type; **Unassigned only** shows just the transactions still needing a home — a quick way to do your weekly tidy-up.

## 5. Accounts

The **Accounts** page tracks *where your money sits* — current account, savings, cash, credit card.

- **Add an account** with a name, a type, an **opening balance** and an **opening date**. The opening balance is what the account held at the *start* of that date (credit cards can start negative). Transactions dated before the opening date stay in your history but never change the balance again — the opening amount already includes them.
- Each transaction can be tagged with the account it happened on (in the add form or the edit row). The account's **current balance** is then: **opening balance + income − expenses − transfers out + transfers in**, counting only what has posted from the opening date up to today. A balance is shown as **Not available** rather than zero when the account has no opening date yet, or when you look at a date before it.
- Transfers between your own accounts move money on each bank's own date: the source is debited on the day the money left, the destination is credited only once you confirm the receipt. In between, the amount is shown as **in transit** on both cards and belongs to neither balance. A receipt you've identified as a transfer but whose departure date isn't known yet is shown as **pending review** and is not posted to either account until you supply it (see *Transactions* and *Importing*).
- The footer totals the balances that are available into a single **Net** across all accounts; accounts without an opening date are left out and counted separately.
- Open an account to see its own transaction register on the **account detail** page.
- Editing an account changes its name, type, opening balance and opening date. Deleting an account keeps its income and expense transactions (they just lose the account tag), but an account that is a side of a recorded transfer can't be deleted until those transfers are removed — a transfer needs both of its accounts.

**How it works:** like budget actuals, balances are derived from the register at read time — there's no stored balance to drift out of sync. A split transaction still moved in or out of one account, so its *full* amount counts toward that account regardless of how it's split across budget lines.

## 6. Jars (savings goals)

The **Jars** page is where you set savings targets and watch them fill up. A jar is the visual, target-driven companion to a savings line on the Budget page.

The first thing you choose is the jar's **Type**, and that shapes the rest of the form:

- **Recurring** — a cost that comes around again: you save toward a due date, and when the date passes the jar rolls forward to its next cycle and keeps going (home insurance, road tax, a yearly holiday). You give it a **Next due** date and a **Repeats** cadence (yearly, every 6 months, every 3 months, or monthly). If a cycle slips past its date, the remaining amount simply spreads over the next one.
- **Goal** — a one-off target that's done once it's funded (a new kitchen, a sofa, a wedding). You give it a **Target date** if you have one; it's optional.

You also set:

- **Name** — e.g. "Home insurance", "Summer holiday".
- **Target** — how much you want to reach.
- **Saved so far** — money you'd already put aside before AllotJar started tracking (on an existing jar this field is labelled **Opening balance**, and the card shows the live total — don't retype it).
- **Held in** *(optional)* — the account the money sits in, if you track accounts.

As you fill the form, a live line estimates the **monthly set-aside** the jar needs ("Sets aside ≈ €120/mo toward Mar 2027, then it repeats"). Each jar card then shows a **progress bar**, a **status** (Behind, Funded, Overspent) where it matters, and its projected finish ("full by Nov 2026"). The page header totals your **Total saved**, the combined **monthly** set-aside, and the number of **active jars**.

**Jars and the Budget page work together:** the jar tells you *what to set aside each month*, and AllotJar seeds that amount onto its **Savings** budget line automatically when you create each month — so a new jar starts filling without extra steps. When you spend from a jar, record the expense against that Savings line and its balance falls, ready to fill again next cycle. Edit a jar any time to change its target, date or cadence, or **archive** it when you're done with it (archiving never touches your transactions; deleting the budget line instead just re-adds it next month).

## 7. Reports

The **Reports** page summarises your recent months (up to the last six budgets):

- **Summary cards** — window totals for **Income (budgeted)**, **Income (received)**, **Spent**, and **Net** (budgeted income − spent).
- **Income vs spending** — three bars per month: budgeted income, actually-received income, and spending (which turns rose when you spent more than your budgeted income). The +/− figure on each month is income minus spending.
- **Annual overview** — a January-to-December table for any year (‹ / › to change year): income, spent and net per month, with year totals. Months without a budget show as dashes.
- **Spending by category** — a breakdown of where the money went in a chosen month (pick any month from the dropdown), sorted largest first with each category's share. Savings count as spending here; income groups don't.

All report figures use the same derivations as the Budget page — spending comes from your assigned transactions, so the reports always agree with the budget.

## 8. People & sharing

AllotJar is solo-friendly by default: on your own, the sharing features stay out of the way. The **People** page is where you bring others into your budget when you're ready.

### Adding people

- **Add a person** with their name. A "person" is a member of your household budget — useful for splitting shared costs and dividing savings even before anyone else signs in.
- If one of the people you add is **you**, mark **"This is me"** to link your own login to that person.

### Inviting someone to sign in

When you want someone else to log in and use the budget with you, **invite** them from their person entry. They get their own sign-in and join your household. People you've added but not invited simply exist as budget members until you're ready.

### Roles and access

Shared logins have a role that controls what they can do:

- **Owner / Admin** — full access, including changing the budget structure and settings.
- **Limited** — can record transactions, mark bills paid and run allocation, but can't change the budget structure or settings.
- **Read-only** — can view everything but can't make changes.

When your access is limited or read-only, a banner at the top of the page reminds you what you can and can't do.

### Multiple households

You can belong to more than one household (for example your own and a shared one). When you do, your account menu lists them with a checkmark on the active one — switch between them there. The menu shows the active household's name (or "Personal") under your name.

## 9. Income allocation

Once your household is **shared** (you've added at least one other person), an **Allocation** item appears in the sidebar. Income allocation answers "we both got paid — now what?":

1. **Pool** everyone's income for the month.
2. **Cover** the shared costs (your expenses and savings) from the pool.
3. **Split** whatever's left into each person's own savings, by whatever rule you set up.

You set this up once (who shares, how the remainder is divided), and AllotJar **previews** the result before anything is applied — so you can see exactly who contributes what and who keeps what before you commit.

The suggested amounts stay a plan until you move the money at the bank. **Allocate** asks you to confirm **I've completed these transfers** and the date the money left the source account, then records one transfer per person as *in transit*; confirm each receipt on the Transactions page when the savings account shows it. Running Allocate again keeps transfers that haven't changed, replaces an in-transit one whose amount changed, and won't discard a transfer whose receipt you've already confirmed.

## 10. Your account & settings

Open the menu under your name and choose **Account settings** to manage:

- **Display name** — how you appear in the app and to others in a shared household.
- **Preferred currency** and **number format** — how amounts are shown and entered (a display preference, not a currency conversion).
- **Change password** — set a new password for your login.

If you belong to more than one household, you can also **switch households** from the same menu (see [Multiple households](#multiple-households)).

## 11. Appearance: light & dark

The **theme toggle** on the right of the top bar switches between **light** and **dark**. AllotJar follows your system preference the first time and remembers your choice on this device afterwards.

## 12. Feature flags (for self-hosters)

Everything beyond the classic budgeting core can be switched off, turning AllotJar into a "pure budgeting" app. In the API's configuration (`appsettings.json`), under the `Features` section:

```json
"Features": {
  "Accounts": true,
  "Jars": true,
  "Reports": true,
  "HouseholdAllocation": true,
  "HouseholdAccess": true,
  "MultiCurrency": true,
  "CamtImport": true,
  "Analytics": false
}
```

| Flag | When off |
|---|---|
| `Accounts` | The Accounts pages, nav link and all account pickers disappear; account endpoints return 404. |
| `Jars` | The Jars page and nav link disappear; jar endpoints return 404. |
| `Reports` | The Reports page and nav link disappear; report endpoints return 404. |
| `HouseholdAllocation` | The People and Allocation pages and the income-allocation engine are hidden. |
| `HouseholdAccess` | Multi-user logins/roles for a household are disabled. |
| `MultiCurrency` | Reserved for future multi-currency support. The app is single-currency today, so this flag has no user-facing effect yet. |
| `CamtImport` | Reserved for future bank-statement import (the parser is retained for an upcoming Open Banking integration). Gates the import API; there is no import UI today. |
| `Analytics` | Off by default. When on (and a build-time measurement ID is present), privacy-safe, consent-gated usage analytics load. |

Every flag except `Analytics` defaults to **on**. A disabled feature is enforced server-side too — its API stops responding, not just its buttons. Restart the API after changing flags.

## 13. Everyday tips

- **A sensible monthly rhythm:** create the month by copying the previous one → adjust planned amounts until the banner is green → during the month, add transactions and clear the *Unassigned only* list → tick bills as you pay them → glance at Reports at month-end.
- **Inline editing everywhere:** click a value, type, press **Enter** (or click away) to save, **Escape** to cancel. A small pulsing dot means a save is in flight; failed saves roll back and show an error.
- **Don't fear deletes:** deleting budget lines or accounts never deletes transactions — they just become unassigned/untagged.
- **The banner won't balance?** Remember savings contributions count as assignments. If you're over-budgeted, trimming a savings contribution is often the easiest fix.
- **A line's Spent cell is read-only?** That's by design — every line's Spent is the sum of the transactions assigned to it. To change it, assign (or unassign) transactions on the Transactions page.
- **Budgeting with someone?** Add them under **People**, then use **Allocation** to pool income, cover the shared costs and split the rest — all previewed before anything moves.

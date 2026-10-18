# AllotJar — User Guide

AllotJar is a zero-based budgeting app crafted in Europe and at home anywhere: every unit of your income gets a job before the month starts, in whatever currency you budget. This guide walks through every page of the app, what each control does, and how the numbers behind them are calculated.

---

## Contents

1. [The idea: zero-based budgeting](#1-the-idea-zero-based-budgeting)
2. [Signing in & getting around](#2-signing-in--getting-around)
   - [Registering and signing in](#registering-and-signing-in)
   - [The layout: sidebar, top bar and your account menu](#the-layout-sidebar-top-bar-and-your-account-menu)
3. [The Dashboard](#3-the-dashboard)
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
   - [Refunds](#refunds)
   - [Paid in another currency](#paid-in-another-currency)
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

- Open the app and you land on the sign-in card. New here? Switch to **Create account** at the top of the card and fill in your **name**, **email**, a **password of at least 8 characters**, your **currency** and **number format**, and accept the **Terms**. Registration signs you in immediately. Your household starts empty — there is no sample data — and the Dashboard shows a short **Set up your budget** checklist: add your accounts with their opening balances, create this month's budget, then add a jar from an account.
- The **currency** you pick is your budget's currency: the whole budget and all its accounts are kept in it. You can change it until your budget has its first account, month or transaction; after that it is fixed, because changing it would relabel money already recorded. The **number format** only controls how amounts are shown and entered. The **(i)** beside **Currency** on the form sums this up.
- Your data is private to your login. (You can deliberately share a household with other people — see [People & sharing](#8-people--sharing).)
- Your session is kept alive securely in the background, so you stay signed in between visits without re-entering your password.
- Forgot your password? Use the **Forgot password?** link on the sign-in card — we'll email you a reset link (valid for 2 hours). Setting a new password signs you out everywhere else and signs you straight in on the device you used.
- Prefer not to manage a password? Use **Continue with Google** on the sign-in card — it both signs you in and, the first time, creates your account (you'll just confirm the Terms). If you already have a password account with the same Google email, signing in with Google links to it, so either method works from then on. A Google-only account has no password; to add one later, use **Forgot password** with that email from the Account page.

### The layout: sidebar, top bar and your account menu

Every signed-in page shares the same chrome:

- **The sidebar** (left on desktop; a scrollable row of pills along the top on a narrow screen) is the primary navigation: **Dashboard · Transactions · Accounts · Jars · Reports · People · Help**. An **Allocation** item joins them once you share your household with someone.
- **The top bar** opens every data screen with a **month picker** (`‹ June 2026 ›`), the signature **Zero-based** pill, and the **light/dark** theme toggle. On an account's own page it starts with a back arrow to Accounts.
- **Your account menu** is the chip with your initials at the bottom of the sidebar (top-right on mobile). It holds **Account settings**, **switching households** (if you belong to more than one), and **Sign out**.

The **Help** page is a quick reference to everything below, with a button to replay the welcome tour.

## 3. The Dashboard

This is the home page — your plan for one calendar month.

### Choosing a month

Use the **‹ / ›** arrows in the top bar to move between months. Every month-scoped screen (Dashboard, Reports, allocation) follows the month you pick here, so they always agree.

### Creating a month

If the month you're viewing has no budget yet, you'll see three ways to start:

- **Copy last month's budget** — brings over your whole structure and planned amounts (actuals reset to zero, bills reset to unpaid). This is the normal month-to-month flow.
- **Start blank** — a budget with just an Income group. If any of your people has a **Default income** on the People page, the group starts with one income line per person at that amount, attributed to them; otherwise it is empty.
- **Start from a template** — quick-start layouts (**Essentials**, **Student**, **Family**), each a ready set of income and expense groups and lines with amounts at zero for you to fill in. Templates never create jars: add those from an account on the Jars page (or with **Add jar** in a Savings group) so each has a home for its money.

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
- Delete a line or group with its delete control — any transactions assigned to a deleted line simply become unassigned, they are not lost. A Savings group can't be deleted while it holds a jar's line: skip that month's contribution or archive the jar instead (see below). An empty Savings group deletes like any other.

### Spent: tracked from transactions

Every line's **Spent** value is the live total of the transactions assigned to that line — it's always read-only, and there is no manual entry. To fill it in, assign transactions to the line (or split one across several lines); a line with no transactions shows **€0**.

**How it works:** spent values are never stored as a separate number that can drift — they're recomputed from your transaction register every time the page loads. Income lines total *income* transactions; expense lines total *expense* transactions; split transactions contribute exactly their slice.

### Savings groups

A **Savings** group (shown in violet) holds your jars — "Car repairs", "Holidays", "Christmas" — whose money **rolls over from month to month** instead of resetting. Every line in a Savings group *is* a jar, so the group offers **Add jar** rather than a bare line. It opens the same form as the Jars page: name the jar, give it a target and the date it's needed by (or how often it repeats and its next due date, or a fixed amount to set aside each month), choose the **account that holds its money**, and its contribution line lands in this month and every later one, in the group you added it from (in a later month, the group with the same name).

- The **Planned** amount on a savings line is this month's *contribution*. It counts toward Assigned, just like an expense. It is a plan, not money. AllotJar fills it in from the jar's own plan when you create the month (see [Jars](#6-jars-savings-goals)); if you change a jar's target, deadline or monthly amount later, this month's line and every later month's are updated to the new plan, while past months stay as they were.
- The violet **Available** figure is the jar's **actual balance** at the end of the month you're viewing: the money you've actually set aside in its account, minus what you've spent from it, up to that month. Planned contributions never count until the money is really there (allocated in the account). It reads **Not available** when the jar's account has no balance yet for that date.
- The **Your jars** shelf at the top of the page follows the month you're viewing too: on a past month it shows each jar's balance at that month's end ("€300.00 saved as of 30 Sep 2026") and that month's contribution, judged against the target and deadline the jar had then (changing or archiving a jar later never rewrites a month that is over), on this month today's balance, and on a month that hasn't started yet today's balance ("balances as of today") with the month's planned contribution. It always agrees with the Available figures below it, and it updates as soon as you change a jar's planned amount, create the month, skip a month or add a jar. A payment or deposit recorded elsewhere shows the next time you open the page. The Jars page itself always shows today.
- Spend from a jar the same way you spend from any line — record the expense **from the jar's account** and assign it to the jar's line. The Available balance falls accordingly. AllotJar refuses to put a payment from a different account (or from no account) on a jar's line, because that money never came out of the jar.
- **Skipping a month.** A jar's line can't simply be deleted from a month — the jar's plan would only put it back. Hover the line and click **✕** and AllotJar asks what you mean: **Skip this month** keeps the line in the month at €0, marked **Skipped**, and spreads what the jar still needs over the months that are left (€300 due in December with September skipped becomes €150 in October and €150 in November; the dialog shows those months before you decide). If no month is left before the deadline, it tells you what would stay unplanned and leaves the choice to you. **Plan it again** on a skipped line puts the contribution back, and so does typing an amount on it. **Archive the jar** from the same dialog stops every future contribution instead (the jar must be empty). Past months can't be skipped — what was planned is history.

When you copy a month, savings lines keep their identity, so the balance keeps accumulating. The Jars page shows the same jars with their plan for the month, a progress bar and when the money is due or needed by (see [Jars](#6-jars-savings-goals)).

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

Use the **Add a transaction** form: date, payee, amount, type (**Expense** or **Income**), optionally assign it to a budget line right away, and — if you use [Accounts](#5-accounts) — the account it happened on. Amounts accept a decimal point or comma ("12.50" or "12,50"), and tolerate thousands separators. An amount can also be typed as a little calculation with + − × ÷ (typed as `+`, `-`, `*`, `/`): "20+30" saves as 50.00, "3*19.99" as 59.97, "120/4" as 30.00, in any amount field (a transaction, a split slice, a move between jars, a jar's target). Multiplication and division are worked out first, then addition and subtraction left to right, and the result is rounded to cents ("10/3" saves 3.33, "10/3*3" saves 10.00). A calculation that comes out negative, divides by zero, or looks like a pasted date ("2026-03-10", "2026-10", "10/2026") is refused rather than saved as a number. Known limitation: on an iPhone the number pad that opens for an amount has no operator keys, so a calculation can be typed on a keyboard or an Android phone but not yet on an iPhone.

If you don't pick a budget line, AllotJar quietly fills one in for you: it assigns the new transaction to the same line as your **most recent earlier transaction with the same description**. So once you've categorised "REWE" or your landlord once, repeat payees sort themselves — with no rules to set up. Whatever it can't match is left *Unassigned* for you to place.

**An account never goes below zero.** If a payment (or a transfer out) would take its account below zero on any date — including a back-dated payment that dips a past balance — AllotJar refuses it and tells you the account, the balance it would reach and the date. Record the money that reached the account first, or correct the amount; there is no "post anyway", and nothing is invented to balance it. The same check protects you when you delete or shrink an income that later payments relied on, and when you lower an account's opening balance.

### When the account holds jars

If the account you pick holds [jars](#6-jars-savings-goals), the form asks one more thing:

- **Income** — *Put into jars*: how much of this money goes to each jar. Leave the fields empty to keep it all **unallocated** (you can allocate it later from the Jars page). Example: 500 arrives in Savings, which holds Holiday and Car; you enter Holiday 300 and Car 200, and the account's unallocated money is unchanged.
- **Expense on a jar's Savings line** — nothing to answer: the payment comes out of that jar.
- **Expense on any other line** — *Which jar does this come from?* Defaults to the account's unallocated money; pick a jar if the money was that jar's (a hotel bill on the "Travel" line paid from the Holiday jar, say). An expense with no line always draws from unallocated.

Editing a transaction asks the same questions again, pre-filled with your earlier answer. The register shows a small tag on rows with a jar answer ("→ Holiday 300.00, Car 200.00", "from Holiday").

### Recording a transfer between your own accounts

With two or more accounts, the add form has a **Transfer** mode. A transfer is not income or spending — it never touches a budget line — but it does move money between two accounts, and each bank posts its own side on its own date:

- Enter the amount, the **From** and **To** accounts, and the date the money **left the source account**. Tick **I've completed this transfer** to record it; AllotJar only records transfers you have actually made.
- If you already know when it **arrived**, enter that date too. Otherwise leave it blank: the amount is shown as **in transit** — debited from the source, not yet credited to the destination — until you confirm the receipt from the register row (**Confirm receipt**). AllotJar never guesses an arrival date.
- When importing a statement, a debit you mark as a transfer records the departure in the same way. A credit you mark as a transfer is a receipt whose departure isn't known yet: it is held as **pending review** and doesn't change either balance until you add the departure date (**Add departure date** on the register) or, when the other account's statement already recorded the movement, pick that transfer from the **Already recorded?** list — both statement references are then kept on the one transfer, and nothing moves twice. Candidates with the same amount are only suggestions; nothing is matched for you.
- **Importing into an account that holds jars** asks the same jar questions row by row in the review table: a credit can be divided among the account's jars (blank = unallocated), and a debit on a line that is not a jar's — or a debit marked as a transfer — can name the jar it comes from. Imported rows are posted in date order, and any debit that would take the account below zero on its date is **held**: it stays in the review table with the reason, nothing is posted for it, and the rows that fit are imported. Record the missing deposit (or fix the account) and commit the held rows again, or untick them to discard them. Held rows live only in that review — if you leave the page, upload the statement again and only the rows not yet imported are offered.
- Deleting a transfer removes both sides at once. An account can't be deleted while it is a side of a recorded transfer.
- If the **From** account holds jars, you can say which jar the money leaves (**From jar**; unallocated by default). If the **To** account holds jars and you enter the arrival date, you can divide the receipt among its jars — and when you confirm a receipt later from the register row, the same question is asked then. The source account must be able to cover the departure: a transfer never takes an account below zero.

### Assigning to a budget line

Every transaction row has an assignment dropdown grouped by category. Once assigned, the line's Spent (or an income line's Received) includes this transaction — Spent is always the live total of a line's assigned transactions.

Choose "Unassigned" to detach a transaction again.

When the transaction is an expense from an account that holds jars and you assign it to a line that is not a jar's Savings line, a small prompt asks **which jar it comes from** (unallocated by default). Assigning it to a jar's line needs no answer — the line names the jar.

### Splitting a transaction

One supermarket receipt, several budget lines? Use the **split** control on the row:

- Add two or more split rows, each with a line and an amount.
- The editor shows the **remainder** live; **Save split** only enables when the rows add up *exactly* to the transaction total.
- Expenses split across expense/savings lines; income across income lines.

A split transaction shows a **Split** badge listing its slices, and each slice counts toward its own line. **Remove split** (or re-assigning the whole transaction) undoes it.

For an expense from an account that holds jars, each slice on a jar's Savings line draws from that jar; the split editor asks once which jar the *other* slices come from (unallocated by default).

### Refunds

Money that comes back from a purchase — a returned jumper, a cancelled booking — is not income, and it belongs to the category you spent it from. Record it as a **Refund**:

- In the add form, choose type **Refund** and pick the purchase it refunds under **Refund of** (your payments, newest first). The refund is recorded as money received on the account you choose and on the date it arrived, so your balance is right, but it is never counted as income.
- Leave **Category** empty to put the refund on the same line as the purchase — in the refund's own month, if it arrived later: a September purchase refunded in October reduces October's spending, not September's. Choose a line if it belongs somewhere else. A refund of a purchase that was never categorised stays uncategorised until you place it.
- Already recorded the money as income? Use the ↩ control on the row (**Mark as refund**) and pick the purchase: the row moves off the income line onto the purchase's category. ↩ on a refund (**Not a refund**) turns it back into plain income.

The register shows a teal **Refund** badge with "Refund of {payee} · {date}" under the row, and the purchase itself shows "€X refunded". A refund can be partial, and several refunds can point at one purchase, but together they can never exceed what you paid, and a refund can't be dated before its purchase. A refund can't be split, a purchase with refunds can't be deleted until they are unlinked or removed, and a refund's type stays *money received* (use **Not a refund** first to change it).

### Paid in another currency

Your budget counts one currency. When you paid in another one (a meal abroad, an online order in dollars), AllotJar never converts it for you; the amount that counts is always the one you enter or confirm.

- **Entering it yourself.** In the add form, tick **Paid in another currency**, fill in the currency code and the amount you paid, then enter the amount in your budget currency. **Suggest** fills that amount from the European Central Bank reference rate for the transaction's date, rounded to cents; you can change it before saving. The register shows the foreign figure in small print under the row ("USD 25.00").
- **Rows waiting for their amount.** A statement row in another currency with no budget-currency amount is marked **Needs EUR amount** (your currency). It is not counted anywhere (budget lines, reports, People, jars) until you give it an amount: use **Enter amount** on the row, optionally **Suggest**, then **Confirm amount**. Suggest on its own saves nothing. The Dashboard and People page say how many rows are waiting. A split row has to be unsplit first. On a row from an older account kept in another currency, the account keeps its own amount and the budget counts the amount you enter ("Counts as €14.80" under the row); if you later change that row's amount it waits again for a new one. A payment still waiting for its amount can't be chosen when marking a jar cycle paid.
- **No invented fees.** AllotJar never adds a conversion fee or a spread. If your bank charged one, it is already in the amount the bank shows, or you record it yourself.

### Editing, deleting, finding

- The edit control changes date, payee, amount and type in place (type is locked on a refund and on a purchase that has refunds — see *Refunds*); the delete control removes the transaction.
- The search box filters by payee as you type; **Unassigned only** shows just the transactions still needing a home — a quick way to do your weekly tidy-up.

## 5. Accounts

The **Accounts** page tracks *where your money sits* — current account, savings, cash, or a physical place such as a piggy bank. Credit cards are not accounts here: an account holds money, a card owes it.

- **Add an account** in your budget's currency (every account uses it) with a name, a type, an **opening balance** (zero or more — an account never has a negative balance in AllotJar, even if your bank allows an overdraft) and an **opening date**. The opening balance is what the account held at the *start* of that date. Transactions dated before the opening date stay in your history but never change the balance again — the opening amount already includes them.
- Optionally record the bank's identifiers — **IBAN**, **BIC/SWIFT**, **sort code**, **account number** — so you can tell accounts apart. None is required; they are only checked for format when filled in.
- Each transaction can be tagged with the account it happened on (in the add form or the edit row). The account's **current balance** is then: **opening balance + income − expenses − transfers out + transfers in**, counting only what has posted from the opening date up to today. A balance is shown as **Not available** rather than zero when the account has no opening date yet, or when you look at a date before it.
- Transfers between your own accounts move money on each bank's own date: the source is debited on the day the money left, the destination is credited only once you confirm the receipt. In between, the amount is shown as **in transit** on both cards and belongs to neither balance. A receipt you've identified as a transfer but whose departure date isn't known yet is shown as **pending review** and is not posted to either account until you supply it (see *Transactions* and *Importing*).
- **Total balance** at the top of the page adds up the balances that are available across all accounts; accounts without an opening date, and any older account kept in another currency, are left out and counted under it.
- **An account's own page.** Open an account from its card to see it on its own. At the top, its **Balance** (with any money **in transit** or **pending review** under it) and, for an account that holds jars, **In jars** with the same bar and **not in jars** figure as its card. Below, its **Transactions** with their count, newest first under one heading per month (the year is added for another year): each row shows the date, the payee, its budget line (a jar's line with the jar icon), **Split** or **Unassigned**, or for a transfer the other account (**To** or **From**), any **In transit**, **Returned** or **Pending review** tag, and the amount as this account sees it. A returned transfer and a row dated before the opening date are struck through because they don't change the balance; the latter says **Before opening**, and its **(i)** explains why. **Account details**, beside the list (after it on a phone), shows the type, who holds it, the opening balance and date, and the bank identifiers you recorded. The page only shows: change transactions on *Transactions* and the account from its card. The back arrow before the account's name in the top bar returns to Accounts.
- Editing an account changes its name, type, opening balance, opening date and identifiers. Deleting an account keeps its income and expense transactions (they just lose the account tag), but an account that is a side of a recorded transfer, or that holds a jar's money, can't be deleted until those transfers are removed or those jars moved.
- **What the jars hold.** The card of an account that holds jars has a slim bar showing how much of its balance the jars hold, with the number of jars and the money **not in jars** under it, in the account's currency (the exact amount in the jars is in the card's **⋯** menu); the balance, the jars and what is not in them always add up. If the jars hold more than the account has, the bar turns red and says how much **over** they are; if the positive jars add up to more than the account really holds while a jar below zero hides it (after a payment overdrew one jar, say), it says **Jars exceed account money**. Either way it stays red until you move money out of a jar to cover it; the **(i)** beside it says so. At the top of the page, **In jars** and **Not in jars** add the same figures up across your accounts.

**How it works:** like budget actuals, balances are derived from the register at read time — there's no stored balance to drift out of sync. A split transaction still moved in or out of one account, so its *full* amount counts toward that account regardless of how it's split across budget lines.

### Joint and private accounts

- **Who holds it.** Tick the people from *People* who hold an account under **Held by**. Nobody ticked is the household's own account; one person is a personal account; two or more is a **joint** account — still one account with one balance and one history, whoever holds it. Holding an account doesn't change whose income or spending a transaction counts as.
- **Private accounts.** If you have your own sign-in, an account only you hold can be **private**: nobody else in the household sees it, its balance or its transactions — not even the budget owner — and nobody else can change it. An account you add for yourself starts private (untick **Keep it private** to share it); switch it any time with **Share with household** or **Make private** from its card's **⋯** menu. Joint accounts, the household's own accounts and the accounts of people without a sign-in are always shared. A private account's holders can't change until it is shared.
- **Private money on the budget.** Put a private transaction on a budget line and it counts in the household budget like any other: the others see it on that line with the account shown as **Private account**, and can't change it. Private transactions you leave off the budget stay out of the household's reports and totals, for everyone, and the app never puts them on a line for you, even when their payee has a usual line. A transfer between your private account and a shared one shows on the shared account, the other side named **Private account**; the others can confirm the shared side's bank date (the receipt into it, or the departure from it).
- **Jars keep their account visible.** Every jar is part of the shared budget, so an account a jar uses can't be private, and its card's **⋯** menu says which jar uses it. If you pick a private account for a jar, you're warned what the household would see and choose **Share the account and continue** or **Pick another account**.
- A private account that still has transactions off the budget can't be deleted — kept without their account they would show to everyone. Delete those transactions first, or share the account.
- **Private accounts nobody can reach.** When a sign-in leaves the household, its private accounts stay hidden from everyone. The budget owner's Accounts page lists them under **Private accounts nobody can reach** (name, currency, holder, when it went private and how many entries it has, never a balance or an entry). **Erase…** removes such an account for good after you type its name to confirm, together with everything only its holder could see. Anything the household already saw stays and keeps counting without the account: an entry on a budget line, a refund of a shared purchase, and a shared account's side of a transfer with it, with its bank reference and fee. That side stays out of the reports, the Transactions totals and the Unassigned list, as a transfer would; if you put it on a budget line it counts like any other entry. If a refund on another account points at one of its entries, or a transfer links it to an account a member still keeps private, the erase is refused and says why. An account whose sign-in has an open invitation back into the household is not listed.

## 6. Jars (savings goals)

The **Jars** page is where you set savings targets and watch them fill up. A jar is a share of the money in one of your accounts, with a target: several jars can share one account, and whatever isn't in a jar is that account's **unallocated** money.

With no jars yet, the page offers three to start from: **Car insurance** (a yearly bill), **Summer holiday** (by July) and **Rainy day** (50 a month, no target). Picking one opens the form filled in; change anything you like, and nothing is saved until **Add jar**. **New jar** opens an empty form. Until you add a jar, the **Getting started** checklist also lists **Add a jar**. A jar is held in an account, so with no account yet the page asks you to add one first.

The form never asks what kind of jar it is: your answers decide that.

- **Name** — e.g. "Home insurance", "Summer holiday".
- **Target** — the amount to save up. It is only optional when you set aside a fixed amount each month (below).
- **Needed by** — when the money has to be there. Give the jar a target and this date and AllotJar works out the monthly contribution; the jar is done once it's funded (a new kitchen, a sofa, a trip). Beside the label, **Date** or **Month**: keep **Date** for a payment taken on a set day (a loan repayment on the 15th), or pick **Month** when there is no particular day (a holiday in July, a bill that comes "in March") and choose the month from the list. A month is needed when it begins, so the money is ready by the 1st, exactly as a date on the 1st would be, and the jar reads "Needed by Jul 2027". If it's still short when the month begins, the card says **Behind** while that month runs. The list starts next month; for something due this month, give the date.
- **Repeats** — *Doesn't repeat* unless you say otherwise. Choose **Monthly**, **Every 3 months**, **Every 6 months** or **Yearly** for a cost that comes around again (home insurance, road tax, school fees): the date field becomes **Next due** (a date, or just the month: a jar due in a month stays on the 1st as it repeats), and the jar saves toward each due date, you mark it paid, and it starts again toward the next one — see *Recurring cycles* below. The **What repeating means** hint next to the label sums this up.
- **Held in** — the account that holds this jar's money. Every jar needs one (add an account first if you have none); any account except a credit card will do, and a savings account is the natural choice. A private account reads "Private: saving asks you to share it." (see *Joint and private accounts*).
- **Fixed amount each month** — tick this when you have no date in mind, for a pot you keep topping up (an emergency fund); the **ⓘ** next to it says the same. The date and Repeats make way for **Each month**, the amount to set aside, and the **Target** becomes optional. With a target, the card shows roughly how many months that will take ("About 6 months to go (estimate)", never a deadline) and the last contribution is capped at what remains; without one, the jar just keeps going. Ticked on a jar that repeats, it warns "It will stop repeating."

**More options** folds away the two things a first jar rarely needs. When you edit a jar only the second is offered, and the fold is left out when there is nothing to show in it.

- **Already set aside** and **Set aside on** — money that is *already in that account* which you want to count as this jar's, and the date you set it aside. This divides the account's unallocated money into the jar; it never adds money (its **ⓘ** says so). AllotJar checks the account really had that much unallocated on that date.
- **Include the deadline month** — shown only when the date isn't the 1st of a month. Its **ⓘ** explains: by default the plan finishes the month *before*, so the money is in the account by the deadline. Tick this only if the deadline month's contribution will reach the account before then.

**How the plan is worked out.** The remaining amount (target minus what the jar already holds) is split evenly, to the cent, over the months up to the one before the deadline; any rounding remainder goes into the last month, so the months add up exactly. The month you're in counts as a contribution month until it ends, and the deadline day itself never does: a jar created in September with €300 due on 1 December plans €100 in September, October and November. If you save less than planned one month, the next month's plan is recalculated from what the jar actually holds; if the deadline is this month or already passed, the whole remainder is planned now.

As you fill the form, a one-line preview shows the schedule the jar will actually be given — "€100.00 a month · Sep 2026 – Nov 2026" (the last month is when the jar is funded; the date and Repeats fields already say when it's due and how often), "€50.00 every month" for a pot you keep topping up, or "€50.00 a month · about 4 months to go (estimate)" for a fixed amount with a target. When the months differ it reads "€100.00 in total · …" and lists each month. It appears once the jar has a target and a date, or a monthly amount. If a month's budget already exists and the contribution would push it over its income, the preview says so in red ("Over budget: Oct 2026 by €20.00"); the full contribution is still planned, and you decide which lines to adjust.

Each jar card shows its **actual balance** and the account it is held in, a **progress bar**, a **status** chip where it matters (Behind, Overspent, Funded, **Completed** for a jar you have marked done, **Deadline missed** and **Funded late** for a cycle of a jar that repeats, **Needs a plan** for a jar with neither a date nor a monthly amount), and this month's three figures — **Plan** (the month's contribution), **in** (what has actually gone into the jar since the month began) and **to go** (what's still to set aside). The plan never shrinks because money landed. Under it the card says when the money is needed — "Needed by 1 Jul 2027", or "Due 1 Dec 2026 · yearly" for a jar that repeats, and "Needed by Jul 2027" or "Due Mar 2027 · yearly" when you gave just the month — the estimate for a fixed monthly target ("About 6 months to go (estimate)"), or "€50.00 every month" for a pot you keep topping up. The card's buttons (**Mark paid**, **Move money**, **Edit** and the like) sit in a row along its bottom. The page header totals your **Total saved**, everything planned **This month** across your jars, and the number of **active jars**, and lists each account's **unallocated** money.

**Recurring cycles.** A jar that repeats saves toward one due date at a time — its current *cycle* — and AllotJar never moves money at a due date; only the payments you record do.

- **Paid the bill?** Click **Mark paid** on the card and choose the payment that settled it. The list shows the payments made from the jar (the expenses on its Savings line, from its account); tick **Show payments from other accounts** if you paid the bill from elsewhere. Marking the cycle paid closes it and the jar starts saving toward its next due date with whatever it still holds: save €600, pay a €550 bill, and €50 carries forward, so the next cycle needs €550. The target itself stays until you change it. Paying before the due date is fine — even if the payment empties the jar, the cycle counts as met on time once you mark it paid, including on the months before you marked it. A payment belongs to one cycle, and AllotJar never guesses which: you always choose.
- **The due date arrives with the money there** and no payment recorded yet: the jar simply moves on to its next due date. The card's *Last cycle* line says "Last cycle funded on time" with a **Record the payment** link, so you can still attach the payment later.
- **The due date arrives short**: the jar shows **Deadline missed** in red with what it is short ("Deadline 1 Sep 2026 missed · €150.00 short"). A jar due in a month gets the whole month: while it runs the card says **Behind** in amber, once the jar holds the full amount on any day that month it counts as funded on time (even if the bill is then paid from it), and a payment any day that month is on time; only from the 1st of the next month does it read "Deadline Sep 2026 missed", and this month's plan becomes that whole shortfall. Nothing is rolled forward and nothing is made up for you. If the money then arrives, the card says **Funded late** — the notice stays until you act. Either **Mark paid** (you paid the bill after all) or **Dismiss** the notice: dismissing moves the jar on to its next due date, keeps whatever it holds for that cycle, records nothing as paid and never invents the missing money.

The card's *Last cycle* line always shows how the previous cycle ended — paid (with the date and amount: "Last cycle paid 28 Nov 2025 (€550.00)", ending ", late" if it was paid after the due date), funded on time, funded late or missed. Editing a jar that repeats shows its current due date; saving it unchanged keeps the cycle, while a new date starts the cycle from that date. Set **Repeats** to *Doesn't repeat* and it becomes a one-off jar, needed by that date.

**What counts as saved:** only real money. A jar's balance is what you have actually allocated to it in its account, minus what you have spent from it; the planned contribution on the Dashboard is a plan until the money is there. Money reaches a jar when you set it aside at creation, when you **Move money** into it from another jar or from the account's unallocated funds, or (later) when you allocate a deposit that arrives in the account. Money leaves a jar when you record an expense **from the jar's account** and assign it to the jar's Savings line — a payment can overdraw a jar (it shows **Overspent**), but never the account itself.

**Move money** rearranges money: pick where it comes from (a jar or the account's unallocated money), where it goes, the amount and the date. A jar can give at most what it holds, and the move must leave every jar backed by real money.

- **Inside one account** nothing touches your bank: the account balance doesn't change.
- **Into a jar (or the unallocated money) of another account** is a real bank transfer, so AllotJar records it as one: tick **I have made this transfer**, give the date the money left, and the date it arrived (today by default). Clear the arrival date if the money hasn't landed yet — the amount shows as in transit and the destination jar receives it once you **Confirm receipt** on the Transactions page. The source account must be able to cover it.

Money also reaches jars whenever money reaches their account: recording an income, confirming a transfer receipt, importing a statement credit and committing an income allocation all ask **how much goes to each jar** (see *Transactions*, *Importing* and *Income allocation*).

**Jars and the Dashboard work together:** the jar tells you *what to set aside each month*, and AllotJar seeds that amount onto its **Savings** budget line automatically when you create each month — the same figures the preview showed. Edit a jar any time to change its target, date, monthly amount or how often it repeats: the preview shows the revised schedule, and on Save this month's line and every later month's are updated to it (past months are never touched). Its account can only be changed while the jar is empty — move the money first. Its history stays with the old account. Correcting or deleting a payment or income it had there before the move changes the months before the move; whatever difference that leaves stays in the old account's unallocated money from the day of the move. Such an entry can't be dated after the move, and the move waits for any transfer into the jar that is still in transit, and for any entry in the old account dated after today that puts money into the jar or takes money out of it (change or remove that entry first). From the day of the move, a payment on the jar's line comes from the new account and out of the jar, even if it was first recorded as paid from another jar. A payment dated before the move can go on the jar's line only from the account that held the jar that day. From the old account it comes out of the jar there, and the difference stays in the old account's unallocated money from the day of the move, as a correction does; the new account refuses it, and the message says which account held the jar when the app knows. A payment it keeps on the jar there can be corrected or re-dated only within the time the jar was held there. If the jar had nothing in the old account before it moved (no money and no payments on its line), the app has no record of that stretch, so such a payment goes on another line. Payments the new account already had on the jar's line, dated up to the move day, stay on its unallocated money. If you move a jar away and back again, the payments it made in that account before it left can still be corrected, re-dated within that stretch or split.

**Finishing with a jar.** There are three endings, and none of them moves money or touches your transactions:

- **Mark completed** (jars that don't repeat, from the card) — the jar is done: from this month on nothing more is planned (this month's line drops to what has already gone in, later months' lines go), the money stays in the jar until you move or spend it, and the jar stays listed with a **Completed** chip saying what is left to move. A jar that is overdrawn can't be completed until the shortfall is covered, and a completed jar can't be set to repeat. A jar that repeats isn't completed — you mark its cycle paid, or archive it.
- **Archive** (from Edit) — you're done with the jar and want it out of the way: it must be at zero (move any remainder out, or cover a shortfall). Archiving stops this month's remaining contribution and every later one, hides the jar and keeps its history. Restoring an archived jar plans its contributions again.
- **Delete** (from Edit, offered only when it applies) — for a jar that has never held any money: it disappears with the lines it had planned, in every month. A jar that has ever held money keeps its history and can only be archived.

## 7. Reports

The **Reports** page shows your money over time: a row of key figures, then **Trend** and **Jar spending** for the year (on the left on a wide screen) and **Spending** for one month (on the right, staying in view as you scroll). On a phone the cards read Trend, Spending, then Jar spending. Each **(i)** says what its figure covers.

- **Key figures** — **Saved this month** (the latest month's received income minus what you spent, refunds taken off; the line under it says what you spent), **Avg monthly spend** over your recent months (up to the last six budgets; its **(i)** names the months, including a month in progress or one budgeted ahead, and how many payments in another currency aren't counted yet), and the latest month's **Savings rate** (saved ÷ received).
- **Trend** — the year's months, from the first one with anything recorded. **Chart** shows what you spent each month as a bar against the income you received as a dashed line; the month in progress is hatched and marked *so far*. **Table** shows the same months as figures: **Received**, **Spent** and **Net** (received − spent), then **Budgeted** income and the **Variance** between received and budgeted (shown signed: `+€200.00` when more came in than planned, `-€200.00` when less), with the year's totals. A month without a budget shows dashes for Budgeted and Variance but still shows what you received and spent; the month in progress is greyed out until it ends. Under the months, **Average month by category** gives each category's yearly average and total (a category that received refunds says "after €X refunded"; a Savings group is marked *jars*, Uncategorised *Review*). **‹ / ›** in the card's header change the year for Trend, Jar spending and the averages.
- **Spending** — where one month's money went (pick the month in the card's header; the latest by default), largest first: each category with its amount, its share of the month and a bar. Where the year shown has an average for the category, a small tick on the bar marks an average month. Savings groups count as spending here (what their jars paid for) and are marked *jars*; income groups don't.
- **Jar spending** — what each jar paid out in the year shown, the jars that paid most first, with each jar's total. **Chart** shows a small mark for each month; **Table** shows every month's figure, each jar's total and a total across the jars (when they all use one currency). A payment counts wholly against the jar it was paid from: €50 at the vet paid from the Pets jar reads as €50 under Pets, and the €30 you moved in from Food to cover it is not spending from Food (money moved between jars is never spending). A refund back into a jar reduces the month it was received, and the total says "after €X refunded". A jar with nothing paid shows a dash; an archived jar stays on the list while the year still has a figure for it. The card is left out when you have no jars.

Two things keep the reports honest:

- **Uncategorised spending is included.** Transactions you haven't placed on a line yet appear as their own **Uncategorised** row in Spending (with an **Assign N** link to the register), so the month's total is complete — categorising a transaction later moves money between rows without changing the total. Uncategorised income counts as received income.
- **Refunds reduce spending, not income.** A refund lowers its category's spending in the month it was received, and the row says "after €X refunded". Received income and Variance never include refunds or transfers. A category whose refunds exceeded its spending stays on the list with a negative figure and no share.

All report figures use the same derivations as the Dashboard — categorised spending comes from your assigned transactions, so the reports always agree with the budget. Rows still waiting for their budget-currency amount are left out of every figure, as on the Dashboard: Spending and Jar spending say at their foot how many they left out, with an **€ amount** link to enter them on Transactions.

## 8. People & sharing

AllotJar is solo-friendly by default: on your own, the sharing features stay out of the way. The **People** page is where you bring others into your budget when you're ready.

### Adding people

- **Add a person** with their name. A "person" is a member of your household budget — useful for splitting shared costs and dividing savings even before anyone else signs in.
- If one of the people you add is **you**, choose **This is me** in their ⋯ menu to link your own login to that person.

Each person has a card: their share of the month's income in the ring around their initial, then their **Income**, **Spent** and the savings account they save to. A card's ⋯ holds what you can do with that person (a sheet on phones). The two figures at the top add up the household's income and the spending marked for someone this month.

### Whose income is whose

The People page shows the **same month as the Dashboard** (change it with the month navigator in the top bar). Each person's **Income** is what the month's budget says: the income lines attributed to them (on the Dashboard, each income line has a **Who earns** picker once the household is shared), plus an equal share of any income line left as "Whole household". Their **Share** is that income as a percentage of the household's, and **Spent** is what has been attributed to them in that month. If the month has no budget yet, the figures are zero until you create one.

### Renaming and archiving people

Renaming a person renames their **Pocket Money** budget line in every month too (the line belongs to the person, not to the name); the amounts do not change. A line you renamed yourself keeps your name for it.

**Archiving** a person (**Archive** in their ⋯ menu) hides them from the People page and stops their pocket money from next month on: any pocket-money line already planned for a later month is cancelled. If this month still has pocket money planned beyond what has been paid, AllotJar asks first — **Keep this month** leaves this month's plan as it is, **Cancel remaining** lowers it to what has already been paid (a line nothing was paid against disappears), and **Don't archive** changes nothing. Whatever you choose, every recorded payment and every account balance stays exactly as it was; archiving never deletes transactions.

A person's **Default income** is only a starting figure you keep on file: when you **start a blank month**, each person with a default gets an income line at that amount, attributed to them (a template or copied month keeps its own lines). Nothing is calculated from the default itself: the Allocation page, the shares and the People figures all read the month's budget lines. Amounts paid in another currency count at the budget-currency amount you entered or confirmed; a row still waiting for that amount is left out and counted separately ("+N need EUR amount") until you enter it.

### Inviting someone to sign in

When you want someone else to log in and use the budget with you, choose **Invite to sign in** in their ⋯ menu. They get their own sign-in and join your household. People you've added but not invited simply exist as budget members until you're ready.

### Reviewing who sees your accounts

When your sign-in is linked to a person who already holds accounts — or someone else adds an account for you — a **Review sharing** banner asks you, once, which of those accounts the household sees. Each starts as it is now, and nothing changes until you save your choices. An account a jar uses stays shared and says why. Privacy belongs to your sign-in: if your person is linked to another sign-in, or your sign-in is removed from the household, your private accounts stay with your sign-in and hidden from everyone else, the budget owner included. If your own sign-in is given access again, you see them again. The budget owner can only erase them for good, unseen, from the Accounts page (see [Joint and private accounts](#joint-and-private-accounts)).

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

1. **Pool** everyone's income for the month — the income lines in that month's budget, attributed to each person or shared equally when left as "Whole household". A month with no income lines has nothing to allocate.
2. **Cover** the shared costs (your expenses and savings) from the pool.
3. **Split** whatever's left into each person's own savings, by whatever rule you set up — equally, or in proportion to each person's budgeted income.

You set this up once (who shares, how the remainder is divided), and AllotJar **previews** the result before anything is applied — so you can see exactly who contributes what and who keeps what before you commit.

**The page.** Three figures sit at the top: **Income to allocate** (the month's income lines, pooled; its **(i)** says so), **Shared spending** (shared costs, jars and pocket money) and **To savings** (what's left for everyone's savings). Shared spending and To savings always add up to the income; To savings turns red when shared spending is more than the income. Under them, the **Steps** card shows the month's income as one bar split by step, then a row per step: **Cover shared costs**, **Fund the jars**, **Pocket money** (with what each person gets) and **Split remainder to savings**, which shows the people it goes to. The **(i)** beside **Steps** says what each step is and how it is split. The **Savings** card has a row per person: their share this month and the savings account it goes to, with that account's balance today and the projected balance behind the row's **(i)**.

**Warnings and notes** are short lines above the cards. Each has its full explanation behind its **(i)** and, when there is something to do, a button at its right: **Add pocket money** when the allocation promises money your budget doesn't show yet, **Open the Dashboard** when the month has no income lines, **Assign on the Dashboard** when some income isn't assigned to a person, and **Settings** when there is no account to pay shared costs from (Allocate stays off until there is one).

**Settings** on the Steps card (owners and admins) opens **Allocation settings**: the account to pay shared costs from, the pocket money each person gets, how shared costs are split (**Equally** or **By income**), how savings are sent (**Balance**, which leans toward whoever's savings are lowest, **Equally** or **By income**) and, for Balance, how hard it leans (**Balance lean**, 0 to 100). The **(i)** beside a choice explains it. **Cancel**, or closing the dialog, throws your changes away.

**A person without a savings account.** Their row reads **Stays in** and the name of the account shared costs are paid from: their share isn't transferred when you allocate, it stays in that account. Owners and admins can fix it on the row: **Link account** opens a list of your accounts, savings accounts first (a sheet on a phone), with **Use "…"** at the top when exactly one savings account carries the person's name. Nothing is linked until you pick one. If you have no savings account at all, the button reads **Create a savings account** and takes you to Accounts. A person whose savings account is private to them reads **Private savings account**: only they can record that transfer, so allocating is refused until they share the account or pick a shared one on the People page.

The suggested amounts stay a plan until you move the money at the bank. **Allocate** (in the top bar, or under the figures on a narrow screen) opens the transfers to make: who, from which account to which, and how much, plus any share that stays where it is. On a phone it opens as a sheet from the bottom of the screen. If someone's share would stay in the source account, its title asks **Allocate without {name}?**. Tick **I've completed these transfers** once you have made them. The date the money left reads **Sent today**; press it to pick another date. **Record transfers** then records one transfer per person as *in transit*; confirm each receipt on the Transactions page when the savings account shows it. A short line at the top of the page confirms it, for example **Allocated July · 2 transfers in transit**, with the details behind its **(i)**. Running Allocate again keeps transfers that haven't changed, replaces an in-transit one whose amount changed, and won't discard a transfer whose receipt you've already confirmed. The source account must be able to cover every transfer — allocation never takes it below zero.

When a person's savings account holds jars, Allocate also asks **how much of that person's transfer goes to each jar** (under **Into jars**); whatever you leave blank stays unallocated in the account, and the jars are credited once the receipt is confirmed.

**Pocket money.** If your allocation gives each person pocket money that the month's budget doesn't show yet, the line about it above the cards offers owners and admins **Add pocket money**: it puts one **Pocket Money** line per person into that month's budget. Each line is linked to its person rather than to their name: renaming the person renames the line, and running the sync again updates the same line instead of adding another. Archiving a person stops their pocket money from next month on (see *People & sharing*).

## 10. Your account & settings

Open the menu under your name and choose **Account settings** to manage:

- **Display name** — how you appear in the app and to others in a shared household.
- **Currency** — your budget's currency, which you can change only until your budget has its first account, month or transaction (then it shows as fixed). **Number format** — how amounts are shown and entered.
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
| `MultiCurrency` | The "Paid in another currency" option on the add-transaction form and the currency label on each account disappear. Transactions already waiting for their budget-currency amount can still be confirmed. |
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

# The Workbook Importer — explained simply

This little program is a **robot that reads your big money notebook** (a
`Bank Account Summary` Excel file) and **types everything into the AllotJar
app for you** — then **double-checks its own typing** against the notebook's own totals,
down to the last cent.

You only run it by hand, once. It is not part of the website and never runs on its own.

> **No real data lives in this repo.** The workbook path and owner email are supplied per
> run (`--file` / `--email`, or the `ALLOTJAR_IMPORT_FILE` / `ALLOTJAR_IMPORT_EMAIL`
> environment variables). Every account, name, and figure below is a **made-up example** to
> illustrate the shape of the data — not anyone's real finances.

---

## 🧸 The 5-year-old version

Imagine a household keeps all their money in a big notebook.

- They have a few **piggy banks** (a spending one, some savings ones, a coins jar, and a credit card).
- They have lots of little **jars** for big things later — a *holiday jar*, an *insurance jar*, a *presents jar* — and every month they drop a few coins in each.
- Every time money moves, they **write a line** in the notebook.

The notebook is messy and hard to read. The **app** is a tidy version of the same thing.

This robot **reads the notebook and fills in the app**. After it types each part, it adds
everything up and checks: *“does my total match the total the notebook already wrote at the
bottom?”* If yes ✅ it keeps going. If no ❌ it stops and shouts, so nothing wrong gets saved.

---

## 🗺️ The big picture

```mermaid
flowchart LR
    XLSX[("📒 Bank Account<br/>Summary.xlsx")] --> READ["🤖 Robot reads<br/>the sheets"]
    READ --> CHECK{"🧮 Do my totals match<br/>the notebook's totals?"}
    CHECK -- "✅ matches to the cent" --> DB[("🗄️ AllotJar<br/>database")]
    CHECK -- "❌ off by even 1 cent" --> STOP["🛑 Stop &<br/>don't save"]
    DB --> APP["💶 AllotJar app<br/>(what you see)"]
```

The robot never *guesses* — it copies, and the spreadsheet's own "TOTAL" rows are the
answer key it marks its homework against.

---

## 🏦 Where the money lives (the accounts)

These are the "piggy banks". Each one's balance in the app matches the spreadsheet exactly.
The rows below are **illustrative placeholders**, not real balances:

| Piggy bank | What it's for | Example balance |
| --- | --- | ---: |
| Current Joint Account | day-to-day spending | €0,000.00 |
| Savings Joint Account | living-cost savings | €0,000.00 |
| Member A – Savings Account | member A's assets | €0,000.00 |
| Member B – Savings Account | member B's assets | €0,000.00 |
| Cash at Home | physical cash | €000.00 |
| Visa | a credit card (money you *owe*, so it's negative) | −€000.00 |

There are also the **household members** (e.g. member A and member B) and however many
**saving jars** (sinking funds) the notebook defines.

---

## 🧩 What in the notebook becomes what in the app

```mermaid
flowchart TB
    subgraph Notebook["📒 Spreadsheet sheets"]
        S1["Bank Account – Jan…Dec"]
        S2["Future Savings"]
        S3["Yearly Expenses"]
        S4["Monthly Expenses"]
        S5["Living Costs"]
        S6["Visa"]
    end
    subgraph App["💶 App things"]
        A1["Accounts + Transactions"]
        A2["Household members"]
        A3["Sinking funds (yearly)"]
        A4["Sinking funds (monthly)"]
        A5["Budget: Living-Cost lines"]
        A6["Visa account"]
    end
    S1 --> A1
    S2 --> A2
    S3 --> A3
    S4 --> A4
    S5 --> A5
    S6 --> A6
```

---

## 🪜 The three steps (and they're done in order)

The robot works in three passes, smallest first, checking its work after each one.

### Step 1 — the *things* (reference data)

```mermaid
flowchart LR
    A["Read accounts,<br/>people, jars"] --> B["Check totals vs sheet"] --> C["Save accounts,<br/>people, jars"]
```

The "things" that exist before any money moves: the **piggy banks** (with their starting
balances), the **people** (with their monthly pay), and the **jars** (each with a *target*
— how much it should hold — and how much it *started* the year with).

> ✔️ Checked: jar targets and starting amounts add up to exactly what the sheet says.

### Step 2 — the *plan* (budget)

```mermaid
flowchart LR
    A["Build one monthly plan"] --> B["Copy it for all 12 months"] --> C["Save 12 budget months"]
```

A budget is the **plan for where every euro goes** each month: pay comes in, then it's shared
out across living costs, pocket money, savings, and the jar top-ups — until almost nothing is
left unplanned. The same plan is made for all 12 months of the year.

### Step 3 — the *money moves* (transactions)

```mermaid
flowchart LR
    A["Read every line in<br/>all 12 month sheets + Visa"] --> B["Each line = one transaction<br/>on its piggy bank"] --> C["Add up & check vs<br/>each month's TOTAL"] --> D["Save transactions"]
```

Every single line where money moved becomes one transaction in the app, attached to the
right piggy bank. Living-cost spends (groceries, petrol…) are also **tagged to their budget
line** using the short codes in the sheet (`F&D`, `EE`, `SOAP`…), so the app can show how
much was spent on each.

> ✔️ Checked: after importing, all piggy banks match the spreadsheet's TOTAL for every month, to the cent.

---

## 🧮 “How do we know it’s right?” (reconciliation)

This is the most important idea. The spreadsheet **already writes its own totals** at the
bottom of each sheet (the `TOTAL` row, and little "check ≈ 0" cells). The robot computes its
*own* total from the lines it read, and compares:

```mermaid
flowchart LR
    ME["My total from<br/>the lines I read"] --> EQ{"="}
    SHEET["The total the<br/>sheet already wrote"] --> EQ
    EQ -- yes --> OK["✅ keep going"]
    EQ -- "no, off by X" --> BAD["❌ stop, show the gap"]
```

It’s like adding up your shopping yourself and checking it against the receipt total. If
they don’t match, you don’t pay — you find the mistake first. (That’s how we caught two real
gotchas: the spreadsheet sometimes hides a **refund as a negative number in the “money out”
column**, and the **TOTAL row isn’t always in the same place** on every sheet.)

---

## ⚠️ The one thing that’s only half-done: jar *spending*

This answers “what do you mean about fund-spending tracking?”.

Each jar should show **how much is left = money put in − money taken out**.

- 💰 **Money put in** — the monthly top-ups — is tracked **perfectly**. Every month’s plan
  budgets the right amount into each jar.
- 🛒 **Money taken out** — the spending *from* a jar — is the tricky bit.

Here’s the snag, in kid terms: the notebook labels jar-spending only by **big group**, not by
the **exact jar**. When you buy Netflix *and* Google One *and* Disney+, the notebook just
writes `LIC` ("Licenses") on all of them — it doesn’t say *which* subscription jar. But the app
has a **separate jar for each** (Netflix jar, Google One jar, Disney+ jar…).

So the robot now **guesses the jar from the shop name**: if a charge clearly matches a jar —
“GOOGLE ONE” → the Google One jar, “NETFLIX” → the Netflix jar, the loan and car insurances →
their jars — the spend is dropped into that jar. If the shop name is **ambiguous** (a pharmacy
could be any of several health jars), the spend stays on the **piggy bank only** — so we never
put money in the *wrong* jar.

```mermaid
flowchart LR
    OUT["A spend, e.g.<br/>'GOOGLE ONE …'"] --> Q{"Does the shop name<br/>clearly match a jar?"}
    Q -- "yes" --> JAR["🫙 drop it in that jar"]
    Q -- "not sure" --> BANK["🐷 keep it on the<br/>piggy bank only"]
```

That lands the clearly-matchable spends (all the living-cost ones, plus the obvious yearly and
monthly matches) in a jar. The rest are clear on the piggy bank but left out of the jars on
purpose.

If you ever want **every** yearly spend in a jar, the alternative is to **make the app’s jars
match the notebook’s groups** (Maintenance, Licenses, Accessories, Health, Gifts, …) instead of
one jar per item — then the group codes line up exactly, at the cost of the per-item jars
(Netflix vs Google One).

Either way, **all account balances and all living-cost spending** reconcile to the cent.

---

## ▶️ How to run it

From the repo root. Supply the workbook and owner email each run (nothing is baked in). Each
verb **reads** unless you add `--commit`, and prints a reconciliation table you can eyeball first.

```bash
# tell the tool which workbook and which owner (or set the env vars once)
export ALLOTJAR_IMPORT_FILE="/path/to/Bank Account Summary.xlsx"
export ALLOTJAR_IMPORT_EMAIL="owner@example.com"

# read-only: look at a sheet, or tie reference data out to the sheet, or see what's in the DB
dotnet run --project tools/AllotJar.Importer -- dump "Yearly Expenses"
dotnet run --project tools/AllotJar.Importer -- reconcile
dotnet run --project tools/AllotJar.Importer -- status

# the three import steps (run in this order). --reset wipes the owner's data first.
dotnet run --project tools/AllotJar.Importer -- import --commit --reset
dotnet run --project tools/AllotJar.Importer -- budget --commit
dotnet run --project tools/AllotJar.Importer -- transactions --commit

# optional step 4: tag the Visa transactions with who spent what (per-person columns)
dotnet run --project tools/AllotJar.Importer -- members --commit
```

**Step 4 (`members`)** back-fills household-member attribution onto the already-imported Visa
transactions from the sheet's per-person columns (e.g. column D = first member, E = second
member; a non-member payer's column is left unattributed). A charge wholly one person's gets a
whole-transaction member tag; a shared charge becomes per-member split slices that still sum to
the total — so account balances and budget actuals are unchanged. It needs the
`AddTransactionMember` migration applied (it auto-applies when the app runs). Safe to re-run
(it resets its own tags first).

Useful flags: `--file <path>` (which workbook — **required**, or `ALLOTJAR_IMPORT_FILE`),
`--email <addr>` (whose data — **required**, or `ALLOTJAR_IMPORT_EMAIL`), `--conn <string>`
(which database — defaults to the localdb dev DB), and `--verbose` (per-month detail when a
transaction reconciliation is off).

It’s **safe to re-run**: each step clears the previous import for that owner first, so you
always get a clean, identical result.

---

## 🧱 How the code is organised

| File | Job |
| --- | --- |
| `Program.cs` | reads the command word (`dump`, `reconcile`, `import`, `budget`, `transactions`, `members`) |
| `Workbook.cs` | opens the Excel file *even while it's open in Excel* |
| `ReferenceReader.cs` / `BudgetReader.cs` / `Ledger.cs` | read the sheets into plain data |
| `VisaShareReader.cs` | reads the Visa per-person columns for step 4 |
| `Model.cs` | the plain data shapes (account, member, fund, transaction…) |
| `ReconcileReport.cs` | the "mark my homework vs the sheet" report for step 1 |
| `ImportRunner.cs` | writes step 1 (accounts, members, funds) |
| `BudgetSeeder.cs` | writes step 2 (the 12 budget months) |
| `TransactionSeeder.cs` | writes step 3 (the transactions) + reconciles |
| `MemberAttributor.cs` | writes step 4 (member attribution onto the Visa transactions) |
| `ImporterHost.cs` / `DbCommands.cs` | the database plumbing |

The whole tool is **left out of the solution build** on purpose — it’s a one-off helper, not
part of the app or its tests.

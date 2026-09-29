using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ForeignAmounts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // A household whose months are in more than one currency has no single budget currency
            // to keep counting in, and picking one would relabel the other months' money (rule 42).
            // Stop before anything changes; the owner decides (PR #278, census Q2).
            migrationBuilder.Sql(@"
IF EXISTS (SELECT 1 FROM BudgetMonths GROUP BY OwnerId HAVING COUNT(DISTINCT BaseCurrency) > 1)
    THROW 50001, N'ForeignAmounts: a household has budget months in more than one currency, so its budget currency is ambiguous. Nothing was changed. See PR #278.', 1;
");

            migrationBuilder.AddColumn<decimal>(
                name: "BudgetAmount",
                table: "TransactionSplits",
                type: "decimal(18,4)",
                precision: 18,
                scale: 4,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "BudgetAmount",
                table: "Transactions",
                type: "decimal(18,4)",
                precision: 18,
                scale: 4,
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "OriginalAmount",
                table: "Transactions",
                type: "decimal(18,4)",
                precision: 18,
                scale: 4,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "OriginalCurrency",
                table: "Transactions",
                type: "nvarchar(3)",
                maxLength: 3,
                nullable: true);

            // W08 (rules 42-44, 63, 85; Christopher's "Keep counting", 29 Sep 2026). The app stops
            // converting amounts, so ExchangeRate goes. Before it does, every row is brought to the
            // one rule that remains: a row counts in the budget currency, or waits for its amount.
            // The household's budget currency is the one BudgetCurrency.ResolveAsync reads: its
            // budget months' currency (one, by the guard above), else the owner's chosen currency,
            // else EUR.
            //
            // A counted row counted Amount x ExchangeRate in its month's currency, or in EUR when
            // its month had no budget (the old FxRateResolver). So:
            // 1. A row in another currency whose old figure was in the budget currency keeps
            //    counting exactly that figure. With no account it is restated: the figure becomes
            //    its amount in the budget currency and the foreign amount is kept as
            //    OriginalAmount/OriginalCurrency (not when the rate was 1: that row's amount was
            //    already typed as the budget figure, so there is no foreign figure to keep). On an
            //    account (one kept in another currency, which rule 63 no longer allows, or a row
            //    whose currency differs from its account's, possible before #210) its amount is
            //    that account's money, so it keeps it and the figure is stored beside it as
            //    BudgetAmount (Christopher's "Support them", 29 Sep 2026). Split slices follow
            //    the same way, the largest slice taking the rounding so they still add up.
            // 2. A row in another currency whose old figure was in some other currency (its month
            //    had no budget and the household is not in EUR) has no figure in the budget
            //    currency to keep, so it waits for the user to enter one; on an account, the
            //    confirmed figure is stored as BudgetAmount and the account's money is untouched.
            // 3. A row that waited for a rate but is already in the budget currency counts.
            // A row already in the budget currency keeps its amount. Transfers never enter a budget
            // figure and are left alone.
            migrationBuilder.Sql(@"
DECLARE @household TABLE (OwnerId nvarchar(450) PRIMARY KEY, Budget nvarchar(3) NOT NULL);
INSERT INTO @household (OwnerId, Budget)
SELECT o.OwnerId, COALESCE(
    (SELECT TOP 1 m.BaseCurrency FROM BudgetMonths m WHERE m.OwnerId = o.OwnerId ORDER BY m.[Year], m.[Month]),
    (SELECT NULLIF(UPPER(LTRIM(RTRIM(u.PreferredCurrency))), N'') FROM AspNetUsers u WHERE u.Id = o.OwnerId),
    N'EUR')
FROM (SELECT DISTINCT OwnerId FROM Transactions) o;

DECLARE @foreign TABLE (
    Id uniqueidentifier PRIMARY KEY, Rate decimal(18,6) NOT NULL, Budget nvarchar(3) NOT NULL,
    OnAccount bit NOT NULL, Kept bit NOT NULL);
INSERT INTO @foreign (Id, Rate, Budget, OnAccount, Kept)
SELECT t.Id, t.ExchangeRate, h.Budget,
       CASE WHEN t.AccountId IS NULL THEN 0 ELSE 1 END,
       CASE WHEN COALESCE(
                (SELECT m.BaseCurrency FROM BudgetMonths m
                 WHERE m.OwnerId = t.OwnerId AND m.[Year] = YEAR(t.[Date]) AND m.[Month] = MONTH(t.[Date])),
                N'EUR') = h.Budget THEN 1
            ELSE 0 END
FROM Transactions t
JOIN @household h ON h.OwnerId = t.OwnerId
WHERE t.[Type] <> 2 AND t.FxPending = 0 AND t.Currency <> h.Budget;

-- 2. No figure in the budget currency to keep: wait for the user's amount.
UPDATE t SET FxPending = 1
FROM Transactions t
JOIN @foreign f ON f.Id = t.Id
WHERE f.Kept = 0;

-- 1a. No account: restate the row and its slices in the budget currency.
UPDATE s SET Amount = ROUND(s.Amount * f.Rate, 4)
FROM TransactionSplits s
JOIN @foreign f ON f.Id = s.TransactionId
WHERE f.Kept = 1 AND f.OnAccount = 0;

UPDATE t SET
    OriginalAmount = CASE WHEN f.Rate = 1 THEN NULL ELSE t.Amount END,
    OriginalCurrency = CASE WHEN f.Rate = 1 THEN NULL ELSE t.Currency END,
    Amount = ROUND(t.Amount * f.Rate, 4),
    Currency = f.Budget
FROM Transactions t
JOIN @foreign f ON f.Id = t.Id
WHERE f.Kept = 1 AND f.OnAccount = 0;

WITH ranked AS (
    SELECT s.Id,
           ROW_NUMBER() OVER (PARTITION BY s.TransactionId ORDER BY s.Amount DESC, s.Id) AS Position,
           t.Amount - SUM(s.Amount) OVER (PARTITION BY s.TransactionId) AS Difference
    FROM TransactionSplits s
    JOIN Transactions t ON t.Id = s.TransactionId
    JOIN @foreign f ON f.Id = t.Id
    WHERE f.Kept = 1 AND f.OnAccount = 0)
UPDATE s SET Amount = s.Amount + r.Difference
FROM TransactionSplits s
JOIN ranked r ON r.Id = s.Id
WHERE r.Position = 1 AND r.Difference <> 0;

-- 1b. On an account: the amount stays the account's money; the figure is kept beside it.
UPDATE t SET BudgetAmount = ROUND(t.Amount * f.Rate, 4)
FROM Transactions t
JOIN @foreign f ON f.Id = t.Id
WHERE f.Kept = 1 AND f.OnAccount = 1;

UPDATE s SET BudgetAmount = ROUND(s.Amount * f.Rate, 4)
FROM TransactionSplits s
JOIN @foreign f ON f.Id = s.TransactionId
WHERE f.Kept = 1 AND f.OnAccount = 1;

WITH ranked AS (
    SELECT s.Id,
           ROW_NUMBER() OVER (PARTITION BY s.TransactionId ORDER BY s.Amount DESC, s.Id) AS Position,
           t.BudgetAmount - SUM(s.BudgetAmount) OVER (PARTITION BY s.TransactionId) AS Difference
    FROM TransactionSplits s
    JOIN Transactions t ON t.Id = s.TransactionId
    JOIN @foreign f ON f.Id = t.Id
    WHERE f.Kept = 1 AND f.OnAccount = 1)
UPDATE s SET BudgetAmount = s.BudgetAmount + r.Difference
FROM TransactionSplits s
JOIN ranked r ON r.Id = s.Id
WHERE r.Position = 1 AND r.Difference <> 0;

-- 3. A waiting row already in the budget currency has its amount: it counts.
UPDATE t SET FxPending = 0
FROM Transactions t
JOIN @household h ON h.OwnerId = t.OwnerId
WHERE t.FxPending = 1 AND t.Currency = h.Budget;
");

            migrationBuilder.DropColumn(
                name: "ExchangeRate",
                table: "Transactions");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Lossy by design: rate 1 leaves every restated row at its budget-currency figure, but a
            // row on an account kept in another currency counts its raw amount again (its
            // BudgetAmount is dropped), the rows set waiting or made counting keep their new state,
            // and the foreign reference figures are lost.
            migrationBuilder.DropColumn(
                name: "BudgetAmount",
                table: "TransactionSplits");

            migrationBuilder.DropColumn(
                name: "BudgetAmount",
                table: "Transactions");

            migrationBuilder.DropColumn(
                name: "OriginalAmount",
                table: "Transactions");

            migrationBuilder.DropColumn(
                name: "OriginalCurrency",
                table: "Transactions");

            migrationBuilder.AddColumn<decimal>(
                name: "ExchangeRate",
                table: "Transactions",
                type: "decimal(18,6)",
                precision: 18,
                scale: 6,
                nullable: false,
                defaultValue: 1m);
        }
    }
}

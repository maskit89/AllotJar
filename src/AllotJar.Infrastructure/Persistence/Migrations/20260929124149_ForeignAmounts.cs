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

            // W08 (rules 42-44, 85; Christopher's "Keep counting", 29 Sep 2026). The app stops
            // converting amounts, so ExchangeRate goes. Before it does, every row is brought to the
            // one rule that remains: a row counts in the budget currency, or waits for its amount.
            // The household's budget currency is the one BudgetCurrency.ResolveAsync reads: its
            // first budget month's, else the owner's chosen currency, else EUR.
            //
            // 1. A row the old rate lookup already converted keeps counting exactly as before: its
            //    counted figure (Amount x ExchangeRate) becomes its amount in the budget currency,
            //    the foreign figure is kept as OriginalAmount/OriginalCurrency, and split slices
            //    are converted the same way, the largest slice absorbing the rounding so they still
            //    add up. Only rows on no account: a row on an account is that account's money.
            // 2. A row on an account kept in another currency (rule 63 no longer allows one)
            //    cannot be restated without changing that account's balance; it waits instead.
            // 3. A row that was waiting for a rate but is already in the budget currency counts.
            // Transfers never enter a budget figure and are left alone.
            migrationBuilder.Sql(@"
DECLARE @household TABLE (OwnerId nvarchar(450) PRIMARY KEY, Budget nvarchar(3) NOT NULL);
INSERT INTO @household (OwnerId, Budget)
SELECT o.OwnerId, COALESCE(
    (SELECT TOP 1 m.BaseCurrency FROM BudgetMonths m WHERE m.OwnerId = o.OwnerId ORDER BY m.[Year], m.[Month]),
    (SELECT NULLIF(UPPER(LTRIM(RTRIM(u.PreferredCurrency))), N'') FROM AspNetUsers u WHERE u.Id = o.OwnerId),
    N'EUR')
FROM (SELECT DISTINCT OwnerId FROM Transactions) o;

DECLARE @converted TABLE (Id uniqueidentifier PRIMARY KEY, Rate decimal(18,6) NOT NULL, Budget nvarchar(3) NOT NULL);
INSERT INTO @converted (Id, Rate, Budget)
SELECT t.Id, t.ExchangeRate, h.Budget
FROM Transactions t
JOIN @household h ON h.OwnerId = t.OwnerId
WHERE t.[Type] <> 2 AND t.FxPending = 0 AND t.AccountId IS NULL AND t.Currency <> h.Budget;

UPDATE s SET Amount = ROUND(s.Amount * c.Rate, 4)
FROM TransactionSplits s
JOIN @converted c ON c.Id = s.TransactionId;

UPDATE t SET
    OriginalAmount = t.Amount,
    OriginalCurrency = t.Currency,
    Amount = ROUND(t.Amount * c.Rate, 4),
    Currency = c.Budget
FROM Transactions t
JOIN @converted c ON c.Id = t.Id;

WITH ranked AS (
    SELECT s.Id,
           ROW_NUMBER() OVER (PARTITION BY s.TransactionId ORDER BY s.Amount DESC, s.Id) AS Position,
           t.Amount - SUM(s.Amount) OVER (PARTITION BY s.TransactionId) AS Difference
    FROM TransactionSplits s
    JOIN Transactions t ON t.Id = s.TransactionId
    JOIN @converted c ON c.Id = t.Id)
UPDATE s SET Amount = s.Amount + r.Difference
FROM TransactionSplits s
JOIN ranked r ON r.Id = s.Id
WHERE r.Position = 1 AND r.Difference <> 0;

UPDATE t SET FxPending = 1
FROM Transactions t
JOIN @household h ON h.OwnerId = t.OwnerId
WHERE t.[Type] <> 2 AND t.FxPending = 0 AND t.AccountId IS NOT NULL AND t.Currency <> h.Budget;

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
            // Every row that counts is in the budget currency, so rate 1 leaves the figures as they
            // are; only the foreign reference figures are lost.
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

using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Two follow-ups to AddFxPending. (1) A filtered index for the reconcile query, which now
    /// runs on every import — with the flag almost always off, the common "nothing pending" case
    /// becomes a near-free seek. (2) A data backfill flagging the HISTORICAL silent-1:1 rows that
    /// predate the flag: before AddFxPending an unresolvable exchange rate fell back to a silent
    /// rate 1, and those rows would otherwise be excluded from reconciliation forever. A
    /// foreign-currency, non-transfer row still at rate 1 whose currency differs from its month's
    /// base (EUR when the month was never budgeted — the same fallback FxRateResolver uses) can
    /// only be the old fallback, so mark it pending; the next reconcile pass fetches the real
    /// rate, and a genuinely-1:1 row simply gets re-stamped and cleared. Transfers are excluded:
    /// they are pinned at rate 1 by design and never enter budget actuals.
    /// </summary>
    public partial class BackfillFxPending : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"
UPDATE t
SET t.FxPending = 1
FROM Transactions t
LEFT JOIN BudgetMonths m
    ON m.OwnerId = t.OwnerId
   AND m.[Year]  = YEAR(t.[Date])
   AND m.[Month] = MONTH(t.[Date])
WHERE t.ExchangeRate = 1
  AND t.[Type] <> 2 -- TransactionType.Transfer
  AND t.Currency <> COALESCE(m.BaseCurrency, 'EUR');
");

            migrationBuilder.CreateIndex(
                name: "IX_Transactions_OwnerId_FxPending",
                table: "Transactions",
                columns: new[] { "OwnerId", "FxPending" },
                filter: "[FxPending] = 1");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Transactions_OwnerId_FxPending",
                table: "Transactions");
        }
    }
}

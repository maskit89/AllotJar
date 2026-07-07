using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class UniqueOwnerBankReference : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Transactions_OwnerId_BankReference",
                table: "Transactions");

            // Existing databases may already hold exact-reference duplicates (the very bug this
            // index prevents: double-clicked or concurrent commits). Creating a UNIQUE index over
            // them would fail the migration — and migrations auto-apply at startup — so first
            // remove the surplus copies. Within each (OwnerId, BankReference) group we keep the
            // most valuable row: one the user categorised (whole-row line), else one with split
            // slices, else a stable arbitrary pick (Guid Ids carry no age); the rest are
            // byte-identical bank rows imported twice. Split slices on removed rows go with them
            // (FK cascades).
            migrationBuilder.Sql(@"
DELETE FROM [Transactions]
WHERE [Id] IN (
    SELECT [Id] FROM (
        SELECT t.[Id],
               ROW_NUMBER() OVER (
                   PARTITION BY t.[OwnerId], t.[BankReference]
                   ORDER BY CASE WHEN t.[BudgetItemId] IS NOT NULL THEN 0
                                 WHEN s.[TransactionId] IS NOT NULL THEN 1
                                 ELSE 2 END,
                            t.[Id]) AS rn
        FROM [Transactions] t
        LEFT JOIN (SELECT DISTINCT [TransactionId] FROM [TransactionSplits]) s
            ON s.[TransactionId] = t.[Id]
        WHERE t.[BankReference] IS NOT NULL
    ) ranked
    WHERE ranked.rn > 1
);
");

            migrationBuilder.CreateIndex(
                name: "IX_Transactions_OwnerId_BankReference",
                table: "Transactions",
                columns: new[] { "OwnerId", "BankReference" },
                unique: true,
                filter: "[BankReference] IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Transactions_OwnerId_BankReference",
                table: "Transactions");

            migrationBuilder.CreateIndex(
                name: "IX_Transactions_OwnerId_BankReference",
                table: "Transactions",
                columns: new[] { "OwnerId", "BankReference" });
        }
    }
}

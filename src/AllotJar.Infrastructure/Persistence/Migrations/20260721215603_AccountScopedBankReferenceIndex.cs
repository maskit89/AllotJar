using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AccountScopedBankReferenceIndex : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Transactions_OwnerId_BankReference",
                table: "Transactions");

            migrationBuilder.CreateIndex(
                name: "IX_Transactions_OwnerId_AccountId_BankReference",
                table: "Transactions",
                columns: new[] { "OwnerId", "AccountId", "BankReference" },
                unique: true,
                filter: "[BankReference] IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Rolling back re-tightens the key: the account-scoped index legitimately allows the
            // same (OwnerId, BankReference) on different accounts, which the old owner-wide unique
            // index forbids. If such rows exist, blindly proceeding would drop the new index and
            // THEN fail on an opaque duplicate-key error, leaving the table with no dedup index at
            // all — so check FIRST and fail with an actionable message while everything is intact.
            // Resolving the duplicates (or not rolling back) is a deliberate operator decision;
            // this migration never deletes data to make a rollback fit.
            migrationBuilder.Sql("""
                IF EXISTS (
                    SELECT 1 FROM [Transactions]
                    WHERE [BankReference] IS NOT NULL
                    GROUP BY [OwnerId], [BankReference]
                    HAVING COUNT(*) > 1)
                    THROW 51000, N'Cannot revert to the owner-wide unique BankReference index: the same (OwnerId, BankReference) now exists on multiple accounts (valid under the account-scoped index). Resolve or remove those duplicates deliberately before rolling back - this migration will not delete data.', 1;
                """);

            migrationBuilder.DropIndex(
                name: "IX_Transactions_OwnerId_AccountId_BankReference",
                table: "Transactions");

            migrationBuilder.CreateIndex(
                name: "IX_Transactions_OwnerId_BankReference",
                table: "Transactions",
                columns: new[] { "OwnerId", "BankReference" },
                unique: true,
                filter: "[BankReference] IS NOT NULL");
        }
    }
}

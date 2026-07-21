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

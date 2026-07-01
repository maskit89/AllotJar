using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddTransactionBankReference : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "BankReference",
                table: "Transactions",
                type: "nvarchar(140)",
                maxLength: 140,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_Transactions_OwnerId_BankReference",
                table: "Transactions",
                columns: new[] { "OwnerId", "BankReference" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Transactions_OwnerId_BankReference",
                table: "Transactions");

            migrationBuilder.DropColumn(
                name: "BankReference",
                table: "Transactions");
        }
    }
}

using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ZeroBudget.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class RenameFundsToSavingsAndJars : Migration
    {
        // Pure rename (Fund -> Savings on the budget line, SinkingFunds -> Jars).
        // Hand-edited from EF's scaffold, which drops+recreates the table (data loss).
        // Everything here is sp_rename-based so existing rows are preserved.

        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Drop the FK so the column/table it spans can be renamed.
            migrationBuilder.DropForeignKey(
                name: "FK_BudgetItems_SinkingFunds_FundId",
                table: "BudgetItems");

            // Rename the budget-line column + its index (keeps the values).
            migrationBuilder.RenameColumn(
                name: "FundId",
                table: "BudgetItems",
                newName: "SavingsId");

            migrationBuilder.RenameIndex(
                name: "IX_BudgetItems_FundId",
                table: "BudgetItems",
                newName: "IX_BudgetItems_SavingsId");

            // Rename the table (keeps every row), then bring its PK + index names along.
            migrationBuilder.RenameTable(
                name: "SinkingFunds",
                newName: "Jars");

            migrationBuilder.Sql("EXEC sp_rename N'PK_SinkingFunds', N'PK_Jars';");

            migrationBuilder.RenameIndex(
                name: "IX_SinkingFunds_OwnerId",
                table: "Jars",
                newName: "IX_Jars_OwnerId");

            // Re-create the FK against the renamed table/column.
            migrationBuilder.AddForeignKey(
                name: "FK_BudgetItems_Jars_SavingsId",
                table: "BudgetItems",
                column: "SavingsId",
                principalTable: "Jars",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_BudgetItems_Jars_SavingsId",
                table: "BudgetItems");

            migrationBuilder.RenameIndex(
                name: "IX_Jars_OwnerId",
                table: "Jars",
                newName: "IX_SinkingFunds_OwnerId");

            migrationBuilder.Sql("EXEC sp_rename N'PK_Jars', N'PK_SinkingFunds';");

            migrationBuilder.RenameTable(
                name: "Jars",
                newName: "SinkingFunds");

            migrationBuilder.RenameIndex(
                name: "IX_BudgetItems_SavingsId",
                table: "BudgetItems",
                newName: "IX_BudgetItems_FundId");

            migrationBuilder.RenameColumn(
                name: "SavingsId",
                table: "BudgetItems",
                newName: "FundId");

            migrationBuilder.AddForeignKey(
                name: "FK_BudgetItems_SinkingFunds_FundId",
                table: "BudgetItems",
                column: "FundId",
                principalTable: "SinkingFunds",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);
        }
    }
}

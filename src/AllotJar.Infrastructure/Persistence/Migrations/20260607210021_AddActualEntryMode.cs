using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddActualEntryMode : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // New column defaults to Manual (0).
            migrationBuilder.AddColumn<int>(
                name: "ActualEntryMode",
                table: "BudgetItems",
                type: "int",
                nullable: false,
                defaultValue: 0);

            // Preserve every existing line's displayed spent: lines that already
            // have assigned expense transactions were rolled-up under the old
            // heuristic, so pin them to Tracked (1). Type = 0 is Expense.
            migrationBuilder.Sql(@"
UPDATE bi
SET bi.[ActualEntryMode] = 1
FROM [BudgetItems] bi
WHERE EXISTS (
    SELECT 1 FROM [Transactions] t
    WHERE t.[BudgetItemId] = bi.[Id] AND t.[Type] = 0
);
");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ActualEntryMode",
                table: "BudgetItems");
        }
    }
}

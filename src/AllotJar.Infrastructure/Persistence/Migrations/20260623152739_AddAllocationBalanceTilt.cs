using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddAllocationBalanceTilt : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "ExcludeFromAllocation",
                table: "BudgetCategories",
                type: "bit",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<int>(
                name: "BalanceLeanPercent",
                table: "AllocationProfiles",
                type: "int",
                nullable: false,
                defaultValue: 25);

            // One-time correction of existing data (no-op on a fresh DB):
            //  * "Personal Savings" was seeded as a normal Expense category, so the allocation
            //    engine double-counted the surplus as an obligation. Flag it as an output.
            //  * Switch the household's terminal savings step to the new balance-aware tilt so
            //    the surplus leans toward whoever's savings account is lower.
            migrationBuilder.Sql(
                "UPDATE [BudgetCategories] SET [ExcludeFromAllocation] = 1 WHERE [Name] = N'Personal Savings';");
            migrationBuilder.Sql(
                "UPDATE [AllocationRules] SET [Split] = 2 WHERE [Type] = 3;"); // SplitRemainderToMembers -> BalanceTilt
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ExcludeFromAllocation",
                table: "BudgetCategories");

            migrationBuilder.DropColumn(
                name: "BalanceLeanPercent",
                table: "AllocationProfiles");
        }
    }
}

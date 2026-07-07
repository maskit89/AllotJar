using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class IncomeAsCategoryGroup : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // 1. Add the category discriminator (existing rows default to Expense = 0).
            migrationBuilder.AddColumn<int>(
                name: "Kind",
                table: "BudgetCategories",
                type: "int",
                nullable: false,
                defaultValue: 0);

            // 2. Move each budget month's flat TotalIncome into a new "Income" group
            //    (Kind = 1) holding one "Take-home Pay" line. This preserves every
            //    existing budget's Remaining-to-Budget once income becomes line-item
            //    based. Done before the column is dropped so the value is still readable.
            migrationBuilder.Sql(@"
DECLARE @CatMap TABLE (CategoryId uniqueidentifier, MonthId uniqueidentifier);

INSERT INTO [BudgetCategories] ([Id], [BudgetMonthId], [Name], [DisplayOrder], [Kind])
OUTPUT inserted.[Id], inserted.[BudgetMonthId] INTO @CatMap (CategoryId, MonthId)
SELECT NEWID(), m.[Id], N'Income', 0, 1
FROM [BudgetMonths] m;

INSERT INTO [BudgetItems] ([Id], [BudgetCategoryId], [Name], [PlannedAmount], [ActualAmount], [DisplayOrder])
SELECT NEWID(), cm.CategoryId, N'Take-home Pay', m.[TotalIncome], 0, 0
FROM @CatMap cm
JOIN [BudgetMonths] m ON m.[Id] = cm.MonthId;
");

            // 3. TotalIncome is now derived from the income lines — drop the column.
            migrationBuilder.DropColumn(
                name: "TotalIncome",
                table: "BudgetMonths");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // 1. Re-create the flat column.
            migrationBuilder.AddColumn<decimal>(
                name: "TotalIncome",
                table: "BudgetMonths",
                type: "decimal(18,4)",
                precision: 18,
                scale: 4,
                nullable: false,
                defaultValue: 0m);

            // 2. Back-fill it from the income-group lines, then remove those groups.
            migrationBuilder.Sql(@"
UPDATE m
SET m.[TotalIncome] = ISNULL((
    SELECT SUM(i.[PlannedAmount])
    FROM [BudgetItems] i
    JOIN [BudgetCategories] c ON c.[Id] = i.[BudgetCategoryId]
    WHERE c.[BudgetMonthId] = m.[Id] AND c.[Kind] = 1
), 0)
FROM [BudgetMonths] m;

DELETE i
FROM [BudgetItems] i
JOIN [BudgetCategories] c ON c.[Id] = i.[BudgetCategoryId]
WHERE c.[Kind] = 1;

DELETE FROM [BudgetCategories] WHERE [Kind] = 1;
");

            // 3. Drop the discriminator (referenced by the SQL above, so dropped last).
            migrationBuilder.DropColumn(
                name: "Kind",
                table: "BudgetCategories");
        }
    }
}

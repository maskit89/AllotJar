using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddBudgetItemMember : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "MemberId",
                table: "BudgetItems",
                type: "uniqueidentifier",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_BudgetItems_MemberId",
                table: "BudgetItems",
                column: "MemberId");

            migrationBuilder.AddForeignKey(
                name: "FK_BudgetItems_HouseholdMembers_MemberId",
                table: "BudgetItems",
                column: "MemberId",
                principalTable: "HouseholdMembers",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            // Conservative backfill: attribute an INCOME line (BudgetCategories.Kind = 1) to the
            // one active member whose name prefixes the line name — the Excel importer named the
            // real household's lines "{Member} — Salary", so those attribute cleanly, while a
            // solo "Take-home Pay" or an ambiguous prefix ("Ann"/"Anna") stays NULL (the
            // exactly-one COUNT guard). Idempotent: only touches rows still NULL.
            migrationBuilder.Sql(@"
UPDATE bi SET bi.MemberId = hm.Id
FROM BudgetItems bi
JOIN BudgetCategories bc ON bc.Id = bi.BudgetCategoryId AND bc.Kind = 1
JOIN BudgetMonths bm ON bm.Id = bc.BudgetMonthId
CROSS APPLY (SELECT m.Id FROM HouseholdMembers m
             WHERE m.OwnerId = bm.OwnerId AND m.IsArchived = 0
               AND bi.Name LIKE m.Name + '%') hm
WHERE bi.MemberId IS NULL
  AND (SELECT COUNT(*) FROM HouseholdMembers m2
       WHERE m2.OwnerId = bm.OwnerId AND m2.IsArchived = 0
         AND bi.Name LIKE m2.Name + '%') = 1;
");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_BudgetItems_HouseholdMembers_MemberId",
                table: "BudgetItems");

            migrationBuilder.DropIndex(
                name: "IX_BudgetItems_MemberId",
                table: "BudgetItems");

            migrationBuilder.DropColumn(
                name: "MemberId",
                table: "BudgetItems");
        }
    }
}

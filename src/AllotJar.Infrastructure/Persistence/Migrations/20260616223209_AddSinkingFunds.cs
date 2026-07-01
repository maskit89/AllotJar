using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddSinkingFunds : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "SinkingFunds",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    OwnerId = table.Column<string>(type: "nvarchar(450)", maxLength: 450, nullable: false),
                    Name = table.Column<string>(type: "nvarchar(120)", maxLength: 120, nullable: false),
                    Kind = table.Column<int>(type: "int", nullable: false),
                    TargetAmount = table.Column<decimal>(type: "decimal(18,4)", precision: 18, scale: 4, nullable: false),
                    TargetDate = table.Column<DateOnly>(type: "date", nullable: true),
                    CoverStart = table.Column<DateOnly>(type: "date", nullable: true),
                    CoverEnd = table.Column<DateOnly>(type: "date", nullable: true),
                    Accrual = table.Column<int>(type: "int", nullable: false, defaultValue: 1),
                    RecurAnnually = table.Column<bool>(type: "bit", nullable: false),
                    OpeningBalance = table.Column<decimal>(type: "decimal(18,4)", precision: 18, scale: 4, nullable: false),
                    OpeningAsOf = table.Column<DateOnly>(type: "date", nullable: true),
                    FundingAccountId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    IsArchived = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SinkingFunds", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_SinkingFunds_OwnerId",
                table: "SinkingFunds",
                column: "OwnerId");

            // Backfill: existing fund lines carry a FundId that previously pointed at
            // nothing. Create one SinkingFund per distinct FundId (id preserved, so the
            // cross-month roll-up in BudgetActuals keeps working) BEFORE the FK below is
            // enforced, or AddForeignKey would fail on existing data. Defaults: Annual /
            // TargetByDate / no target — the user fills these in afterwards.
            migrationBuilder.Sql(@"
                INSERT INTO [SinkingFunds]
                    ([Id], [OwnerId], [Name], [Kind], [TargetAmount], [TargetDate],
                     [CoverStart], [CoverEnd], [Accrual], [RecurAnnually],
                     [OpeningBalance], [OpeningAsOf], [FundingAccountId], [IsArchived])
                SELECT g.[FundId], g.[OwnerId], g.[Name], 0, 0, NULL,
                       NULL, NULL, 1, 0,
                       0, NULL, NULL, 0
                FROM (
                    SELECT bi.[FundId]        AS [FundId],
                           MIN(bm.[OwnerId])  AS [OwnerId],
                           MIN(bi.[Name])     AS [Name]
                    FROM [BudgetItems] bi
                    INNER JOIN [BudgetCategories] bc ON bi.[BudgetCategoryId] = bc.[Id]
                    INNER JOIN [BudgetMonths] bm     ON bc.[BudgetMonthId]    = bm.[Id]
                    WHERE bi.[FundId] IS NOT NULL
                    GROUP BY bi.[FundId]
                ) g
                WHERE NOT EXISTS (SELECT 1 FROM [SinkingFunds] sf WHERE sf.[Id] = g.[FundId]);
            ");

            migrationBuilder.AddForeignKey(
                name: "FK_BudgetItems_SinkingFunds_FundId",
                table: "BudgetItems",
                column: "FundId",
                principalTable: "SinkingFunds",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_BudgetItems_SinkingFunds_FundId",
                table: "BudgetItems");

            migrationBuilder.DropTable(
                name: "SinkingFunds");
        }
    }
}

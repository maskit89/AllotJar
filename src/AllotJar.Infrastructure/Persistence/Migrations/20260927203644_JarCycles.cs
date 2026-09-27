using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class JarCycles : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateOnly>(
                name: "CycleDeadline",
                table: "Jars",
                type: "date",
                nullable: true);

            // W03 (27 September 2026): a Recurring jar's open cycle is now persisted. Until now a
            // passed due date rolled forward silently on every read, so the cycle a user saw was
            // the first one from the anchor at or after today; make exactly that the open cycle
            // (the same closed form as the retired JarSchedule.EffectiveDeadline: whole cycles from
            // the anchor, then one more step while still in the past). Deadline missed applies
            // from here on. Goals (Kind 1) have no cycle.
            migrationBuilder.Sql(@"
UPDATE [Jars] SET [CycleDeadline] = [TargetDate] WHERE [Kind] = 0 AND [TargetDate] IS NOT NULL;
UPDATE [Jars]
   SET [CycleDeadline] = DATEADD(month, (DATEDIFF(month, [TargetDate], CAST(GETUTCDATE() AS date)) / [RecurMonths]) * [RecurMonths], [TargetDate])
 WHERE [Kind] = 0 AND [TargetDate] IS NOT NULL AND [RecurMonths] >= 1 AND [TargetDate] < CAST(GETUTCDATE() AS date);
UPDATE [Jars]
   SET [CycleDeadline] = DATEADD(month, [RecurMonths], [CycleDeadline])
 WHERE [Kind] = 0 AND [CycleDeadline] IS NOT NULL AND [RecurMonths] >= 1 AND [CycleDeadline] < CAST(GETUTCDATE() AS date);
");

            migrationBuilder.CreateTable(
                name: "JarCycles",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    OwnerId = table.Column<string>(type: "nvarchar(450)", maxLength: 450, nullable: false),
                    JarId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Deadline = table.Column<DateOnly>(type: "date", nullable: false),
                    TargetAmount = table.Column<decimal>(type: "decimal(18,4)", precision: 18, scale: 4, nullable: false),
                    Outcome = table.Column<int>(type: "int", nullable: false),
                    BalanceAtDeadline = table.Column<decimal>(type: "decimal(18,4)", precision: 18, scale: 4, nullable: true),
                    PaymentTransactionId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    PaidOn = table.Column<DateOnly>(type: "date", nullable: true),
                    PaidAmount = table.Column<decimal>(type: "decimal(18,4)", precision: 18, scale: 4, nullable: true),
                    ClosedOn = table.Column<DateOnly>(type: "date", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "datetime2", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_JarCycles", x => x.Id);
                    table.ForeignKey(
                        name: "FK_JarCycles_Jars_JarId",
                        column: x => x.JarId,
                        principalTable: "Jars",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_JarCycles_Transactions_PaymentTransactionId",
                        column: x => x.PaymentTransactionId,
                        principalTable: "Transactions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateIndex(
                name: "IX_JarCycles_JarId_Deadline",
                table: "JarCycles",
                columns: new[] { "JarId", "Deadline" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_JarCycles_OwnerId",
                table: "JarCycles",
                column: "OwnerId");

            migrationBuilder.CreateIndex(
                name: "IX_JarCycles_PaymentTransactionId",
                table: "JarCycles",
                column: "PaymentTransactionId",
                unique: true,
                filter: "[PaymentTransactionId] IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "JarCycles");

            migrationBuilder.DropColumn(
                name: "CycleDeadline",
                table: "Jars");
        }
    }
}

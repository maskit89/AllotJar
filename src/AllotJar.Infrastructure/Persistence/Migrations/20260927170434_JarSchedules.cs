using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class JarSchedules : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // HANDOVER O6 (27 September 2026): the spreadsheet-derived accrual modes StraightLine (0),
            // ProportionalPool (2) and DailyRate (3) are retired. Any jar still on one becomes a
            // deadline plan (1) — it keeps its target and date, and plans nothing until it has both
            // (rule 17). The cover window only ever fed StraightLine and goes with it.
            migrationBuilder.Sql("UPDATE [Jars] SET [Accrual] = 1 WHERE [Accrual] <> 1;");

            migrationBuilder.DropColumn(
                name: "CoverEnd",
                table: "Jars");

            migrationBuilder.DropColumn(
                name: "CoverStart",
                table: "Jars");

            migrationBuilder.AddColumn<bool>(
                name: "IncludeDeadlineMonth",
                table: "Jars",
                type: "bit",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<decimal>(
                name: "MonthlyContribution",
                table: "Jars",
                type: "decimal(18,4)",
                precision: 18,
                scale: 4,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "IncludeDeadlineMonth",
                table: "Jars");

            migrationBuilder.DropColumn(
                name: "MonthlyContribution",
                table: "Jars");

            migrationBuilder.AddColumn<DateOnly>(
                name: "CoverEnd",
                table: "Jars",
                type: "date",
                nullable: true);

            migrationBuilder.AddColumn<DateOnly>(
                name: "CoverStart",
                table: "Jars",
                type: "date",
                nullable: true);
        }
    }
}

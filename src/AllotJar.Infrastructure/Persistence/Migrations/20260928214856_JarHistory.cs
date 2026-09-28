using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class JarHistory : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateOnly>(
                name: "ArchivedOn",
                table: "Jars",
                type: "date",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "JarRevisions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    JarId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    EffectiveFrom = table.Column<DateOnly>(type: "date", nullable: false),
                    Kind = table.Column<int>(type: "int", nullable: false),
                    TargetAmount = table.Column<decimal>(type: "decimal(18,4)", precision: 18, scale: 4, nullable: false),
                    TargetDate = table.Column<DateOnly>(type: "date", nullable: true),
                    CycleDeadline = table.Column<DateOnly>(type: "date", nullable: true),
                    Accrual = table.Column<int>(type: "int", nullable: false),
                    MonthlyContribution = table.Column<decimal>(type: "decimal(18,4)", precision: 18, scale: 4, nullable: true),
                    IncludeDeadlineMonth = table.Column<bool>(type: "bit", nullable: false),
                    RecurMonths = table.Column<int>(type: "int", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_JarRevisions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_JarRevisions_Jars_JarId",
                        column: x => x.JarId,
                        principalTable: "Jars",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_JarRevisions_JarId_EffectiveFrom",
                table: "JarRevisions",
                columns: new[] { "JarId", "EffectiveFrom" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "JarRevisions");

            migrationBuilder.DropColumn(
                name: "ArchivedOn",
                table: "Jars");
        }
    }
}

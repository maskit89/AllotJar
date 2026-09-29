using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class JarArchivePeriodsAndArrival : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateOnly>(
                name: "FundingAccountSince",
                table: "Jars",
                type: "date",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "JarArchivePeriods",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    JarId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ArchivedOn = table.Column<DateOnly>(type: "date", nullable: false),
                    RestoredOn = table.Column<DateOnly>(type: "date", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_JarArchivePeriods", x => x.Id);
                    table.ForeignKey(
                        name: "FK_JarArchivePeriods_Jars_JarId",
                        column: x => x.JarId,
                        principalTable: "Jars",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_JarArchivePeriods_JarId_ArchivedOn",
                table: "JarArchivePeriods",
                columns: new[] { "JarId", "ArchivedOn" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "JarArchivePeriods");

            migrationBuilder.DropColumn(
                name: "FundingAccountSince",
                table: "Jars");
        }
    }
}

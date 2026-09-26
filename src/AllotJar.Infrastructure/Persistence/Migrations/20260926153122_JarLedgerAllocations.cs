using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Activates the jar ledger (rules 73–77): every jar has a designated account (required foreign
    /// key), jar money is recorded as allocation operations with postings, accounts carry optional
    /// bank identifiers, and the plan-era jar opening balance is retired. Pre-launch data only
    /// (rule 65): jars that have no account — the seeded, template and Budget-page jars of the old
    /// model — cannot satisfy rule 73 and are removed; their savings lines stay as plain lines
    /// (the SavingsId foreign key sets null) and their transactions are untouched. Nothing is
    /// invented in their place.
    /// </summary>
    public partial class JarLedgerAllocations : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(
                "DELETE FROM [Jars] WHERE [FundingAccountId] IS NULL " +
                "OR [FundingAccountId] NOT IN (SELECT [Id] FROM [Accounts]);");

            migrationBuilder.DropColumn(
                name: "OpeningAsOf",
                table: "Jars");

            migrationBuilder.DropColumn(
                name: "OpeningBalance",
                table: "Jars");

            migrationBuilder.AlterColumn<Guid>(
                name: "FundingAccountId",
                table: "Jars",
                type: "uniqueidentifier",
                nullable: false,
                defaultValue: new Guid("00000000-0000-0000-0000-000000000000"),
                oldClrType: typeof(Guid),
                oldType: "uniqueidentifier",
                oldNullable: true);

            migrationBuilder.AddColumn<string>(
                name: "AccountNumber",
                table: "Accounts",
                type: "nvarchar(34)",
                maxLength: 34,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Bic",
                table: "Accounts",
                type: "nvarchar(11)",
                maxLength: 11,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Iban",
                table: "Accounts",
                type: "nvarchar(34)",
                maxLength: 34,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SortCode",
                table: "Accounts",
                type: "nvarchar(8)",
                maxLength: 8,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "JarAllocations",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    OwnerId = table.Column<string>(type: "nvarchar(450)", maxLength: 450, nullable: false),
                    AccountId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Kind = table.Column<int>(type: "int", nullable: false),
                    Date = table.Column<DateOnly>(type: "date", nullable: false),
                    TransactionId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    Note = table.Column<string>(type: "nvarchar(280)", maxLength: 280, nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "datetime2", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_JarAllocations", x => x.Id);
                    table.ForeignKey(
                        name: "FK_JarAllocations_Accounts_AccountId",
                        column: x => x.AccountId,
                        principalTable: "Accounts",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_JarAllocations_Transactions_TransactionId",
                        column: x => x.TransactionId,
                        principalTable: "Transactions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "JarAllocationPostings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    JarAllocationId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    JarId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    Amount = table.Column<decimal>(type: "decimal(18,4)", precision: 18, scale: 4, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_JarAllocationPostings", x => x.Id);
                    table.ForeignKey(
                        name: "FK_JarAllocationPostings_JarAllocations_JarAllocationId",
                        column: x => x.JarAllocationId,
                        principalTable: "JarAllocations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_JarAllocationPostings_Jars_JarId",
                        column: x => x.JarId,
                        principalTable: "Jars",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Jars_FundingAccountId",
                table: "Jars",
                column: "FundingAccountId");

            migrationBuilder.CreateIndex(
                name: "IX_JarAllocationPostings_JarAllocationId",
                table: "JarAllocationPostings",
                column: "JarAllocationId");

            migrationBuilder.CreateIndex(
                name: "IX_JarAllocationPostings_JarId",
                table: "JarAllocationPostings",
                column: "JarId");

            migrationBuilder.CreateIndex(
                name: "IX_JarAllocations_AccountId",
                table: "JarAllocations",
                column: "AccountId");

            migrationBuilder.CreateIndex(
                name: "IX_JarAllocations_OwnerId_AccountId_Date",
                table: "JarAllocations",
                columns: new[] { "OwnerId", "AccountId", "Date" });

            migrationBuilder.CreateIndex(
                name: "IX_JarAllocations_TransactionId_AccountId",
                table: "JarAllocations",
                columns: new[] { "TransactionId", "AccountId" },
                unique: true,
                filter: "[TransactionId] IS NOT NULL");

            migrationBuilder.AddForeignKey(
                name: "FK_Jars_Accounts_FundingAccountId",
                table: "Jars",
                column: "FundingAccountId",
                principalTable: "Accounts",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_Jars_Accounts_FundingAccountId",
                table: "Jars");

            migrationBuilder.DropTable(
                name: "JarAllocationPostings");

            migrationBuilder.DropTable(
                name: "JarAllocations");

            migrationBuilder.DropIndex(
                name: "IX_Jars_FundingAccountId",
                table: "Jars");

            migrationBuilder.DropColumn(
                name: "AccountNumber",
                table: "Accounts");

            migrationBuilder.DropColumn(
                name: "Bic",
                table: "Accounts");

            migrationBuilder.DropColumn(
                name: "Iban",
                table: "Accounts");

            migrationBuilder.DropColumn(
                name: "SortCode",
                table: "Accounts");

            migrationBuilder.AlterColumn<Guid>(
                name: "FundingAccountId",
                table: "Jars",
                type: "uniqueidentifier",
                nullable: true,
                oldClrType: typeof(Guid),
                oldType: "uniqueidentifier");

            migrationBuilder.AddColumn<DateOnly>(
                name: "OpeningAsOf",
                table: "Jars",
                type: "date",
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "OpeningBalance",
                table: "Jars",
                type: "decimal(18,4)",
                precision: 18,
                scale: 4,
                nullable: false,
                defaultValue: 0m);
        }
    }
}

using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Activates the dated account ledger: an account's opening balance applies from an explicit
    /// opening date (rules 40/67), and a transfer carries one bank leg per account — departure
    /// and receipt dates plus a statement reference per side (rules 51/69/71/72).
    ///
    /// Existing rows: <c>Accounts.OpeningDate</c> stays NULL — no date is invented; such an account
    /// reads as "balance unavailable" until its owner records the date. Existing transfers were
    /// recorded by the single-date model, which applied both legs on <c>Date</c>; that recorded
    /// meaning is preserved by copying <c>Date</c> into both legs (nothing new is inferred), which
    /// also satisfies the check constraint added afterwards. Their single reference stays on the
    /// source leg. The project's development database is being replaced rather than migrated
    /// (rule 65), so this backfill only matters for databases that keep legacy rows.
    /// </summary>
    public partial class AccountOpeningDatesAndTransferLegs : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateOnly>(
                name: "DepartedOn",
                table: "Transactions",
                type: "date",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ReceiptBankReference",
                table: "Transactions",
                type: "nvarchar(140)",
                maxLength: 140,
                nullable: true);

            migrationBuilder.AddColumn<DateOnly>(
                name: "ReceivedOn",
                table: "Transactions",
                type: "date",
                nullable: true);

            migrationBuilder.AddColumn<DateOnly>(
                name: "OpeningDate",
                table: "Accounts",
                type: "date",
                nullable: true);

            // Legacy single-date transfers (Type = 2): both legs were applied on Date. Keep that
            // recorded meaning; do not leave them dateless (the ledger refuses to read those).
            migrationBuilder.Sql(
                "UPDATE [Transactions] SET [DepartedOn] = [Date], [ReceivedOn] = [Date] " +
                "WHERE [Type] = 2 AND [DepartedOn] IS NULL AND [ReceivedOn] IS NULL;");

            migrationBuilder.CreateIndex(
                name: "IX_Transactions_OwnerId_TransferAccountId_ReceiptBankReference",
                table: "Transactions",
                columns: new[] { "OwnerId", "TransferAccountId", "ReceiptBankReference" },
                unique: true,
                filter: "[ReceiptBankReference] IS NOT NULL");

            migrationBuilder.AddCheckConstraint(
                name: "CK_Transactions_TransferLegs",
                table: "Transactions",
                sql: "[Type] <> 2 OR [DepartedOn] IS NOT NULL OR [ReceivedOn] IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Transactions_OwnerId_TransferAccountId_ReceiptBankReference",
                table: "Transactions");

            migrationBuilder.DropCheckConstraint(
                name: "CK_Transactions_TransferLegs",
                table: "Transactions");

            migrationBuilder.DropColumn(
                name: "DepartedOn",
                table: "Transactions");

            migrationBuilder.DropColumn(
                name: "ReceiptBankReference",
                table: "Transactions");

            migrationBuilder.DropColumn(
                name: "ReceivedOn",
                table: "Transactions");

            migrationBuilder.DropColumn(
                name: "OpeningDate",
                table: "Accounts");
        }
    }
}

using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class TransferReturnsFeesAndAllocationKeys : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "AllocationKey",
                table: "Transactions",
                type: "nvarchar(100)",
                maxLength: 100,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "BankEntry",
                table: "Transactions",
                type: "nvarchar(40)",
                maxLength: 40,
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "FeeForTransferId",
                table: "Transactions",
                type: "uniqueidentifier",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ReturnBankReference",
                table: "Transactions",
                type: "nvarchar(140)",
                maxLength: 140,
                nullable: true);

            migrationBuilder.AddColumn<DateOnly>(
                name: "ReturnedOn",
                table: "Transactions",
                type: "date",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "ReturnOfTransferId",
                table: "JarAllocations",
                type: "uniqueidentifier",
                nullable: true);

            // An income-allocation transfer kept its app key in BankReference, where a statement
            // match would overwrite it (and the re-run would lose the transfer) and where it hid the
            // departure from matching its source statement. Move the key to its own column; the
            // departure then carries no bank reference until a statement confirms it.
            migrationBuilder.Sql(
                "UPDATE [Transactions] SET [AllocationKey] = [BankReference], [BankReference] = NULL " +
                "WHERE [Type] = 2 AND [BankReference] LIKE 'alloc:%';");

            migrationBuilder.CreateIndex(
                name: "IX_Transactions_FeeForTransferId",
                table: "Transactions",
                column: "FeeForTransferId",
                unique: true,
                filter: "[FeeForTransferId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_Transactions_OwnerId_AccountId_ReturnBankReference",
                table: "Transactions",
                columns: new[] { "OwnerId", "AccountId", "ReturnBankReference" },
                unique: true,
                filter: "[ReturnBankReference] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_Transactions_OwnerId_AllocationKey",
                table: "Transactions",
                columns: new[] { "OwnerId", "AllocationKey" },
                filter: "[AllocationKey] IS NOT NULL");

            migrationBuilder.AddCheckConstraint(
                name: "CK_Transactions_TransferReturn",
                table: "Transactions",
                sql: "[ReturnedOn] IS NULL OR ([Type] = 2 AND [DepartedOn] IS NOT NULL AND [ReceivedOn] IS NULL AND [ReturnedOn] >= [DepartedOn])");

            migrationBuilder.CreateIndex(
                name: "IX_JarAllocations_ReturnOfTransferId",
                table: "JarAllocations",
                column: "ReturnOfTransferId",
                unique: true,
                filter: "[ReturnOfTransferId] IS NOT NULL");

            migrationBuilder.AddForeignKey(
                name: "FK_JarAllocations_Transactions_ReturnOfTransferId",
                table: "JarAllocations",
                column: "ReturnOfTransferId",
                principalTable: "Transactions",
                principalColumn: "Id");

            migrationBuilder.AddForeignKey(
                name: "FK_Transactions_Transactions_FeeForTransferId",
                table: "Transactions",
                column: "FeeForTransferId",
                principalTable: "Transactions",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Return operations (Kind 4) mean nothing without ReturnedOn; their postings cascade.
            migrationBuilder.Sql("DELETE FROM [JarAllocations] WHERE [ReturnOfTransferId] IS NOT NULL;");

            migrationBuilder.DropForeignKey(
                name: "FK_JarAllocations_Transactions_ReturnOfTransferId",
                table: "JarAllocations");

            migrationBuilder.DropForeignKey(
                name: "FK_Transactions_Transactions_FeeForTransferId",
                table: "Transactions");

            migrationBuilder.DropIndex(
                name: "IX_Transactions_FeeForTransferId",
                table: "Transactions");

            migrationBuilder.DropIndex(
                name: "IX_Transactions_OwnerId_AccountId_ReturnBankReference",
                table: "Transactions");

            migrationBuilder.DropIndex(
                name: "IX_Transactions_OwnerId_AllocationKey",
                table: "Transactions");

            migrationBuilder.DropCheckConstraint(
                name: "CK_Transactions_TransferReturn",
                table: "Transactions");

            migrationBuilder.DropIndex(
                name: "IX_JarAllocations_ReturnOfTransferId",
                table: "JarAllocations");

            migrationBuilder.Sql(
                "UPDATE [Transactions] SET [BankReference] = [AllocationKey] " +
                "WHERE [AllocationKey] IS NOT NULL AND [BankReference] IS NULL;");

            migrationBuilder.DropColumn(
                name: "AllocationKey",
                table: "Transactions");

            migrationBuilder.DropColumn(
                name: "BankEntry",
                table: "Transactions");

            migrationBuilder.DropColumn(
                name: "FeeForTransferId",
                table: "Transactions");

            migrationBuilder.DropColumn(
                name: "ReturnBankReference",
                table: "Transactions");

            migrationBuilder.DropColumn(
                name: "ReturnedOn",
                table: "Transactions");

            migrationBuilder.DropColumn(
                name: "ReturnOfTransferId",
                table: "JarAllocations");
        }
    }
}

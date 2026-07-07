using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddTransactionMember : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "MemberId",
                table: "TransactionSplits",
                type: "uniqueidentifier",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "MemberId",
                table: "Transactions",
                type: "uniqueidentifier",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_TransactionSplits_MemberId",
                table: "TransactionSplits",
                column: "MemberId");

            migrationBuilder.CreateIndex(
                name: "IX_Transactions_MemberId",
                table: "Transactions",
                column: "MemberId");

            migrationBuilder.AddForeignKey(
                name: "FK_Transactions_HouseholdMembers_MemberId",
                table: "Transactions",
                column: "MemberId",
                principalTable: "HouseholdMembers",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "FK_TransactionSplits_HouseholdMembers_MemberId",
                table: "TransactionSplits",
                column: "MemberId",
                principalTable: "HouseholdMembers",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_Transactions_HouseholdMembers_MemberId",
                table: "Transactions");

            migrationBuilder.DropForeignKey(
                name: "FK_TransactionSplits_HouseholdMembers_MemberId",
                table: "TransactionSplits");

            migrationBuilder.DropIndex(
                name: "IX_TransactionSplits_MemberId",
                table: "TransactionSplits");

            migrationBuilder.DropIndex(
                name: "IX_Transactions_MemberId",
                table: "Transactions");

            migrationBuilder.DropColumn(
                name: "MemberId",
                table: "TransactionSplits");

            migrationBuilder.DropColumn(
                name: "MemberId",
                table: "Transactions");
        }
    }
}

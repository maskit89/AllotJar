using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// AllotJar no longer keeps bank details (27 October 2026): the four encrypted columns from
    /// EncryptBankDetails are dropped with whatever they held. Down brings back empty columns only.
    /// </summary>
    public partial class RemoveBankDetails : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
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
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "AccountNumber",
                table: "Accounts",
                type: "nvarchar(256)",
                maxLength: 256,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Bic",
                table: "Accounts",
                type: "nvarchar(256)",
                maxLength: 256,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Iban",
                table: "Accounts",
                type: "nvarchar(256)",
                maxLength: 256,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SortCode",
                table: "Accounts",
                type: "nvarchar(256)",
                maxLength: 256,
                nullable: true);
        }
    }
}

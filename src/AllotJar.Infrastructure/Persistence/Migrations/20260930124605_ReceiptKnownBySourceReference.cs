using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ReceiptKnownBySourceReference : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "ReceiptKnownBySourceReference",
                table: "Transactions",
                type: "bit",
                nullable: false,
                defaultValue: false);

            // Exactly the transfers the destination side honoured by their source reference until
            // now: received, with a source reference and no receipt reference of their own. Rows
            // recorded before receipt references existed (the migration marked them received on
            // their date) are among them, and so is any receipt confirmed by hand since; nothing
            // on screen changes at deploy. From here on a receipt confirmed by hand stays clear
            // of the mark, so a destination statement printing the source's reference confirms
            // it instead of skipping it (#279 P3-3).
            migrationBuilder.Sql(
                "UPDATE [Transactions] SET [ReceiptKnownBySourceReference] = 1 " +
                "WHERE [Type] = 2 AND [ReceivedOn] IS NOT NULL AND [BankReference] IS NOT NULL AND [ReceiptBankReference] IS NULL;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ReceiptKnownBySourceReference",
                table: "Transactions");
        }
    }
}

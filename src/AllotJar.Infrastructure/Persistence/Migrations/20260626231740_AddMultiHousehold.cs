using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddMultiHousehold : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_HouseholdMemberships_UserId",
                table: "HouseholdMemberships");

            migrationBuilder.AddColumn<string>(
                name: "ActiveOwnerId",
                table: "AspNetUsers",
                type: "nvarchar(450)",
                maxLength: 450,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_HouseholdMemberships_OwnerId_UserId",
                table: "HouseholdMemberships",
                columns: new[] { "OwnerId", "UserId" },
                unique: true,
                filter: "[UserId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_HouseholdMemberships_UserId",
                table: "HouseholdMemberships",
                column: "UserId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_HouseholdMemberships_OwnerId_UserId",
                table: "HouseholdMemberships");

            migrationBuilder.DropIndex(
                name: "IX_HouseholdMemberships_UserId",
                table: "HouseholdMemberships");

            migrationBuilder.DropColumn(
                name: "ActiveOwnerId",
                table: "AspNetUsers");

            migrationBuilder.CreateIndex(
                name: "IX_HouseholdMemberships_UserId",
                table: "HouseholdMemberships",
                column: "UserId",
                unique: true,
                filter: "[UserId] IS NOT NULL");
        }
    }
}

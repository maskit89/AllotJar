using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddMembershipMemberUniqueIndex : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // The link wasn't 1:1 before this, so existing data may have one budget person linked to
            // several logins. Keep the earliest link and clear the rest, so the unique index applies.
            migrationBuilder.Sql(
                @"WITH dupes AS (
                    SELECT MemberId, CreatedUtc, Id,
                           ROW_NUMBER() OVER (PARTITION BY MemberId ORDER BY CreatedUtc, Id) AS rn
                    FROM HouseholdMemberships
                    WHERE MemberId IS NOT NULL)
                  UPDATE dupes SET MemberId = NULL WHERE rn > 1;");

            migrationBuilder.CreateIndex(
                name: "IX_HouseholdMemberships_MemberId",
                table: "HouseholdMemberships",
                column: "MemberId",
                unique: true,
                filter: "[MemberId] IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_HouseholdMemberships_MemberId",
                table: "HouseholdMemberships");
        }
    }
}

using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class RefreshTokenSignedOut : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "SignedOutUtc",
                table: "RefreshTokens",
                type: "datetime2",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "SignedOutUtc",
                table: "RefreshTokens");
        }
    }
}

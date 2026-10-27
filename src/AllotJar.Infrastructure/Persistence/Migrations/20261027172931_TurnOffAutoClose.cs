using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// SQL Server Express creates a database with AUTO_CLOSE on: once the API's pooled
    /// connections go idle (minutes with nobody using the app), the database is closed and its
    /// cached pages and query plans are dropped, so the next visitor waits while every page's
    /// queries read from disk and compile again. Off, as on every other edition. No data changes.
    /// ALTER DATABASE cannot run inside the migration's transaction.
    /// </summary>
    public partial class TurnOffAutoClose : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("ALTER DATABASE CURRENT SET AUTO_CLOSE OFF;", suppressTransaction: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Left off: AUTO_CLOSE on is never wanted (it was part of the 25 Oct outage), and
            // production had it turned off by hand before this migration existed.
        }
    }
}

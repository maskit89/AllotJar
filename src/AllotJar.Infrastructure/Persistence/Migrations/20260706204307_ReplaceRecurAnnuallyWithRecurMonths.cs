using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ReplaceRecurAnnuallyWithRecurMonths : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "RecurMonths",
                table: "Jars",
                type: "int",
                nullable: true);

            // Recurring jars (Kind = 0) renewed yearly under the old boolean; carry
            // that forward as a 12-month cycle. Goals stay null (they never roll).
            migrationBuilder.Sql("UPDATE [Jars] SET [RecurMonths] = 12 WHERE [Kind] = 0;");

            migrationBuilder.DropColumn(
                name: "RecurAnnually",
                table: "Jars");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "RecurMonths",
                table: "Jars");

            migrationBuilder.AddColumn<bool>(
                name: "RecurAnnually",
                table: "Jars",
                type: "bit",
                nullable: false,
                defaultValue: false);

            migrationBuilder.Sql("UPDATE [Jars] SET [RecurAnnually] = 1 WHERE [Kind] = 0;");
        }
    }
}

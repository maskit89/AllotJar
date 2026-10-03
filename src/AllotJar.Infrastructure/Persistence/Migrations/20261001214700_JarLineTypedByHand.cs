using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// O3b: marks a jar line whose planned amount the user typed by hand, so a replant keeps it.
    /// Additive: one bit column, default false; no existing row changes.
    /// </summary>
    public partial class JarLineTypedByHand : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "IsPlannedByHand",
                table: "BudgetItems",
                type: "bit",
                nullable: false,
                defaultValue: false);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "IsPlannedByHand",
                table: "BudgetItems");
        }
    }
}

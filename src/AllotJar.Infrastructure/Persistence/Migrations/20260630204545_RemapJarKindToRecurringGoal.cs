using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace AllotJar.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class RemapJarKindToRecurringGoal : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // JarKind collapsed from {Annual=0, Commitment=1, Goal=2} to {Recurring=0, Goal=1}.
            // Annual and Commitment fold into Recurring; the old Goal (2) becomes the new Goal (1).
            // Order matters: remap the Goal rows (2 -> 1) only after the 0/1 rows are settled.
            migrationBuilder.Sql("UPDATE [Jars] SET [Kind] = 0 WHERE [Kind] IN (0, 1);");
            migrationBuilder.Sql("UPDATE [Jars] SET [Kind] = 1 WHERE [Kind] = 2;");

            // A jar's type now carries its renewal bit, so keep RecurAnnually in lockstep:
            // Recurring renews, Goal is one-and-done.
            migrationBuilder.Sql("UPDATE [Jars] SET [RecurAnnually] = CASE WHEN [Kind] = 0 THEN 1 ELSE 0 END;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Best-effort reverse onto the old {Annual=0, Commitment=1, Goal=2} numbering so that
            // old code reads Goal correctly again. The Annual/Commitment distinction and the
            // original RecurAnnually values cannot be recovered — every Recurring jar returns as Annual.
            migrationBuilder.Sql("UPDATE [Jars] SET [Kind] = 2 WHERE [Kind] = 1;");
        }
    }
}

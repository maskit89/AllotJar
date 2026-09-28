using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using AllotJar.Domain.Entities;

namespace AllotJar.Infrastructure.Persistence.Configurations;

public class BudgetItemConfiguration : IEntityTypeConfiguration<BudgetItem>
{
    public void Configure(EntityTypeBuilder<BudgetItem> builder)
    {
        builder.ToTable("BudgetItems");
        builder.HasKey(i => i.Id);

        builder.Property(i => i.Name)
            .IsRequired()
            .HasMaxLength(120);

        // Financial precision: decimal(18,4) for all currency fields.
        builder.Property(i => i.PlannedAmount)
            .HasPrecision(18, 4);

        builder.Property(i => i.ActualAmount)
            .HasPrecision(18, 4);

        builder.Ignore(i => i.Remaining);

        // Transient presentation values derived at read time, never persisted.
        builder.Ignore(i => i.SavingsAvailable);
        builder.Ignore(i => i.RefundedAmount);

        // IsBill is derived from DueDay; the columns themselves map by convention.
        builder.Ignore(i => i.IsBill);

        // Rule 60 (W04): a jar line whose contribution the user skipped this month.
        builder.Property(i => i.IsSkipped)
            .HasDefaultValue(false);

        // Stable id linking a sinking fund's monthly instances; indexed for the
        // cross-month balance roll-up. Null for ordinary income/expense lines.
        builder.HasIndex(i => i.SavingsId);

        // A fund line's SavingsId is the id of its Jar (shared across the fund's
        // monthly instances). Deleting a fund detaches its lines — they become ordinary
        // lines rather than deleting budget history — mirroring Transaction -> BudgetItem.
        // No navigation property: keeps BudgetItem unaware of the fund definition.
        builder.HasOne(i => i.Jar)
            .WithMany()
            .HasForeignKey(i => i.SavingsId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.HasMany(i => i.Transactions)
            .WithOne(t => t.BudgetItem)
            .HasForeignKey(t => t.BudgetItemId)
            .OnDelete(DeleteBehavior.SetNull);

        // Who earns an income line. Same shape as the proven Transactions/TransactionSplits
        // member FKs (SetNull; members are soft-archived in-app so the delete rarely fires).
        // No navigation property — mirrors the SavingsId pattern above.
        builder.HasIndex(i => i.MemberId);
        builder.HasOne<HouseholdMember>()
            .WithMany()
            .HasForeignKey(i => i.MemberId)
            .OnDelete(DeleteBehavior.SetNull);
    }
}

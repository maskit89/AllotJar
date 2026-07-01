using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using AllotJar.Domain.Entities;

namespace AllotJar.Infrastructure.Persistence.Configurations;

public class TransactionSplitConfiguration : IEntityTypeConfiguration<TransactionSplit>
{
    public void Configure(EntityTypeBuilder<TransactionSplit> builder)
    {
        builder.ToTable("TransactionSplits");
        builder.HasKey(s => s.Id);

        builder.Property(s => s.Amount)
            .HasPrecision(18, 4);

        // Deleting the parent transaction removes its slices.
        builder.HasOne(s => s.Transaction)
            .WithMany(t => t.Splits)
            .HasForeignKey(s => s.TransactionId)
            .OnDelete(DeleteBehavior.Cascade);

        // Deleting a budget line leaves an "unassigned" slice (null), so the
        // delete is never blocked. Mirrors Transaction -> BudgetItem (SetNull).
        builder.HasOne(s => s.BudgetItem)
            .WithMany()
            .HasForeignKey(s => s.BudgetItemId)
            .OnDelete(DeleteBehavior.SetNull);

        // Per-slice member attribution (a shared purchase split across people).
        // SetNull mirrors the budget-line FK; members are soft-archived anyway.
        builder.HasOne(s => s.Member)
            .WithMany()
            .HasForeignKey(s => s.MemberId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.HasIndex(s => s.TransactionId);
        builder.HasIndex(s => s.BudgetItemId);
        builder.HasIndex(s => s.MemberId);
    }
}

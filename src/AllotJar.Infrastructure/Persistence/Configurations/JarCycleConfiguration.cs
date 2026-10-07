using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using AllotJar.Domain.Entities;

namespace AllotJar.Infrastructure.Persistence.Configurations;

public class JarCycleConfiguration : IEntityTypeConfiguration<JarCycle>
{
    public void Configure(EntityTypeBuilder<JarCycle> builder)
    {
        builder.ToTable("JarCycles");
        builder.HasKey(c => c.Id);

        builder.Property(c => c.OwnerId).IsRequired().HasMaxLength(450);
        builder.Property(c => c.Outcome).HasConversion<int>();

        // Financial precision: decimal(18,4) for all currency fields.
        builder.Property(c => c.TargetAmount).HasPrecision(18, 4);
        builder.Property(c => c.BalanceAtDeadline).HasPrecision(18, 4);
        builder.Property(c => c.PaidAmount).HasPrecision(18, 4);
        builder.Property(c => c.MonthOnly).HasDefaultValue(false);

        // A jar's closed cycles are its own history and go with it (W04's delete is only for a
        // jar that never held money, rule 84).
        builder.HasOne(c => c.Jar)
            .WithMany()
            .HasForeignKey(c => c.JarId)
            .OnDelete(DeleteBehavior.Cascade);

        // The chosen payment may later be deleted like any transaction; the cycle keeps its
        // outcome and the payment's date and amount (PaidOn/PaidAmount) and loses only the link.
        builder.HasOne(c => c.PaymentTransaction)
            .WithMany()
            .HasForeignKey(c => c.PaymentTransactionId)
            .OnDelete(DeleteBehavior.SetNull);

        // One row per cycle: a deadline closes once.
        builder.HasIndex(c => new { c.JarId, c.Deadline }).IsUnique();
        // A payment fulfils at most one cycle (rule 83 never reuses one across cycles).
        builder.HasIndex(c => c.PaymentTransactionId)
            .IsUnique()
            .HasFilter("[PaymentTransactionId] IS NOT NULL");
        builder.HasIndex(c => c.OwnerId);
    }
}

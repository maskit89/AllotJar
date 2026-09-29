using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using AllotJar.Domain.Entities;

namespace AllotJar.Infrastructure.Persistence.Configurations;

public class JarAllocationConfiguration : IEntityTypeConfiguration<JarAllocation>
{
    public void Configure(EntityTypeBuilder<JarAllocation> builder)
    {
        builder.ToTable("JarAllocations");
        builder.HasKey(a => a.Id);

        builder.Property(a => a.OwnerId).IsRequired().HasMaxLength(450);
        builder.Property(a => a.Kind).HasConversion<int>();
        builder.Property(a => a.Note).HasMaxLength(280);

        // The account's ledger owns its operations: an account cannot be deleted while any exist
        // (DeleteAccount refuses first; the database backs that up).
        builder.HasOne(a => a.Account)
            .WithMany()
            .HasForeignKey(a => a.AccountId)
            .OnDelete(DeleteBehavior.Restrict);

        // DeleteTransaction clears each leg's split first (JarMovements.ClearAsync), so a share
        // of a jar that has since left the account is settled on its departure; the cascade is
        // the backstop that removes the attribution with its leg.
        builder.HasOne(a => a.Transaction)
            .WithMany(t => t.JarAllocations)
            .HasForeignKey(a => a.TransactionId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasMany(a => a.Postings)
            .WithOne(p => p.JarAllocation)
            .HasForeignKey(p => p.JarAllocationId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasIndex(a => new { a.OwnerId, a.AccountId, a.Date });
        // One account leg is attributed once (the ledger refuses a second, rule 8/51).
        builder.HasIndex(a => new { a.TransactionId, a.AccountId })
            .IsUnique()
            .HasFilter("[TransactionId] IS NOT NULL");
    }
}

public class JarAllocationPostingConfiguration : IEntityTypeConfiguration<JarAllocationPosting>
{
    public void Configure(EntityTypeBuilder<JarAllocationPosting> builder)
    {
        builder.ToTable("JarAllocationPostings");
        builder.HasKey(p => p.Id);
        // A departure's postings are adjusted in place when a kept leg is corrected
        // (JarDepartures.Shift), by writers that may hold another account's ledger lock: the
        // amount read is the concurrency token, so a second writer that read the same departure
        // fails instead of overwriting the first one's shift (P3-9).
        builder.Property(p => p.Amount).HasPrecision(18, 4).IsConcurrencyToken();

        // A jar with postings is history; it can be archived, never deleted (rule 25).
        builder.HasOne(p => p.Jar)
            .WithMany()
            .HasForeignKey(p => p.JarId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(p => p.JarId);
    }
}

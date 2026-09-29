using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using AllotJar.Domain.Entities;

namespace AllotJar.Infrastructure.Persistence.Configurations;

public class AccountHolderConfiguration : IEntityTypeConfiguration<AccountHolder>
{
    public void Configure(EntityTypeBuilder<AccountHolder> builder)
    {
        builder.ToTable("AccountHolders");
        builder.HasKey(h => new { h.AccountId, h.MemberId });

        builder.HasOne(h => h.Account)
            .WithMany(a => a.Holders)
            .HasForeignKey(h => h.AccountId)
            .OnDelete(DeleteBehavior.Cascade);

        // Removing a person removes them as a holder; the account and its history stay.
        builder.HasOne(h => h.Member)
            .WithMany()
            .HasForeignKey(h => h.MemberId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasIndex(h => h.MemberId);
    }
}

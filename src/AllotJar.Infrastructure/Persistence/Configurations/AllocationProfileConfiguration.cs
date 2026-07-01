using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using AllotJar.Domain.Entities;

namespace AllotJar.Infrastructure.Persistence.Configurations;

public class AllocationProfileConfiguration : IEntityTypeConfiguration<AllocationProfile>
{
    public void Configure(EntityTypeBuilder<AllocationProfile> builder)
    {
        builder.ToTable("AllocationProfiles");
        builder.HasKey(p => p.Id);

        builder.Property(p => p.OwnerId)
            .IsRequired()
            .HasMaxLength(450);

        builder.Property(p => p.Name)
            .IsRequired()
            .HasMaxLength(120);

        // Gentle lean by default for existing profiles.
        builder.Property(p => p.BalanceLeanPercent)
            .HasDefaultValue(25);

        builder.HasIndex(p => p.OwnerId);

        builder.HasMany(p => p.Rules)
            .WithOne(r => r.AllocationProfile)
            .HasForeignKey(r => r.AllocationProfileId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}

public class AllocationRuleConfiguration : IEntityTypeConfiguration<AllocationRule>
{
    public void Configure(EntityTypeBuilder<AllocationRule> builder)
    {
        builder.ToTable("AllocationRules");
        builder.HasKey(r => r.Id);

        builder.Property(r => r.Type).HasConversion<int>();
        builder.Property(r => r.Split).HasConversion<int>();

        builder.Property(r => r.FixedAmountPerMember).HasPrecision(18, 4);
    }
}

using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using AllotJar.Domain.Entities;

namespace AllotJar.Infrastructure.Persistence.Configurations;

public class HouseholdMemberConfiguration : IEntityTypeConfiguration<HouseholdMember>
{
    public void Configure(EntityTypeBuilder<HouseholdMember> builder)
    {
        builder.ToTable("HouseholdMembers");
        builder.HasKey(m => m.Id);

        builder.Property(m => m.OwnerId)
            .IsRequired()
            .HasMaxLength(450);

        builder.Property(m => m.Name)
            .IsRequired()
            .HasMaxLength(120);

        builder.Property(m => m.NetMonthlyIncome)
            .HasPrecision(18, 4);

        builder.HasIndex(m => m.OwnerId);
    }
}

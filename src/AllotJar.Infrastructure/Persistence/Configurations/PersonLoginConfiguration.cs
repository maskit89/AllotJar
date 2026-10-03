using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using AllotJar.Domain.Entities;

namespace AllotJar.Infrastructure.Persistence.Configurations;

public class PersonLoginConfiguration : IEntityTypeConfiguration<PersonLogin>
{
    public void Configure(EntityTypeBuilder<PersonLogin> builder)
    {
        builder.ToTable("PersonLogins");
        // One row per person and login.
        builder.HasKey(p => new { p.HouseholdMemberId, p.UserId });

        builder.Property(p => p.UserId)
            .IsRequired()
            .HasMaxLength(450);

        builder.HasOne<HouseholdMember>()
            .WithMany()
            .HasForeignKey(p => p.HouseholdMemberId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}

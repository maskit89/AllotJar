using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using AllotJar.Domain.Entities;

namespace AllotJar.Infrastructure.Persistence.Configurations;

public class AccountPrivacyConfiguration : IEntityTypeConfiguration<AccountPrivacy>
{
    public void Configure(EntityTypeBuilder<AccountPrivacy> builder)
    {
        builder.ToTable("AccountPrivacy");
        builder.HasKey(p => p.AccountId);

        builder.Property(p => p.UserId)
            .IsRequired()
            .HasMaxLength(450);

        builder.HasOne<Account>()
            .WithOne(a => a.Privacy)
            .HasForeignKey<AccountPrivacy>(p => p.AccountId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}

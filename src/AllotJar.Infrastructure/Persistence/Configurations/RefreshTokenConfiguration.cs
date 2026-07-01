using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using AllotJar.Domain.Entities;

namespace AllotJar.Infrastructure.Persistence.Configurations;

public class RefreshTokenConfiguration : IEntityTypeConfiguration<RefreshToken>
{
    public void Configure(EntityTypeBuilder<RefreshToken> builder)
    {
        builder.ToTable("RefreshTokens");
        builder.HasKey(t => t.Id);

        builder.Property(t => t.UserId)
            .IsRequired()
            .HasMaxLength(450);

        builder.Property(t => t.TokenHash)
            .IsRequired()
            .HasMaxLength(200);

        builder.Property(t => t.ReplacedByTokenHash)
            .HasMaxLength(200);

        // Rotation and validation look the token up by its hash.
        builder.HasIndex(t => t.TokenHash).IsUnique();

        // Reuse-detection revokes every active token for a user at once.
        builder.HasIndex(t => t.UserId);
    }
}

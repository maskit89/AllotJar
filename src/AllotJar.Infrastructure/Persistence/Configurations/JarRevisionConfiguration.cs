using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using AllotJar.Domain.Entities;

namespace AllotJar.Infrastructure.Persistence.Configurations;

public class JarRevisionConfiguration : IEntityTypeConfiguration<JarRevision>
{
    public void Configure(EntityTypeBuilder<JarRevision> builder)
    {
        builder.ToTable("JarRevisions");
        builder.HasKey(r => r.Id);

        builder.Property(r => r.Kind).HasConversion<int>();
        builder.Property(r => r.Accrual).HasConversion<int>();

        // Financial precision: decimal(18,4) for all currency fields.
        builder.Property(r => r.TargetAmount).HasPrecision(18, 4);
        builder.Property(r => r.MonthlyContribution).HasPrecision(18, 4);

        // A jar's definition history goes with it (W04's delete is only for a jar that never held money, rule 84).
        builder.HasOne(r => r.Jar)
            .WithMany()
            .HasForeignKey(r => r.JarId)
            .OnDelete(DeleteBehavior.Cascade);

        // One definition per jar per day: a second edit the same day overwrites the first.
        builder.HasIndex(r => new { r.JarId, r.EffectiveFrom }).IsUnique();
    }
}

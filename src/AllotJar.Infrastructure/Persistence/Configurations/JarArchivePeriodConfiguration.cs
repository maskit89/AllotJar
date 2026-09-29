using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using AllotJar.Domain.Entities;

namespace AllotJar.Infrastructure.Persistence.Configurations;

public class JarArchivePeriodConfiguration : IEntityTypeConfiguration<JarArchivePeriod>
{
    public void Configure(EntityTypeBuilder<JarArchivePeriod> builder)
    {
        builder.ToTable("JarArchivePeriods");
        builder.HasKey(p => p.Id);

        // A jar's archive history goes with it (W04's delete is only for a jar that never held money, rule 84).
        builder.HasOne(p => p.Jar)
            .WithMany()
            .HasForeignKey(p => p.JarId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasIndex(p => new { p.JarId, p.ArchivedOn });
    }
}

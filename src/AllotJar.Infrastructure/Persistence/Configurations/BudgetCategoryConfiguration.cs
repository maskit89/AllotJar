using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using AllotJar.Domain.Entities;

namespace AllotJar.Infrastructure.Persistence.Configurations;

public class BudgetCategoryConfiguration : IEntityTypeConfiguration<BudgetCategory>
{
    public void Configure(EntityTypeBuilder<BudgetCategory> builder)
    {
        builder.ToTable("BudgetCategories");
        builder.HasKey(c => c.Id);

        builder.Property(c => c.Name)
            .IsRequired()
            .HasMaxLength(120);

        // Stored as the enum's int value; defaults to Expense (0) for existing rows.
        builder.Property(c => c.Kind)
            .HasConversion<int>()
            .HasDefaultValue(Domain.Enums.CategoryKind.Expense);

        // Existing categories are real obligations; only the allocation-output ones opt out.
        builder.Property(c => c.ExcludeFromAllocation)
            .HasDefaultValue(false);

        builder.Ignore(c => c.TotalPlanned);
        builder.Ignore(c => c.TotalActual);

        builder.HasMany(c => c.Items)
            .WithOne(i => i.BudgetCategory)
            .HasForeignKey(i => i.BudgetCategoryId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}

using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using AllotJar.Domain.Entities;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence.Converters;

namespace AllotJar.Infrastructure.Persistence.Configurations;

public class BudgetMonthConfiguration : IEntityTypeConfiguration<BudgetMonth>
{
    public void Configure(EntityTypeBuilder<BudgetMonth> builder)
    {
        builder.ToTable("BudgetMonths");
        builder.HasKey(m => m.Id);

        builder.Property(m => m.OwnerId)
            .IsRequired()
            .HasMaxLength(450); // matches AspNetUsers.Id length

        // Home currency, stored as its ISO 4217 string with an EUR default for
        // existing rows.
        builder.Property(m => m.BaseCurrency)
            .HasConversion(new CurrencyCodeConverter())
            .HasMaxLength(3)
            .IsRequired()
            .HasDefaultValue(CurrencyCode.Eur);

        // The computed Key / TotalIncome / TotalPlanned / RemainingToBudget
        // properties are pure C# (derived from the category tree) and must not
        // be persisted. TotalIncome is now the sum of the income-group lines.
        builder.Ignore(m => m.Key);
        builder.Ignore(m => m.TotalIncome);
        builder.Ignore(m => m.TotalPlanned);
        builder.Ignore(m => m.RemainingToBudget);
        builder.Ignore(m => m.RemainingToBudgetMoney);
        builder.Ignore(m => m.IsBalanced);

        // A user has exactly one budget per calendar month.
        builder.HasIndex(m => new { m.OwnerId, m.Year, m.Month }).IsUnique();

        builder.HasMany(m => m.Categories)
            .WithOne(c => c.BudgetMonth)
            .HasForeignKey(c => c.BudgetMonthId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}

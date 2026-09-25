using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using AllotJar.Domain.Entities;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence.Converters;

namespace AllotJar.Infrastructure.Persistence.Configurations;

public class AccountConfiguration : IEntityTypeConfiguration<Account>
{
    public void Configure(EntityTypeBuilder<Account> builder)
    {
        builder.ToTable("Accounts");
        builder.HasKey(a => a.Id);

        builder.Property(a => a.OwnerId)
            .IsRequired()
            .HasMaxLength(450);

        builder.Property(a => a.Name)
            .IsRequired()
            .HasMaxLength(120);

        builder.Property(a => a.Type)
            .HasConversion<int>();

        builder.Property(a => a.Currency)
            .HasConversion(new CurrencyCodeConverter())
            .HasMaxLength(3)
            .IsRequired()
            .HasDefaultValue(CurrencyCode.Eur);

        builder.Property(a => a.OpeningBalance)
            .HasPrecision(18, 4);

        // Nullable in the schema only for rows that predate the column: the API requires it and
        // the ledger reads a missing date as "balance unavailable", never as an inferred date.
        builder.Property(a => a.OpeningDate);

        builder.HasIndex(a => a.OwnerId);

        // Deleting an account leaves its transactions in place but unlinked (the
        // register survives); mirrors Transaction -> BudgetItem (SetNull).
        builder.HasMany(a => a.Transactions)
            .WithOne(t => t.Account)
            .HasForeignKey(t => t.AccountId)
            .OnDelete(DeleteBehavior.SetNull);
    }
}

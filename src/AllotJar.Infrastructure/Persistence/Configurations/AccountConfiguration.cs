using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using AllotJar.Domain.Entities;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence.Converters;
using AllotJar.Infrastructure.Persistence.Encryption;

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

        // Optional bank identifiers (rule 76), format-checked by the validators and encrypted at rest
        // (compliance fix 10, BankDetailsCipher). The column holds the encrypted text, so it is wider
        // than the identifier itself: a 34-character IBAN is stored as about 100 characters.
        builder.Property(a => a.Iban).HasMaxLength(EncryptedLength).HasConversion(Encrypted("Accounts.Iban"));
        builder.Property(a => a.Bic).HasMaxLength(EncryptedLength).HasConversion(Encrypted("Accounts.Bic"));
        builder.Property(a => a.SortCode).HasMaxLength(EncryptedLength).HasConversion(Encrypted("Accounts.SortCode"));
        builder.Property(a => a.AccountNumber).HasMaxLength(EncryptedLength).HasConversion(Encrypted("Accounts.AccountNumber"));

        builder.HasIndex(a => a.OwnerId);

        // Deleting an account leaves its transactions in place but unlinked (the
        // register survives); mirrors Transaction -> BudgetItem (SetNull).
        builder.HasMany(a => a.Transactions)
            .WithOne(t => t.Account)
            .HasForeignKey(t => t.AccountId)
            .OnDelete(DeleteBehavior.SetNull);
    }

    /// <summary>Room for the longest identifier (34 characters) once encrypted, with margin.</summary>
    public const int EncryptedLength = 256;

    private static ValueConverter<string?, string?> Encrypted(string column) => new(
        plain => plain == null ? null : BankDetailsCipher.Protect(plain, column),
        stored => stored == null ? null : BankDetailsCipher.Unprotect(stored, column));
}

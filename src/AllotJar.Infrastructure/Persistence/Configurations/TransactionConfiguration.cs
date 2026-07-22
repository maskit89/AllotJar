using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using AllotJar.Domain.Entities;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence.Converters;

namespace AllotJar.Infrastructure.Persistence.Configurations;

public class TransactionConfiguration : IEntityTypeConfiguration<Transaction>
{
    public void Configure(EntityTypeBuilder<Transaction> builder)
    {
        builder.ToTable("Transactions");
        builder.HasKey(t => t.Id);

        builder.Property(t => t.OwnerId)
            .IsRequired()
            .HasMaxLength(450);

        builder.Property(t => t.Amount)
            .HasPrecision(18, 4);

        // The transaction's own currency (may differ from the budget's base).
        builder.Property(t => t.Currency)
            .HasConversion(new CurrencyCodeConverter())
            .HasMaxLength(3)
            .IsRequired()
            .HasDefaultValue(CurrencyCode.Eur);

        // FX rate into the budget base currency; 6 dp is standard for rates.
        builder.Property(t => t.ExchangeRate)
            .HasPrecision(18, 6)
            .HasDefaultValue(1m);

        // BaseAmount is computed (Amount × ExchangeRate) and not persisted.
        builder.Ignore(t => t.BaseAmount);

        builder.Property(t => t.Payee)
            .HasMaxLength(200);

        builder.Property(t => t.Notes)
            .HasMaxLength(1000);

        builder.Property(t => t.BankReference)
            .HasMaxLength(140);

        builder.Property(t => t.Type)
            .HasConversion<int>();

        // A Transfer's destination account. Restrict (not SetNull) so this second
        // reference to Accounts doesn't create a second cascade path (AccountId already
        // uses SetNull); DeleteAccountCommandHandler clears these refs before removing.
        builder.HasOne(t => t.TransferAccount)
            .WithMany()
            .HasForeignKey(t => t.TransferAccountId)
            .OnDelete(DeleteBehavior.Restrict);

        // Whole-transaction member attribution. SetNull so removing a member never
        // blocks (members are soft-archived, not deleted, so this rarely fires).
        builder.HasOne(t => t.Member)
            .WithMany()
            .HasForeignKey(t => t.MemberId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.HasIndex(t => t.OwnerId);
        builder.HasIndex(t => t.MemberId);

        // Every import runs the FxPending reconcile query; almost all rows have the flag off,
        // so a filtered index makes the common "nothing pending" case a near-free seek instead
        // of an owner-wide scan that grows with account age.
        builder.HasIndex(t => new { t.OwnerId, t.FxPending })
            .HasFilter("[FxPending] = 1");

        // The dedup BACKSTOP, not just a lookup accelerator: the import handlers skip references
        // they've already seen, but that check is per-request memory — two overlapping commits
        // (double-click, two devices, two household logins) would each pass it and double-insert.
        // Unique-filtered, the database refuses the second insert and the commit handler recovers
        // by skipping the collided rows. Manual transactions (no reference) are exempt.
        //
        // Scoped by ACCOUNT, not just owner: banks legitimately reuse a reference across accounts
        // (a standing order's EndToEndId, a pooled AcctSvcrRef) and CSV imports synthesise a
        // content hash, so two DIFFERENT accounts can carry the same reference for genuinely
        // distinct transactions. An owner-wide unique key silently dropped the second one.
        builder.HasIndex(t => new { t.OwnerId, t.AccountId, t.BankReference })
            .IsUnique()
            .HasFilter("[BankReference] IS NOT NULL");
    }
}

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
        // A transfer must carry at least one confirmed bank leg: a departure, a receipt, or both.
        // Neither date is ever inferred from Date, so the database refuses a transfer with none.
        builder.ToTable("Transactions", t => t.HasCheckConstraint(
            "CK_Transactions_TransferLegs",
            "[Type] <> 2 OR [DepartedOn] IS NOT NULL OR [ReceivedOn] IS NOT NULL"));
        builder.HasKey(t => t.Id);

        builder.Property(t => t.OwnerId)
            .IsRequired()
            .HasMaxLength(450);

        builder.Property(t => t.Amount)
            .HasPrecision(18, 4);

        // The budget currency for every row that counts; another currency only while a row waits
        // for its budget-currency amount (FxPending).
        builder.Property(t => t.Currency)
            .HasConversion(new CurrencyCodeConverter())
            .HasMaxLength(3)
            .IsRequired()
            .HasDefaultValue(CurrencyCode.Eur);

        // What was paid in another currency, for reference only; never counted.
        builder.Property(t => t.OriginalAmount)
            .HasPrecision(18, 4);
        builder.Property(t => t.BudgetAmount)
            .HasPrecision(18, 4);
        builder.Property(t => t.OriginalCurrency)
            .HasConversion(new CurrencyCodeConverter())
            .HasMaxLength(3);

        builder.Property(t => t.Payee)
            .HasMaxLength(200);

        builder.Property(t => t.Notes)
            .HasMaxLength(1000);

        builder.Property(t => t.BankReference)
            .HasMaxLength(140);

        builder.Property(t => t.ReceiptBankReference)
            .HasMaxLength(140);

        // Derived from the two bank legs; never stored.
        builder.Ignore(t => t.TransferStatus);

        // Derived from the refund link; never stored.
        builder.Ignore(t => t.IsRefund);

        // A refund points at the expense it comes back from (rule 38). Restrict, not SetNull: an
        // unlinked refund would silently turn into income, so the original cannot be deleted while
        // refunds hang off it — DeleteTransactionCommandHandler refuses first with a readable message.
        builder.HasOne(t => t.RefundOf)
            .WithMany(t => t.Refunds)
            .HasForeignKey(t => t.RefundOfTransactionId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasIndex(t => t.RefundOfTransactionId);

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

        // Every budget, report and People read counts the rows still waiting for an amount; almost
        // all rows have the flag off, so a filtered index makes the common "nothing waiting" case a
        // near-free seek instead of an owner-wide scan that grows with account age.
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

        // The destination statement's reference for a transfer's credit leg is deduplicated on
        // the DESTINATION account, mirroring the source-leg index above: re-importing the
        // receiving statement must confirm the existing movement, never insert another.
        builder.HasIndex(t => new { t.OwnerId, t.TransferAccountId, t.ReceiptBankReference })
            .IsUnique()
            .HasFilter("[ReceiptBankReference] IS NOT NULL");
    }
}

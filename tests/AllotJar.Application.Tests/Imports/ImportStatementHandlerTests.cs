using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.ImportStatement;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Imports;

public class ImportStatementHandlerTests
{
    private sealed class CurrentUserStub : ICurrentUser
    {
        public CurrentUserStub(string? userId) => UserId = userId;
        public string? UserId { get; }
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-import-{Guid.NewGuid()}")
            .Options);

    private static ImportStatementCommandHandler NewHandler(ApplicationDbContext db, string userId) =>
        new(db, new CurrentUserStub(userId),
            new IStatementParser[] { new Camt053StatementParser(), new HsbcCsvStatementParser() });

    [Fact]
    public async Task Handle_ImportsAllEntries_WithCorrectSummary()
    {
        await using var db = NewContext();
        var handler = NewHandler(db, "user-1");

        var result = await handler.Handle(
            new ImportStatementCommand(Camt053Samples.ThreeEntries), CancellationToken.None);

        Assert.Equal(3, result.TotalEntries);
        Assert.Equal(3, result.Imported);
        Assert.Equal(0, result.SkippedDuplicates);
        Assert.Equal(1, result.Credits);
        Assert.Equal(2, result.Debits);
        Assert.Equal("DE89370400440532013000", result.Iban);
        Assert.Equal(3, await db.Transactions.CountAsync());
    }

    [Fact]
    public async Task Handle_PersistsCurrencyAndDirection()
    {
        await using var db = NewContext();
        await NewHandler(db, "user-1").Handle(
            new ImportStatementCommand(Camt053Samples.ThreeEntries), CancellationToken.None);

        var taxi = await db.Transactions.FirstAsync(t => t.BankReference == "E2E-TAXI-9");
        Assert.Equal("GBP", taxi.Currency.Value);
        Assert.Equal(TransactionType.Expense, taxi.Type);

        var salary = await db.Transactions.FirstAsync(t => t.BankReference == "REF-SALARY-001");
        Assert.Equal(TransactionType.Income, salary.Type);
        Assert.Equal("user-1", salary.OwnerId);
    }

    [Fact]
    public async Task Handle_ReImportingSameStatement_IsIdempotent()
    {
        await using var db = NewContext();
        var handler = NewHandler(db, "user-1");
        var cmd = new ImportStatementCommand(Camt053Samples.ThreeEntries);

        await handler.Handle(cmd, CancellationToken.None);
        var second = await handler.Handle(cmd, CancellationToken.None);

        Assert.Equal(0, second.Imported);
        Assert.Equal(3, second.SkippedDuplicates);
        Assert.Equal(3, await db.Transactions.CountAsync()); // still only 3 — no duplicates
    }

    private static Account SeedAccount(ApplicationDbContext db, string ownerId)
    {
        var account = new Account
        {
            OwnerId = ownerId,
            Name = "Everyday",
            Type = AccountType.Current,
            Currency = CurrencyCode.Eur,
        };
        db.Accounts.Add(account);
        db.SaveChanges();
        return account;
    }

    [Fact]
    public async Task Handle_StampsImportedTransactions_WithTheChosenAccount()
    {
        await using var db = NewContext();
        var account = SeedAccount(db, "user-1"); // EUR, matching the EUR-only statement

        await NewHandler(db, "user-1").Handle(
            new ImportStatementCommand(Camt053Samples.TwoEurEntries, account.Id), CancellationToken.None);

        Assert.Equal(2, await db.Transactions.CountAsync(t => t.AccountId == account.Id));
    }

    [Fact]
    public async Task Handle_RejectsAForeignCurrencyEntry_OnAnAccountImport_AtomicallyImportingNothing()
    {
        // The statement mixes EUR and GBP rows; pinned to an EUR account, the GBP row violates
        // the account-currency invariant — and the WHOLE import must fail (validated before
        // anything is persisted), not leave a partial statement behind.
        await using var db = NewContext();
        var account = SeedAccount(db, "user-1"); // EUR

        await Assert.ThrowsAsync<ValidationException>(() =>
            NewHandler(db, "user-1").Handle(
                new ImportStatementCommand(Camt053Samples.ThreeEntries, account.Id), CancellationToken.None));

        Assert.Equal(0, await db.Transactions.CountAsync());
    }

    [Fact]
    public async Task Handle_RejectsAnAccountOwnedByAnotherUser()
    {
        await using var db = NewContext();
        var foreign = SeedAccount(db, "user-2");

        await Assert.ThrowsAsync<ForbiddenAccessException>(() =>
            NewHandler(db, "user-1").Handle(
                new ImportStatementCommand(Camt053Samples.ThreeEntries, foreign.Id), CancellationToken.None));

        Assert.Equal(0, await db.Transactions.CountAsync()); // nothing imported
    }

    // --- HSBC CSV format (no native bank reference; dedup relies on a synthesized one) ------

    private static ImportStatementCommand HsbcCommand(string content) =>
        new(content, AccountId: null, StatementFormat.HsbcCsv);

    [Fact]
    public async Task Handle_HsbcCsv_ImportsAllRows_AndSplitsCreditsFromDebits()
    {
        await using var db = NewContext();

        var result = await NewHandler(db, "user-1").Handle(
            HsbcCommand(HsbcCsvSamples.Mixed), CancellationToken.None);

        Assert.Equal(6, result.Imported);
        Assert.Equal(1, result.Credits); // the lone E-BANKING PAYMENT
        Assert.Equal(5, result.Debits);
        Assert.Equal(6, await db.Transactions.CountAsync());
    }

    [Fact]
    public async Task Handle_HsbcCsv_ReImportingSameFile_IsIdempotent()
    {
        await using var db = NewContext();
        var handler = NewHandler(db, "user-1");

        await handler.Handle(HsbcCommand(HsbcCsvSamples.Mixed), CancellationToken.None);
        var second = await handler.Handle(HsbcCommand(HsbcCsvSamples.Mixed), CancellationToken.None);

        Assert.Equal(0, second.Imported);
        Assert.Equal(6, second.SkippedDuplicates);
        Assert.Equal(6, await db.Transactions.CountAsync()); // still only 6 — no duplicates
    }

    [Fact]
    public async Task Handle_HsbcCsv_KeepsGenuinelyRepeatedIdenticalCharges()
    {
        await using var db = NewContext();
        var handler = NewHandler(db, "user-1");

        // Four identical same-day charges must all import...
        var first = await handler.Handle(
            HsbcCommand(HsbcCsvSamples.FourIdenticalCharges), CancellationToken.None);
        Assert.Equal(4, first.Imported);
        Assert.Equal(4, await db.Transactions.CountAsync());

        // ...but re-importing the very same four is still a no-op.
        var second = await handler.Handle(
            HsbcCommand(HsbcCsvSamples.FourIdenticalCharges), CancellationToken.None);
        Assert.Equal(0, second.Imported);
        Assert.Equal(4, second.SkippedDuplicates);
        Assert.Equal(4, await db.Transactions.CountAsync());
    }

    [Fact]
    public async Task Handle_ScopesImportToTheCurrentUser()
    {
        await using var db = NewContext();
        await NewHandler(db, "user-1").Handle(
            new ImportStatementCommand(Camt053Samples.ThreeEntries), CancellationToken.None);

        // A different user importing the same statement gets their own copies
        // (dedup is per-user) and never sees user-1's rows.
        var other = await NewHandler(db, "user-2").Handle(
            new ImportStatementCommand(Camt053Samples.ThreeEntries), CancellationToken.None);

        Assert.Equal(3, other.Imported);
        Assert.Equal(3, await db.Transactions.CountAsync(t => t.OwnerId == "user-1"));
        Assert.Equal(3, await db.Transactions.CountAsync(t => t.OwnerId == "user-2"));
    }
}

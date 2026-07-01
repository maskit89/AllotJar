using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using NSubstitute;
using Xunit;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.ImportStatement;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Imports;

/// <summary>
/// Demonstrates the QA toolchain: NSubstitute isolates the handler from the real
/// CAMT.053 parser (so we test mapping/persistence logic alone), and the
/// assertions use FluentAssertions.
/// </summary>
public class ImportStatementHandlerIsolationTests
{
    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-iso-{Guid.NewGuid()}")
            .Options);

    private static ParsedStatement TwoEntries() => new(
        Iban: "NL91ABNA0417164300",
        Entries: new List<ParsedStatementEntry>
        {
            new(100m, "EUR", IsCredit: false, new DateOnly(2026, 6, 1), "Bakery", "REF-1"),
            new(2500m, "EUR", IsCredit: true, new DateOnly(2026, 6, 2), "Employer", "REF-2"),
        });

    [Fact]
    public async Task Handle_MapsParsedEntries_ToTransactions()
    {
        await using var db = NewContext();

        var currentUser = Substitute.For<ICurrentUser>();
        currentUser.UserId.Returns("user-1");
        currentUser.OwnerId.Returns("user-1");

        var parser = Substitute.For<IStatementParser>();
        parser.Parse(Arg.Any<string>()).Returns(TwoEntries());

        var handler = new ImportStatementCommandHandler(db, currentUser, new[] { parser }, new FakeExchangeRateProvider());

        var result = await handler.Handle(new ImportStatementCommand("<xml/>"), CancellationToken.None);

        result.Imported.Should().Be(2);
        result.Credits.Should().Be(1);
        result.Debits.Should().Be(1);
        result.Iban.Should().Be("NL91ABNA0417164300");

        parser.Received(1).Parse("<xml/>");

        var transactions = await db.Transactions.ToListAsync();
        transactions.Should().HaveCount(2);
        transactions.Should().ContainSingle(t => t.Type == TransactionType.Income && t.Payee == "Employer");
        transactions.Should().OnlyContain(t => t.OwnerId == "user-1");
    }

    [Fact]
    public async Task Handle_WithoutAuthenticatedUser_Throws_AndNeverParses()
    {
        await using var db = NewContext();

        var currentUser = Substitute.For<ICurrentUser>();
        currentUser.UserId.Returns((string?)null);
        currentUser.OwnerId.Returns((string?)null);

        var parser = Substitute.For<IStatementParser>();

        var handler = new ImportStatementCommandHandler(db, currentUser, new[] { parser }, new FakeExchangeRateProvider());

        var act = () => handler.Handle(new ImportStatementCommand("<xml/>"), CancellationToken.None);

        await act.Should().ThrowAsync<ForbiddenAccessException>();
        parser.DidNotReceive().Parse(Arg.Any<string>());
    }
}

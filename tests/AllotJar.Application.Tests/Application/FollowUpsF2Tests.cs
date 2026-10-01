using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Jars.Queries.GetJarSchedule;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Reports.Queries.GetMonthReport;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Follow-ups F2 (1 October 2026): the end-to-end check's server P3s built from the open list.
/// Each test fails on main before its fix.
/// </summary>
public class FollowUpsF2Tests
{
    private const string Owner = "user-1";
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static CurrentUserStub User => new(Owner);

    // SC-P3-1 (rule 58): the jar card and the edit preview read the same jar on the same day, but the
    // card left out money that arrived this month, so it said "about 6 more months" where the
    // preview said 4.
    [Fact]
    public async Task The_card_estimates_like_the_preview_when_money_arrived_this_month()
    {
        await using var db = TestDb.NewContext();
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var monthStart = new DateOnly(today.Year, today.Month, 1);
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 5000m);
        var jar = new Jar
        {
            OwnerId = Owner, Name = "Bike", Kind = JarKind.Goal, TargetAmount = 1000m, Accrual = AccrualMethod.FixedMonthly,
            MonthlyContribution = 100m, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        await db.SaveChangesAsync();
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 400m, monthStart.AddDays(-10));
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 300m, today, JarAllocationKind.Reallocation);

        var card = (await new GetJarsQueryHandler(db, User).Handle(new GetJarsQuery(), Ct)).Single();
        var preview = await new GetJarScheduleQueryHandler(db, User).Handle(
            new GetJarScheduleQuery(jar.Id, JarKind.Goal, 1000m, null, AccrualMethod.FixedMonthly, MonthlyContribution: 100m), Ct);

        card.EstimatedMonthsToTarget.Should().Be(preview.EstimatedMonths);
    }

    // RP-P3-1 (rule 37): a split with a slice on no line adds that slice to Uncategorised, and the
    // row's "Review N transactions" now counts the split too.
    [Fact]
    public async Task Uncategorised_counts_a_split_whose_slice_is_on_no_line()
    {
        await using var db = TestDb.NewContext();
        var clothes = new BudgetItem { Name = "Clothes", PlannedAmount = 100m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = 2026, Month = 9, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, Items = new List<BudgetItem> { new() { Name = "Salary", PlannedAmount = 3000m } } },
                new() { Name = "Household", Kind = CategoryKind.Expense, DisplayOrder = 1, Items = new List<BudgetItem> { clothes } },
            },
        });
        var account = LedgerFixtures.SeedAccount(db, Owner, "Joint", 10_000m, new DateOnly(2020, 1, 1), AccountType.Current);
        db.Transactions.Add(new Transaction
        {
            OwnerId = Owner, Date = new DateOnly(2026, 9, 6), Payee = "Unknown shop", Amount = 100m,
            Type = TransactionType.Expense, AccountId = account.Id, Currency = CurrencyCode.Eur,
        });
        var split = new Transaction
        {
            OwnerId = Owner, Date = new DateOnly(2026, 9, 7), Payee = "Split shop", Amount = 100m,
            Type = TransactionType.Expense, AccountId = account.Id, Currency = CurrencyCode.Eur,
        };
        db.Transactions.Add(split);
        db.SaveChanges();
        db.TransactionSplits.Add(new TransactionSplit { TransactionId = split.Id, Amount = 60m, BudgetItemId = clothes.Id });
        db.TransactionSplits.Add(new TransactionSplit { TransactionId = split.Id, Amount = 20m, BudgetItemId = null });
        db.TransactionSplits.Add(new TransactionSplit { TransactionId = split.Id, Amount = 20m, BudgetItemId = null });
        db.SaveChanges();

        var report = await new GetMonthReportQueryHandler(db, User).Handle(new GetMonthReportQuery(2026, 9), Ct);

        var uncategorised = report.Categories.Single(c => c.IsUncategorised);
        uncategorised.Net.Should().Be(140m);
        uncategorised.Count.Should().Be(2, "the loose row and the split, counted once however many slices are loose");
        report.UncategorisedCount.Should().Be(2);
    }

    // TX-P3-2: a camt.053 statement declaring a DTD is refused rather than expanded.
    [Fact]
    public void A_camt053_statement_with_a_DTD_is_refused()
    {
        const string xml = """
            <?xml version="1.0"?>
            <!DOCTYPE Document [ <!ENTITY a "aaaaaaaaaa"> <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"> ]>
            <Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Acct><Id><IBAN>&b;</IBAN></Id></Acct></Stmt></BkToCstmrStmt></Document>
            """;

        var parse = () => new Camt053StatementParser().Parse(xml);

        parse.Should().Throw<StatementParseException>().WithMessage("*DTD*");
    }

    // S-P3-1: refresh tokens past their expiry are deleted when the login is issued or rotates one;
    // a rotated token that has not expired stays, so a replay still meets the theft response.
    [Fact]
    public async Task Issuing_a_refresh_token_removes_the_logins_expired_ones_only()
    {
        await using var db = TestDb.NewContext();
        var past = DateTime.UtcNow.AddDays(-1);
        db.RefreshTokens.AddRange(
            new RefreshToken { UserId = Owner, TokenHash = "expired", CreatedUtc = past.AddDays(-30), ExpiresUtc = past, RevokedUtc = past.AddDays(-20) },
            new RefreshToken { UserId = Owner, TokenHash = "rotated", CreatedUtc = past, ExpiresUtc = past.AddDays(30), RevokedUtc = past, ReplacedByTokenHash = "next" },
            new RefreshToken { UserId = "user-2", TokenHash = "someone-else", CreatedUtc = past.AddDays(-30), ExpiresUtc = past });
        await db.SaveChangesAsync();

        await new RefreshTokenService(db).IssueAsync(Owner);

        var left = await db.RefreshTokens.Select(t => t.TokenHash).ToListAsync();
        left.Should().NotContain("expired");
        left.Should().Contain(new[] { "rotated", "someone-else" });
        left.Should().HaveCount(3);
    }
}

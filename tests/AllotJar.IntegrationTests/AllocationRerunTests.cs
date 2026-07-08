using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Allocation.Commands.AllocateIncome;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// AllocateIncome is the OTHER BankReference writer, and it is idempotent by deleting the month's
/// prior alloc transfers and recreating the SAME references in one SaveChanges. Under the new
/// unique (OwnerId, BankReference) index that relies on EF ordering the DELETEs before the
/// conflicting INSERTs in the same batch — behavior the in-memory suite cannot validate, so a
/// re-run is exercised here against real SQL Server.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class AllocationRerunTests
{
    private readonly SqlServerFixture _fixture;

    public AllocationRerunTests(SqlServerFixture fixture) => _fixture = fixture;

    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    [Fact]
    public async Task Rerunning_an_allocation_recreates_the_same_references_without_tripping_the_unique_index()
    {
        var owner = $"user-{Guid.NewGuid():N}";
        await using var db = _fixture.CreateContext();

        var source = new Account
        {
            OwnerId = owner, Name = "Joint", Currency = CurrencyCode.Eur, DisplayOrder = 0,
        };
        var savings = new Account
        {
            OwnerId = owner, Name = "Sam savings", Currency = CurrencyCode.Eur, DisplayOrder = 1,
        };
        db.Accounts.AddRange(source, savings);
        db.HouseholdMembers.Add(new HouseholdMember
        {
            OwnerId = owner,
            Name = "Sam",
            NetMonthlyIncome = 1500m,
            PersonalSavingsAccountId = savings.Id,
            DisplayOrder = 0,
        });
        db.AllocationProfiles.Add(new AllocationProfile
        {
            OwnerId = owner,
            Name = "Default",
            SourceAccountId = source.Id,
        });
        await db.SaveChangesAsync();

        var handler = new AllocateIncomeCommandHandler(db, new CurrentUserStub(owner));
        var command = new AllocateIncomeCommand(2026, 7, null);

        // First run creates the alloc transfer; the re-run deletes + recreates the SAME reference
        // in one batch — the exact write pattern the unique index must tolerate.
        await handler.Handle(command, CancellationToken.None);
        await handler.Handle(command, CancellationToken.None);

        await using var verify = _fixture.CreateContext();
        var allocRows = await verify.Transactions
            .AsNoTracking()
            .Where(t => t.OwnerId == owner && t.BankReference!.StartsWith("alloc:2026-7:"))
            .ToListAsync();
        allocRows.Should().HaveCount(1); // recreated, never duplicated
        allocRows[0].Amount.Should().Be(1500m);
    }

    [Fact]
    public async Task Commit_skips_a_member_whose_savings_account_is_gone_instead_of_crashing()
    {
        var owner = $"user-{Guid.NewGuid():N}";
        await using var db = _fixture.CreateContext();

        var source = new Account { OwnerId = owner, Name = "Joint", Currency = CurrencyCode.Eur, DisplayOrder = 0 };
        var chrisSavings = new Account { OwnerId = owner, Name = "Chris savings", Currency = CurrencyCode.Eur, DisplayOrder = 1 };
        db.Accounts.AddRange(source, chrisSavings);
        db.HouseholdMembers.AddRange(
            new HouseholdMember { OwnerId = owner, Name = "Chris", NetMonthlyIncome = 1500m, PersonalSavingsAccountId = chrisSavings.Id, DisplayOrder = 0 },
            // Liza's savings account was deleted; the soft-hint id now dangles (no Account row, no FK).
            new HouseholdMember { OwnerId = owner, Name = "Liza", NetMonthlyIncome = 1200m, PersonalSavingsAccountId = Guid.NewGuid(), DisplayOrder = 1 });
        db.AllocationProfiles.Add(new AllocationProfile { OwnerId = owner, Name = "Default", SourceAccountId = source.Id });
        await db.SaveChangesAsync();

        var handler = new AllocateIncomeCommandHandler(db, new CurrentUserStub(owner));

        // Before the planner nulled dangling savings ids, the broken TransferAccountId FK threw
        // DbUpdateException here on SQL Server and failed the ENTIRE commit.
        var act = async () => await handler.Handle(new AllocateIncomeCommand(2026, 7, null), CancellationToken.None);
        var result = (await act.Should().NotThrowAsync()).Subject;

        result.TransfersCreated.Should().Be(1); // Chris only; Liza is skipped (no valid savings account)
        await using var verify = _fixture.CreateContext();
        var transfers = await verify.Transactions.AsNoTracking()
            .Where(t => t.OwnerId == owner && t.Type == TransactionType.Transfer)
            .ToListAsync();
        transfers.Should().ContainSingle();
        transfers[0].TransferAccountId.Should().Be(chrisSavings.Id);
    }
}

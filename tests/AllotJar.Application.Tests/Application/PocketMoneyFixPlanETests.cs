using FluentAssertions;
using AllotJar.Application.Allocation.Commands.SyncPocketMoneyLines;
using AllotJar.Application.Household;
using AllotJar.Application.Household.Commands.ArchiveHouseholdMember;
using AllotJar.Application.Household.Queries.GetMemberArchivePreview;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Fix plan E of the 30 Sep end-to-end check (pocket money): cancelling a person's pocket money
/// never writes a negative plan when a refund sits on their line (RP-P2-1), and the sync finds the
/// person's line by its link wherever the group was renamed to (rule 53, RP-P2-2).
/// </summary>
public class PocketMoneyFixPlanETests
{
    private const string Owner = "user-1";
    private static readonly CurrentUserStub User = new(Owner);
    private static readonly CancellationToken Ct = CancellationToken.None;

    private static (int Year, int Month) Shift(int months)
    {
        var d = new DateTime(DateTime.UtcNow.Year, DateTime.UtcNow.Month, 1).AddMonths(months);
        return (d.Year, d.Month);
    }

    private static void AddMonth(ApplicationDbContext db, (int Year, int Month) month, string group, BudgetItem line)
    {
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = month.Year, Month = month.Month, BaseCurrency = CurrencyCode.Eur,
            Categories = { new BudgetCategory { Name = group, Kind = CategoryKind.Expense, ExcludeFromAllocation = true, Items = { line } } },
        });
        db.SaveChanges();
    }

    [Fact]
    public async Task Cancelling_with_a_refund_on_the_line_never_plans_below_zero()
    {
        await using var db = NewContext();
        var kid = new HouseholdMember { OwnerId = Owner, Name = "Kid" };
        db.HouseholdMembers.Add(kid);
        db.SaveChanges();
        var now = Shift(0);
        var last = Shift(-1);
        var pocketLast = new BudgetItem { Name = "Kid", PlannedAmount = 50m, MemberId = kid.Id };
        var pocketNow = new BudgetItem { Name = "Kid", PlannedAmount = 50m, MemberId = kid.Id };
        AddMonth(db, last, "Pocket Money", pocketLast);
        AddMonth(db, now, "Pocket Money", pocketNow);
        // 40 spent last month; 20 of it refunded this month onto this month's line (P19).
        var purchase = new Transaction
        {
            OwnerId = Owner, Date = new DateOnly(last.Year, last.Month, 10), Payee = "Toy", Amount = 40m,
            Type = TransactionType.Expense, BudgetItemId = pocketLast.Id, Currency = CurrencyCode.Eur,
        };
        db.Transactions.Add(purchase);
        db.SaveChanges();
        db.Transactions.Add(new Transaction
        {
            OwnerId = Owner, Date = new DateOnly(now.Year, now.Month, 2), Payee = "Toy refund", Amount = 20m,
            Type = TransactionType.Income, BudgetItemId = pocketNow.Id, RefundOfTransactionId = purchase.Id, Currency = CurrencyCode.Eur,
        });
        db.SaveChanges();

        var preview = await new GetMemberArchivePreviewQueryHandler(db, User).Handle(new GetMemberArchivePreviewQuery(kid.Id), Ct);
        preview.ThisMonth!.Paid.Should().Be(0m);
        preview.ThisMonth.Remaining.Should().Be(50m, "no more than was planned");

        await new ArchiveHouseholdMemberCommandHandler(db, User)
            .Handle(new ArchiveHouseholdMemberCommand(kid.Id, true, PocketMoneyDecision.Cancel), Ct);

        db.BudgetItems.AsNoTracking().Single(i => i.Id == pocketNow.Id).PlannedAmount.Should().Be(0m);
    }

    [Fact]
    public async Task The_sync_reuses_the_linked_line_after_the_group_was_renamed()
    {
        await using var db = NewContext();
        var kid = new HouseholdMember { OwnerId = Owner, Name = "Kid" };
        db.HouseholdMembers.Add(kid);
        db.AllocationProfiles.Add(new AllocationProfile
        {
            OwnerId = Owner, Name = "Household",
            Rules = { new AllocationRule { Order = 0, Type = AllocationRuleType.FixedPerMember, Split = SplitMethod.Equal, FixedAmountPerMember = 60m } },
        });
        db.SaveChanges();
        var now = Shift(0);
        var line = new BudgetItem { Name = "Kid", PlannedAmount = 50m, MemberId = kid.Id };
        AddMonth(db, now, "Allowances", line);

        await new SyncPocketMoneyLinesCommandHandler(db, User).Handle(new SyncPocketMoneyLinesCommand(now.Year, now.Month), Ct);

        var linked = db.BudgetItems.AsNoTracking().Where(i => i.MemberId == kid.Id).ToList();
        linked.Should().ContainSingle("rule 53: the person's linked line is reused wherever it is");
        linked[0].Id.Should().Be(line.Id);
        linked[0].PlannedAmount.Should().Be(60m);
        db.BudgetCategories.AsNoTracking().Count(c => c.Kind == CategoryKind.Expense).Should().Be(1, "no second pocket group");
        var preview = await new GetMemberArchivePreviewQueryHandler(db, User).Handle(new GetMemberArchivePreviewQuery(kid.Id), Ct);
        preview.ThisMonth!.Planned.Should().Be(60m);
    }
}

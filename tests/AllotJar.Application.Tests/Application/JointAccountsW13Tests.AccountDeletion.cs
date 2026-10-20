using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts;
using AllotJar.Application.Accounts.Queries.GetAccounts;
using AllotJar.Application.Reports.Queries.GetMonthReport;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Identity;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// "Delete my account" (compliance fix 5) on the W13 household: Chris owns it, Sam joined it with a
/// login. A login deleting itself takes its own household with it; in a household it joined only its
/// private accounts go, erased as P59's "Keep shared" erase does, so no one else's figure changes.
/// </summary>
public partial class JointAccountsW13Tests
{
    private AccountDeletion Deletion => new(_options);

    private void SeedLogins()
    {
        using var db = Seed();
        db.Users.AddRange(
            new ApplicationUser { Id = Household, Email = "chris@example.com", UserName = "chris@example.com" },
            new ApplicationUser { Id = SamLogin, Email = "sam@example.com", UserName = "sam@example.com" });
        db.RefreshTokens.Add(new RefreshToken { UserId = SamLogin, TokenHash = "sam-token" });
        db.SaveChanges();
    }

    /// <summary>Sam's own household, with a person and an account, beside the one Sam joined.</summary>
    private void SeedSamsOwnHousehold()
    {
        using var db = Seed();
        var sam = new HouseholdMember { OwnerId = SamLogin, Name = "Sam" };
        db.HouseholdMembers.Add(sam);
        db.HouseholdMemberships.Add(new HouseholdMembership
        {
            OwnerId = SamLogin, UserId = SamLogin, Role = HouseholdRole.Owner, MemberId = sam.Id, InvitedEmail = "sam@example.com",
        });
        db.Accounts.Add(new Account { OwnerId = SamLogin, Name = "Sam's own", Currency = CurrencyCode.Eur, OpeningBalance = 50m });
        db.SaveChanges();
    }

    private async Task<decimal> BalanceAsync(Guid accountId)
    {
        await using var db = As(Chris);
        return (await new GetAccountsQueryHandler(db, Chris).Handle(new GetAccountsQuery(June10), CancellationToken.None))
            .Single(a => a.Id == accountId).CurrentBalance ?? 0m;
    }

    [Fact]
    public async Task AMemberDeletingTheirAccount_ErasesOnlyTheirPrivateMoney_AndLeavesTheHouseholdsFiguresAsTheyWere()
    {
        SeedLogins();
        SeedSamsOwnHousehold();
        var (joint, mine, transfer) = await SeedSamsPrivateMoneyAsync();
        var before = await BalanceAsync(joint);
        await using (var read = As(Chris))
        {
            (await Deletion.PreviewAsync(SamLogin, CancellationToken.None))
                .Should().Be(new AccountDeletion.Preview(OwnsHousehold: true, OthersInHousehold: 0, PrivateAccountsElsewhere: 1));
        }
        var reportBefore = await MonthReportAsync();

        await Deletion.DeleteAsync(SamLogin, CancellationToken.None);

        using var check = Seed();
        check.Users.Should().NotContain(u => u.Id == SamLogin);
        check.RefreshTokens.Should().NotContain(t => t.UserId == SamLogin);
        check.HouseholdMemberships.Should().NotContain(m => m.UserId == SamLogin);
        check.PersonLogins.Should().NotContain(p => p.UserId == SamLogin);
        check.AccountPrivacies.Should().NotContain(p => p.UserId == SamLogin);
        // Sam's own household is gone.
        check.Accounts.Should().NotContain(a => a.OwnerId == SamLogin);
        check.HouseholdMembers.Should().NotContain(m => m.OwnerId == SamLogin);
        // In Chris's household: the private account and its off-budget entry are gone, the
        // budget-line entry stays with no account, the joint account's departure stays as an expense.
        check.Accounts.Should().NotContain(a => a.Id == mine);
        check.Transactions.Should().NotContain(t => t.Payee == "Pharmacy");
        check.Transactions.Single(t => t.Payee == "Groceries").AccountId.Should().BeNull();
        var departure = check.Transactions.Single(t => t.Id == transfer);
        departure.Type.Should().Be(TransactionType.Expense);
        departure.AccountId.Should().Be(joint);
        departure.CounterpartyErased.Should().BeTrue();
        // The person Sam stays: the household's record of who spent what.
        check.HouseholdMembers.Should().Contain(m => m.Id == _sam);
        check.Users.Should().Contain(u => u.Id == Household);
        (await BalanceAsync(joint)).Should().Be(before);
        (await MonthReportAsync()).Should().BeEquivalentTo(reportBefore);
    }

    [Fact]
    public async Task AnOwnerDeletingTheirAccount_RemovesTheWholeHousehold_AndTheOthersLandInTheirOwn()
    {
        SeedLogins();
        var line = SeedLine();
        var joint = await CreateAccountAsync(Chris, "Joint", holders: null, opening: 1000m);
        var samsPrivate = await CreateAccountAsync(Sam, "Sam's current", new[] { _sam });
        await using (var db = As(Chris))
        {
            var chris = new CreateTransactionCommandHandler(db, Chris);
            var bought = await chris.Handle(new CreateTransactionCommand(June10, "Shop", 30m, TransactionType.Expense, line, joint), CancellationToken.None);
            await chris.Handle(new CreateTransactionCommand(June10, "Shop refund", 10m, TransactionType.Income, line, joint, RefundOfTransactionId: bought.Id), CancellationToken.None);
        }
        await using (var db = As(Sam))
        {
            await new CreateTransferCommandHandler(db, Sam).Handle(
                new CreateTransferCommand(June10, 100m, joint, samsPrivate, ReceivedOn: June10), CancellationToken.None);
        }
        await using (var db = Seed())
        {
            var sam = await db.Users.SingleAsync(u => u.Id == SamLogin);
            sam.ActiveOwnerId = Household;
            await db.SaveChangesAsync();
        }
        (await Deletion.PreviewAsync(Household, CancellationToken.None))
            .Should().Be(new AccountDeletion.Preview(OwnsHousehold: true, OthersInHousehold: 1, PrivateAccountsElsewhere: 0));

        await Deletion.DeleteAsync(Household, CancellationToken.None);

        using var check = Seed();
        check.Users.Should().NotContain(u => u.Id == Household);
        check.Accounts.Should().NotContain(a => a.OwnerId == Household);
        check.AccountPrivacies.Should().BeEmpty();
        check.AccountHolders.Should().BeEmpty();
        check.Transactions.Should().NotContain(t => t.OwnerId == Household);
        check.BudgetMonths.Should().NotContain(m => m.OwnerId == Household);
        check.BudgetItems.Should().BeEmpty();
        check.HouseholdMembers.Should().NotContain(m => m.OwnerId == Household);
        check.HouseholdMemberships.Should().NotContain(m => m.OwnerId == Household);
        // Sam keeps the login, back in a household of their own.
        var samAfter = check.Users.Single(u => u.Id == SamLogin);
        samAfter.ActiveOwnerId.Should().BeNull();
        check.HouseholdMemberships.Should().ContainSingle(m => m.OwnerId == SamLogin && m.UserId == SamLogin && m.Role == HouseholdRole.Owner);
    }

    [Fact]
    public async Task APurchaseARefundElsewhereNames_StaysWithNoAccount_SoTheRefundKeepsNettingIt()
    {
        SeedLogins();
        var line = SeedLine();
        var joint = await CreateAccountAsync(Chris, "Joint", holders: null, opening: 1000m);
        var mine = await CreateAccountAsync(Sam, "Sam's current", new[] { _sam });
        Guid purchase;
        await using (var db = Seed())
        {
            // Sam's purchase off the budget in the private account, refunded onto the household's line in the joint account.
            var bought = new Transaction
            {
                OwnerId = Household, AccountId = mine, Type = TransactionType.Expense, Date = June10, Amount = 50m,
                Currency = CurrencyCode.Eur, BudgetAmount = 50m, Payee = "Shoes",
            };
            db.Transactions.Add(bought);
            db.Transactions.Add(new Transaction
            {
                OwnerId = Household, AccountId = joint, Type = TransactionType.Income, Date = June10, Amount = 20m,
                Currency = CurrencyCode.Eur, BudgetAmount = 20m, Payee = "Shoes refund", BudgetItemId = line, RefundOfTransactionId = bought.Id,
            });
            await db.SaveChangesAsync();
            purchase = bought.Id;
        }
        var before = await BalanceAsync(joint);

        await Deletion.DeleteAsync(SamLogin, CancellationToken.None);

        using var check = Seed();
        check.Accounts.Should().NotContain(a => a.Id == mine);
        var kept = check.Transactions.Single(t => t.Id == purchase);
        kept.AccountId.Should().BeNull();
        kept.CounterpartyErased.Should().BeTrue("it never counted in a total, and still doesn't");
        check.Transactions.Single(t => t.Payee == "Shoes refund").RefundOfTransactionId.Should().Be(purchase);
        (await BalanceAsync(joint)).Should().Be(before);
    }

    [Fact]
    public async Task AnAccountLeftBehindInAHouseholdTheLoginLeft_IsErasedToo()
    {
        SeedLogins();
        var (_, mine, _) = await SeedSamsPrivateMoneyAsync();
        await RemoveSamsLoginAsync();
        (await UnreachableAsync(Chris)).Should().ContainSingle(a => a.Id == mine);

        await Deletion.DeleteAsync(SamLogin, CancellationToken.None);

        using var check = Seed();
        check.Accounts.Should().NotContain(a => a.Id == mine);
        check.AccountPrivacies.Should().NotContain(p => p.UserId == SamLogin);
        (await UnreachableAsync(Chris)).Should().BeEmpty();
    }

    [Fact]
    public async Task DeletingALoginThatIsAlreadyGone_ChangesNothing()
    {
        var (_, mine, _) = await SeedSamsPrivateMoneyAsync();

        await Deletion.DeleteAsync(SamLogin, CancellationToken.None);

        using var check = Seed();
        check.Accounts.Should().Contain(a => a.Id == mine, "with no login row there is nothing to delete");
    }

    private async Task<object> MonthReportAsync()
    {
        await using var db = As(Chris);
        return await new GetMonthReportQueryHandler(db, Chris).Handle(new GetMonthReportQuery(2026, 6), CancellationToken.None);
    }
}

using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Accounts.Commands.CompleteSharingReview;
using AllotJar.Application.Accounts.Commands.CreateAccount;
using AllotJar.Application.Accounts.Commands.DeleteAccount;
using AllotJar.Application.Accounts.Commands.SetAccountSharing;
using AllotJar.Application.Accounts.Commands.UpdateAccount;
using AllotJar.Application.Accounts.Queries.GetAccounts;
using AllotJar.Application.Accounts.Queries.GetSharingReview;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.HouseholdAccess.Commands.LinkMembershipMember;
using AllotJar.Application.Household.Commands.UpdateHouseholdMember;
using AllotJar.Application.Household.Queries.GetMemberSpending;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Application.Reports.Queries.GetMonthReport;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.ConfirmTransferLegs;
using AllotJar.Application.Transactions.Commands.DeleteTransaction;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Application.Transactions.Queries.GetTransactions;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// W13 joint accounts and privacy (rules 30–34, P52–P59). One household: Chris (the budget owner,
/// with a login), Sam (with a login) and Kid (a person with no login). A joint account keeps one
/// balance and history whoever holds it; a personal account of someone with a login can be private
/// to that login, and then it is not there for anyone else — except where its holder put money on
/// a household budget line, or it is one side of a transfer with a shared account, both of which
/// read "Private account" and stay read-only to the others. A jar keeps its account visible.
/// </summary>
public class JointAccountsW13Tests
{
    private const string Household = "chris-login";
    private const string SamLogin = "sam-login";
    private static readonly DateOnly June10 = new(2026, 6, 10);

    private sealed class Viewer(string userId, Guid? memberId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
        public string? OwnerId => Household;
        public HouseholdRole? Role => HouseholdRole.Owner;
        public Guid? MemberId { get; } = memberId;
    }

    private readonly DbContextOptions<ApplicationDbContext> _options = new DbContextOptionsBuilder<ApplicationDbContext>()
        .UseInMemoryDatabase($"zbb-w13-{Guid.NewGuid()}")
        .Options;

    private readonly Guid _chris;
    private readonly Guid _sam;
    private readonly Guid _kid;

    public JointAccountsW13Tests()
    {
        using var db = Seed();
        _chris = AddPerson(db, "Chris", 0);
        _sam = AddPerson(db, "Sam", 1);
        _kid = AddPerson(db, "Kid", 2);
        db.HouseholdMemberships.AddRange(
            new HouseholdMembership { OwnerId = Household, UserId = Household, Role = HouseholdRole.Owner, MemberId = _chris, InvitedEmail = "chris@example.com" },
            new HouseholdMembership { OwnerId = Household, UserId = SamLogin, Role = HouseholdRole.Admin, MemberId = _sam, InvitedEmail = "sam@example.com" });
        db.SaveChanges();
    }

    private Viewer Chris => new(Household, _chris);
    private Viewer Sam => new(SamLogin, _sam);

    private ApplicationDbContext Seed() => new(_options);
    private ApplicationDbContext As(ICurrentUser viewer) => new(_options, viewer);

    private static Guid AddPerson(ApplicationDbContext db, string name, int order)
    {
        var member = new HouseholdMember { OwnerId = Household, Name = name, DisplayOrder = order };
        db.HouseholdMembers.Add(member);
        db.SaveChanges();
        return member.Id;
    }

    private async Task<Guid> CreateAccountAsync(
        Viewer viewer, string name, IReadOnlyList<Guid>? holders, bool? isPrivate = null, decimal opening = 1000m)
    {
        await using var db = As(viewer);
        var dto = await new CreateAccountCommandHandler(db, viewer).Handle(
            new CreateAccountCommand(name, AccountType.Current, "EUR", opening, LedgerFixtures.DefaultOpening,
                HolderIds: holders, IsPrivate: isPrivate),
            CancellationToken.None);
        return dto.Id;
    }

    private async Task<IReadOnlyList<string>> AccountNamesAsync(Viewer viewer)
    {
        await using var db = As(viewer);
        var list = await new GetAccountsQueryHandler(db, viewer).Handle(new GetAccountsQuery(June10), CancellationToken.None);
        return list.Select(a => a.Name).ToList();
    }

    private async Task<IReadOnlyList<TransactionDto>> TransactionsAsync(Viewer viewer)
    {
        await using var db = As(viewer);
        return await new GetTransactionsQueryHandler(db, viewer).Handle(new GetTransactionsQuery(), CancellationToken.None);
    }

    private Guid SeedLine(string name = "Groceries")
    {
        using var db = Seed();
        var month = new BudgetMonth { OwnerId = Household, Year = 2026, Month = 6 };
        var category = new BudgetCategory { BudgetMonth = month, Name = "Food", Kind = CategoryKind.Expense };
        var line = new BudgetItem { BudgetCategory = category, Name = name, PlannedAmount = 300m };
        category.Items.Add(line);
        month.Categories.Add(category);
        db.BudgetMonths.Add(month);
        db.SaveChanges();
        return line.Id;
    }

    [Fact]
    public async Task AJointAccount_HasOneBalanceAndHistory_ThatEveryHolderSees_Rule30()
    {
        var joint = await CreateAccountAsync(Chris, "Joint", new[] { _chris, _sam });
        using (var db = Seed())
        {
            LedgerFixtures.Expense(db, Household, joint, 100m, June10);
        }

        foreach (var viewer in new[] { Chris, Sam })
        {
            await using var db = As(viewer);
            var accounts = await new GetAccountsQueryHandler(db, viewer).Handle(new GetAccountsQuery(June10), CancellationToken.None);
            var account = accounts.Should().ContainSingle().Subject;
            account.CurrentBalance.Should().Be(900m, "one balance, not one per holder");
            account.Holders.Select(h => h.Name).Should().Equal("Chris", "Sam");
            account.IsPrivate.Should().BeFalse();
            account.CanChangeSharing.Should().BeFalse("a joint account is always visible (rule 33)");
        }
        (await TransactionsAsync(Sam)).Should().ContainSingle("the history is shared, not duplicated");
    }

    [Fact]
    public async Task AnAccountTheHolderAddsForThemselves_StartsPrivate_AndOnlyTheirLoginSeesIt_Rule31()
    {
        await CreateAccountAsync(Chris, "Household", null);
        await CreateAccountAsync(Sam, "Sam's current", new[] { _sam });

        (await AccountNamesAsync(Sam)).Should().Equal("Household", "Sam's current");
        (await AccountNamesAsync(Chris)).Should().Equal(new[] { "Household" }, "not even the budget owner sees it (P53)");

        await using var db = As(Sam);
        var mine = (await new GetAccountsQueryHandler(db, Sam).Handle(new GetAccountsQuery(June10), CancellationToken.None))
            .Single(a => a.Name == "Sam's current");
        mine.IsPrivate.Should().BeTrue();
        mine.CanChangeSharing.Should().BeTrue();
    }

    [Fact]
    public async Task TheHolderShares_ThenEveryoneSeesIt_AndCanMakeItPrivateAgain()
    {
        var id = await CreateAccountAsync(Sam, "Sam's current", new[] { _sam });

        await using (var db = As(Sam))
        {
            var shared = await new SetAccountSharingCommandHandler(db, Sam).Handle(new SetAccountSharingCommand(id, false), CancellationToken.None);
            shared.IsPrivate.Should().BeFalse();
        }
        (await AccountNamesAsync(Chris)).Should().Contain("Sam's current");

        await using (var db = As(Sam))
        {
            await new SetAccountSharingCommandHandler(db, Sam).Handle(new SetAccountSharingCommand(id, true), CancellationToken.None);
        }
        (await AccountNamesAsync(Chris)).Should().NotContain("Sam's current");
    }

    [Fact]
    public async Task OnlyTheHoldersOwnLogin_CanChoosePrivacy_AndOnlyForAPersonalAccount_Rules31And33()
    {
        var samsShared = await CreateAccountAsync(Chris, "Sam's savings", new[] { _sam });
        var joint = await CreateAccountAsync(Chris, "Joint", new[] { _chris, _sam });
        var household = await CreateAccountAsync(Chris, "Household", null);

        await using var db = As(Chris);
        var handler = new SetAccountSharingCommandHandler(db, Chris);
        await FluentActions.Awaiting(() => handler.Handle(new SetAccountSharingCommand(samsShared, true), CancellationToken.None))
            .Should().ThrowAsync<ForbiddenAccessException>().WithMessage("*Only Sam's own login*");
        await FluentActions.Awaiting(() => handler.Handle(new SetAccountSharingCommand(joint, true), CancellationToken.None))
            .Should().ThrowAsync<ForbiddenAccessException>();
        await FluentActions.Awaiting(() => handler.Handle(new SetAccountSharingCommand(household, true), CancellationToken.None))
            .Should().ThrowAsync<ForbiddenAccessException>();

        // Someone with no login has no privacy to choose (rule 31): their accounts stay visible.
        var create = () => CreateAccountAsync(Chris, "Kid's jar", new[] { _kid }, isPrivate: true);
        (await create.Should().ThrowAsync<ValidationException>()).Which.Errors["IsPrivate"].Single()
            .Should().Contain("Only Kid's own login");
        var joint2 = () => CreateAccountAsync(Chris, "Joint 2", new[] { _chris, _sam }, isPrivate: true);
        await joint2.Should().ThrowAsync<ValidationException>();
    }

    [Fact]
    public async Task AnAccountSomeoneElseAddsForAPersonWithALogin_StartsShared_AndAsksThemToReview_Rules31And32()
    {
        var id = await CreateAccountAsync(Chris, "Sam's savings", new[] { _sam });
        (await AccountNamesAsync(Chris)).Should().Contain("Sam's savings");

        await using (var db = As(Sam))
        {
            var review = await new GetSharingReviewQueryHandler(db, Sam).Handle(new GetSharingReviewQuery(), CancellationToken.None);
            review.Pending.Should().BeTrue();
            review.Accounts.Should().ContainSingle(a => a.Id == id && !a.IsPrivate, "nothing changes until Sam chooses");
        }
        await using (var db = As(Sam))
        {
            var done = await new CompleteSharingReviewCommandHandler(db, Sam)
                .Handle(new CompleteSharingReviewCommand(new[] { id }), CancellationToken.None);
            done.Pending.Should().BeFalse();
            done.Accounts.Single().IsPrivate.Should().BeTrue();
        }
        (await AccountNamesAsync(Chris)).Should().NotContain("Sam's savings");
    }

    [Fact]
    public async Task LinkingALoginToAPersonWhoHoldsAccounts_AsksForAReview_WithoutChangingAnything_Rule32()
    {
        await CreateAccountAsync(Chris, "Kid's savings", new[] { _kid });
        const string kidLogin = "kid-login";
        Guid membershipId;
        using (var db = Seed())
        {
            var membership = new HouseholdMembership { OwnerId = Household, UserId = kidLogin, Role = HouseholdRole.ReadOnly, InvitedEmail = "kid@example.com" };
            db.HouseholdMemberships.Add(membership);
            db.SaveChanges();
            membershipId = membership.Id;
        }

        await using (var db = As(Chris))
        {
            await new LinkMembershipMemberCommandHandler(db, Chris).Handle(new LinkMembershipMemberCommand(membershipId, _kid), CancellationToken.None);
        }

        var kid = new Viewer(kidLogin, _kid);
        await using (var db = As(kid))
        {
            var review = await new GetSharingReviewQueryHandler(db, kid).Handle(new GetSharingReviewQuery(), CancellationToken.None);
            review.Pending.Should().BeTrue();
            review.Accounts.Single().IsPrivate.Should().BeFalse("existing visibility stays until they choose");
        }
        (await AccountNamesAsync(Chris)).Should().Contain("Kid's savings");
    }

    [Fact]
    public async Task PrivacyStaysWithTheLoginThatChoseIt_ARelinkNeverRevealsIt_P59()
    {
        await CreateAccountAsync(Sam, "Sam's current", new[] { _sam });
        Guid samMembership;
        using (var db = Seed())
        {
            samMembership = db.HouseholdMemberships.Single(m => m.UserId == SamLogin).Id;
        }

        // The owner unlinks Sam's login and links their own login to Sam's person instead.
        await using (var db = As(Chris))
        {
            var handler = new LinkMembershipMemberCommandHandler(db, Chris);
            await handler.Handle(new LinkMembershipMemberCommand(samMembership, null), CancellationToken.None);
            var own = await db.HouseholdMemberships.SingleAsync(m => m.UserId == Household);
            await handler.Handle(new LinkMembershipMemberCommand(own.Id, _sam), CancellationToken.None);
        }

        (await AccountNamesAsync(new Viewer(Household, _sam))).Should().NotContain("Sam's current");
        (await AccountNamesAsync(new Viewer(SamLogin, null))).Should().Contain("Sam's current");
    }

    [Fact]
    public async Task EditingAPerson_KeepsTheirPrivateSavingsAccount_ThatTheEditorCannotSee_P53()
    {
        var mine = await CreateAccountAsync(Sam, "Sam's savings", new[] { _sam });
        using (var db = Seed())
        {
            db.HouseholdMembers.Single(m => m.Id == _sam).PersonalSavingsAccountId = mine;
            db.SaveChanges();
        }

        await using (var db = As(Chris))
        {
            var dto = await new UpdateHouseholdMemberCommandHandler(db, Chris)
                .Handle(new UpdateHouseholdMemberCommand(_sam, "Sam", 1500m, mine), CancellationToken.None);
            dto.PersonalSavingsAccountId.Should().Be(mine);
        }
        // Choosing an account the editor can't see is refused as if it did not exist: only an
        // unchanged choice is kept.
        await using (var db = As(Chris))
        {
            var choose = () => new UpdateHouseholdMemberCommandHandler(db, Chris)
                .Handle(new UpdateHouseholdMemberCommand(_kid, "Kid", 0m, mine), CancellationToken.None);
            await choose.Should().ThrowAsync<NotFoundException>();
        }
    }

    [Fact]
    public async Task APrivateAccountsMoney_IsHidden_UnlessItsOnABudgetLine_ThenItReadsPrivateAccount_P56()
    {
        var line = SeedLine();
        var mine = await CreateAccountAsync(Sam, "Sam's current", new[] { _sam });
        using (var db = Seed())
        {
            LedgerFixtures.Expense(db, Household, mine, 40m, June10);              // personal, off the budget
            LedgerFixtures.Expense(db, Household, mine, 60m, June10, line);        // groceries for the household
        }

        var others = await TransactionsAsync(Chris);
        var shown = others.Should().ContainSingle().Subject;
        shown.Amount.Should().Be(60m);
        shown.AccountName.Should().Be(TransactionMapping.PrivateAccountName);
        shown.InPrivateAccount.Should().BeTrue();

        var own = await TransactionsAsync(Sam);
        own.Should().HaveCount(2);
        own.Should().OnlyContain(t => t.AccountName == "Sam's current" && !t.InPrivateAccount);
    }

    [Fact]
    public async Task OthersCannotChangeOrDeleteAPrivateAccountsEntry_EvenOnTheBudget()
    {
        var line = SeedLine();
        var mine = await CreateAccountAsync(Sam, "Sam's current", new[] { _sam });
        Guid txId;
        using (var db = Seed())
        {
            txId = LedgerFixtures.Expense(db, Household, mine, 60m, June10, line).Id;
        }

        await using (var db = As(Chris))
        {
            var update = () => new UpdateTransactionCommandHandler(db, Chris).Handle(
                new UpdateTransactionCommand(txId, June10, "Shop", 70m, TransactionType.Expense), CancellationToken.None);
            await update.Should().ThrowAsync<ForbiddenAccessException>();
        }
        await using (var db = As(Chris))
        {
            var delete = () => new DeleteTransactionCommandHandler(db, Chris).Handle(new DeleteTransactionCommand(txId), CancellationToken.None);
            await delete.Should().ThrowAsync<ForbiddenAccessException>();
        }
        using (var db = Seed())
        {
            db.Transactions.Single(t => t.Id == txId).Amount.Should().Be(60m);
        }
    }

    [Fact]
    public async Task OthersCannotReSplitAPrivateAccountsEntry_OnlyItsSlicesWouldChange()
    {
        var groceries = SeedLine();
        var household = SeedLine("Household");
        var mine = await CreateAccountAsync(Sam, "Sam's current", new[] { _sam });
        Guid txId;
        using (var db = Seed())
        {
            var expense = LedgerFixtures.Expense(db, Household, mine, 60m, June10);
            db.TransactionSplits.AddRange(
                new TransactionSplit { TransactionId = expense.Id, BudgetItemId = groceries, Amount = 30m },
                new TransactionSplit { TransactionId = expense.Id, BudgetItemId = household, Amount = 30m });
            db.SaveChanges();
            txId = expense.Id;
        }

        // The transaction row itself is untouched by a re-split (it is already split), so the
        // refusal has to come from its slices.
        await using (var db = As(Chris))
        {
            var split = () => new SplitTransactionCommandHandler(db, Chris).Handle(
                new SplitTransactionCommand(txId, new[]
                {
                    new SplitAllocationInput(groceries, 20m),
                    new SplitAllocationInput(household, 40m),
                }), CancellationToken.None);
            await split.Should().ThrowAsync<ForbiddenAccessException>();
        }
        using (var db = Seed())
        {
            db.TransactionSplits.Where(s => s.TransactionId == txId).Select(s => s.Amount)
                .Should().BeEquivalentTo(new[] { 30m, 30m });
        }
    }

    [Fact]
    public async Task DeletingAPrivateAccount_WithMoneyOffTheBudget_IsRefused_SoItNeverSurfacesUnlinked()
    {
        var line = SeedLine();
        var mine = await CreateAccountAsync(Sam, "Sam's current", new[] { _sam });
        using (var db = Seed())
        {
            LedgerFixtures.Expense(db, Household, mine, 40m, June10);
        }

        await using (var db = As(Sam))
        {
            var delete = () => new DeleteAccountCommandHandler(db, Sam).Handle(new DeleteAccountCommand(mine), CancellationToken.None);
            (await delete.Should().ThrowAsync<ValidationException>())
                .Which.Errors["Id"].Single().Should().Contain("would show them to the whole household");
        }

        // Once only budget money is left (already visible as "Private account"), it goes as any account does.
        using (var db = Seed())
        {
            db.Transactions.Single(t => t.AccountId == mine).BudgetItemId = line;
            db.SaveChanges();
        }
        await using (var db = As(Sam))
        {
            await new DeleteAccountCommandHandler(db, Sam).Handle(new DeleteAccountCommand(mine), CancellationToken.None);
        }
        (await TransactionsAsync(Chris)).Should().ContainSingle(t => t.Amount == 40m && t.AccountId == null);
    }

    [Fact]
    public async Task ATransferFromAPrivateAccount_ShowsOnTheSharedSide_WhoseReceiptTheOthersCanConfirm_P57()
    {
        var joint = await CreateAccountAsync(Chris, "Joint", new[] { _chris, _sam });
        var mine = await CreateAccountAsync(Sam, "Sam's current", new[] { _sam });
        Guid transferId;
        using (var db = Seed())
        {
            var transfer = new Transaction
            {
                OwnerId = Household, Type = TransactionType.Transfer, AccountId = mine, TransferAccountId = joint,
                Amount = 500m, Currency = CurrencyCode.Eur, Date = June10, DepartedOn = June10, Payee = "To joint",
            };
            db.Transactions.Add(transfer);
            db.SaveChanges();
            transferId = transfer.Id;
        }

        var seen = (await TransactionsAsync(Chris)).Should().ContainSingle().Subject;
        seen.AccountName.Should().Be(TransactionMapping.PrivateAccountName);
        seen.TransferAccountName.Should().Be("Joint");

        await using (var db = As(Chris))
        {
            var confirmed = await new ConfirmTransferLegsCommandHandler(db, Chris).Handle(
                new ConfirmTransferLegsCommand(transferId, ReceivedOn: June10, ReceiptBankReference: "JNT-1"), CancellationToken.None);
            confirmed.ReceivedOn.Should().Be(June10);
        }
        await using (var db = As(Chris))
        {
            var departure = () => new ConfirmTransferLegsCommandHandler(db, Chris).Handle(
                new ConfirmTransferLegsCommand(transferId, BankReference: "SAM-1"), CancellationToken.None);
            await departure.Should().ThrowAsync<ForbiddenAccessException>("the departure is the private side's leg");
        }
        using (var check = Seed())
        {
            check.Transactions.Single().BankReference.Should().BeNull();
        }
    }

    [Fact]
    public async Task AJarOnAPrivateAccount_WarnsFirst_ThenSharesTheAccount_Rule34()
    {
        var mine = await CreateAccountAsync(Sam, "Sam's savings", new[] { _sam });
        var create = new CreateJarCommand("Holiday", JarKind.Goal, 1000m, null, AccrualMethod.FixedMonthly, mine, MonthlyContribution: 100m);

        await using (var db = As(Sam))
        {
            var act = () => new CreateJarCommandHandler(db, Sam).Handle(create, CancellationToken.None);
            (await act.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey(JarAccounts.AccountPrivateKey);
        }
        (await AccountNamesAsync(Chris)).Should().NotContain("Sam's savings", "nothing is exposed until the user chooses");

        await using (var db = As(Sam))
        {
            await new CreateJarCommandHandler(db, Sam).Handle(create with { ShareAccount = true }, CancellationToken.None);
        }
        (await AccountNamesAsync(Chris)).Should().Contain("Sam's savings");
    }

    [Fact]
    public async Task AnAccountAJarUses_CannotBeMadePrivate_AndSaysWhy_P55()
    {
        var mine = await CreateAccountAsync(Sam, "Sam's savings", new[] { _sam }, isPrivate: false);
        using (var db = Seed())
        {
            db.Jars.Add(new Jar { OwnerId = Household, Name = "Holiday", FundingAccountId = mine, IsArchived = true });
            db.SaveChanges();
        }

        await using (var db = As(Sam))
        {
            var dto = (await new GetAccountsQueryHandler(db, Sam).Handle(new GetAccountsQuery(June10), CancellationToken.None)).Single();
            dto.SharingBlockedReason.Should().Contain("Holiday");
            var act = () => new SetAccountSharingCommandHandler(db, Sam).Handle(new SetAccountSharingCommand(mine, true), CancellationToken.None);
            (await act.Should().ThrowAsync<ValidationException>()).Which.Errors["IsPrivate"].Single().Should().Contain("rule 33");
        }
    }

    [Fact]
    public async Task APrivateAccountsHolders_CannotChange_UntilItIsShared()
    {
        var mine = await CreateAccountAsync(Sam, "Sam's current", new[] { _sam });

        await using var db = As(Sam);
        var act = () => new UpdateAccountCommandHandler(db, Sam).Handle(
            new UpdateAccountCommand(mine, "Sam's current", AccountType.Current, 1000m, LedgerFixtures.DefaultOpening,
                HolderIds: new[] { _sam, _chris }),
            CancellationToken.None);
        (await act.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey("HolderIds");
    }

    [Fact]
    public async Task PrivateMoneyOffTheBudget_StaysOutOfTheHouseholdReports_ForEveryone_P56()
    {
        var line = SeedLine();
        var mine = await CreateAccountAsync(Sam, "Sam's current", new[] { _sam });
        var household = await CreateAccountAsync(Chris, "Household", null);
        using (var db = Seed())
        {
            LedgerFixtures.Expense(db, Household, mine, 40m, June10);
            LedgerFixtures.Expense(db, Household, mine, 60m, June10, line);
            LedgerFixtures.Expense(db, Household, household, 25m, June10);
            var attributed = LedgerFixtures.Expense(db, Household, mine, 15m, June10);
            attributed.MemberId = _sam;
            db.SaveChanges();
        }

        foreach (var viewer in new[] { Chris, Sam })
        {
            await using var db = As(viewer);
            var report = await new GetMonthReportQueryHandler(db, viewer).Handle(new GetMonthReportQuery(2026, 6), CancellationToken.None);
            report.SpentUncategorised.Should().Be(25m, "only the shared account's loose spending is the household's");
            report.SpentCategorised.Should().Be(60m, "the groceries Sam put on the budget count");

            var spending = await new GetMemberSpendingQueryHandler(db, viewer).Handle(new GetMemberSpendingQuery(2026, 6), CancellationToken.None);
            spending.Single(s => s.MemberId == _sam).Spent.Should().Be(0m);
        }
    }
}

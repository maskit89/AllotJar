using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Commands.CompleteSharingReview;
using AllotJar.Application.Accounts.Commands.CreateAccount;
using AllotJar.Application.Accounts.Commands.DeleteAccount;
using AllotJar.Application.Accounts.Commands.EraseUnreachableAccount;
using AllotJar.Application.Accounts.Commands.SetAccountSharing;
using AllotJar.Application.Accounts.Commands.UpdateAccount;
using AllotJar.Application.Accounts.Queries.GetAccounts;
using AllotJar.Application.Accounts.Queries.GetSharingReview;
using AllotJar.Application.Accounts.Queries.GetUnreachableAccounts;
using AllotJar.Application.Allocation.Commands.AllocateIncome;
using AllotJar.Application.Allocation.Commands.UpsertAllocationProfile;
using AllotJar.Application.Allocation.Queries.PreviewIncomeAllocation;
using AllotJar.Application.Budgets.Commands.DeleteBudgetCategory;
using AllotJar.Application.Budgets.Commands.DeleteBudgetItem;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Household.Commands.UpdateHouseholdMember;
using AllotJar.Application.Household.Queries.GetMemberSpending;
using AllotJar.Application.HouseholdAccess.Commands.LinkMembershipMember;
using AllotJar.Application.HouseholdAccess.Commands.RevokeMember;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Reports.Queries.GetMonthReport;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.AssignTransaction;
using AllotJar.Application.Transactions.Commands.ConfirmTransferLegs;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
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

        // Nor can anyone take the privacy over by hand.
        await using (var db = As(Chris))
        {
            (await db.AccountPrivacies.SingleAsync()).UserId = Household;
            var act = () => db.SaveChangesAsync();
            await act.Should().ThrowAsync<ForbiddenAccessException>();
        }
    }

    [Fact]
    public async Task ARemovedLoginsPrivateAccount_PassesToNoOtherLogin_ButThatLoginSeesItAgain_P59()
    {
        await CreateAccountAsync(Sam, "Sam's current", new[] { _sam });
        await RemoveSamsLoginAsync();
        (await AccountNamesAsync(Chris)).Should().NotContain("Sam's current", "removing a login never reveals its account");

        // Whoever the owner links to Sam's person next — their own login, another login already in
        // the household, or a fresh one — the account stays hidden (round 2 review, R2-P1-1).
        var admin = await AddLoginAsync("admin-login");
        var fresh = await AddLoginAsync("fresh-login");
        await using (var db = As(Chris))
        {
            var handler = new LinkMembershipMemberCommandHandler(db, Chris);
            var own = await db.HouseholdMemberships.SingleAsync(m => m.UserId == Household);
            foreach (var (membership, login) in new[] { (own.Id, Household), (admin, "admin-login"), (fresh, "fresh-login") })
            {
                await handler.Handle(new LinkMembershipMemberCommand(membership, _sam), CancellationToken.None);
                (await AccountNamesAsync(new Viewer(login, _sam))).Should().NotContain("Sam's current", login);
                await handler.Handle(new LinkMembershipMemberCommand(membership, null), CancellationToken.None);
            }
        }

        // Sam's own login, given access again, sees it.
        var back = await AddLoginAsync(SamLogin);
        await using (var db = As(Chris))
        {
            await new LinkMembershipMemberCommandHandler(db, Chris)
                .Handle(new LinkMembershipMemberCommand(back, _sam), CancellationToken.None);
        }
        (await AccountNamesAsync(Sam)).Should().Contain("Sam's current");
        (await AccountNamesAsync(Chris)).Should().NotContain("Sam's current");
    }

    private async Task RemoveSamsLoginAsync()
    {
        await using var db = As(Chris);
        var membership = await db.HouseholdMemberships.SingleAsync(m => m.UserId == SamLogin);
        await new RevokeMemberCommandHandler(db, Chris).Handle(new RevokeMemberCommand(membership.Id), CancellationToken.None);
    }

    private async Task<Guid> AddLoginAsync(string userId)
    {
        await using var db = Seed();
        var membership = new HouseholdMembership
        {
            OwnerId = Household, UserId = userId, Role = HouseholdRole.Admin, InvitedEmail = $"{userId}@example.com",
        };
        db.HouseholdMemberships.Add(membership);
        await db.SaveChangesAsync();
        return membership.Id;
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
    public async Task OthersCannotDeleteALineOrGroup_HoldingAPrivateAccountsEntry_ButItsHolderCan_P3_3()
    {
        var line = SeedLine();
        var mine = await CreateAccountAsync(Sam, "Sam's current", new[] { _sam });
        using (var db = Seed())
        {
            LedgerFixtures.Expense(db, Household, mine, 60m, June10, line);
        }

        await using (var db = As(Chris))
        {
            var groupId = db.BudgetItems.Where(i => i.Id == line).Select(i => i.BudgetCategoryId).Single();
            var deleteLine = () => new DeleteBudgetItemCommandHandler(db, Chris).Handle(new DeleteBudgetItemCommand(line), CancellationToken.None);
            (await deleteLine.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey("BudgetItemId");
            var deleteGroup = () => new DeleteBudgetCategoryCommandHandler(db, Chris).Handle(new DeleteBudgetCategoryCommand(groupId), CancellationToken.None);
            (await deleteGroup.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey("CategoryId");
        }
        await using (var db = As(Sam))
        {
            await new DeleteBudgetItemCommandHandler(db, Sam).Handle(new DeleteBudgetItemCommand(line), CancellationToken.None);
        }
        using (var db = Seed())
        {
            db.BudgetItems.Any(i => i.Id == line).Should().BeFalse();
        }
    }

    [Fact]
    public async Task DeletingAnAccount_ClearsItAsAPersonsSavingsAccountAndTheAllocationsSource_P3_5()
    {
        var savings = await CreateAccountAsync(Chris, "Kid's savings", new[] { _kid });
        using (var db = Seed())
        {
            db.HouseholdMembers.Single(m => m.Id == _kid).PersonalSavingsAccountId = savings;
            db.AllocationProfiles.Add(new AllocationProfile { OwnerId = Household, Name = "Default", SourceAccountId = savings });
            db.SaveChanges();
        }

        await using (var db = As(Chris))
        {
            await new DeleteAccountCommandHandler(db, Chris).Handle(new DeleteAccountCommand(savings), CancellationToken.None);
        }

        using (var db = Seed())
        {
            db.HouseholdMembers.Single(m => m.Id == _kid).PersonalSavingsAccountId.Should().BeNull();
            db.AllocationProfiles.Single().SourceAccountId.Should().BeNull();
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
    public async Task MovingAJarIntoTheHoldersPrivateAccount_SharesIt_AndItsEarlierPaymentOnTheJarsLineStaysOffTheJar_Rule34()
    {
        // With P2-20 (#276): the account a jar joins keeps the payments on the jar's line it recorded
        // before the move on its own unallocated money, even one dated the move day. They are written
        // down in the same save that shares the account, which the privacy guard lets through.
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var household = await CreateAccountAsync(Chris, "Household", null);
        var mine = await CreateAccountAsync(Sam, "Sam's current", new[] { _sam });
        var jar = new Jar
        {
            OwnerId = Household, Name = "Holiday", Kind = JarKind.Goal, TargetAmount = 1000m,
            Accrual = AccrualMethod.FixedMonthly, MonthlyContribution = 100m, FundingAccountId = household,
        };
        using (var db = Seed())
        {
            db.Jars.Add(jar);
            var line = new BudgetItem { Name = "Holiday", PlannedAmount = 100m, SavingsId = jar.Id };
            db.BudgetMonths.Add(new BudgetMonth
            {
                OwnerId = Household, Year = today.Year, Month = today.Month,
                Categories = new List<BudgetCategory> { new() { Name = "Savings", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { line } } },
            });
            db.SaveChanges();
            LedgerFixtures.Expense(db, Household, mine, 50m, today, line.Id);
        }

        await using (var db = As(Sam))
        {
            await new UpdateJarCommandHandler(db, Sam).Handle(
                new UpdateJarCommand(jar.Id, "Holiday", JarKind.Goal, 1000m, null, AccrualMethod.FixedMonthly, mine,
                    MonthlyContribution: 100m, ShareAccount: true),
                CancellationToken.None);
        }

        (await AccountNamesAsync(Chris)).Should().Contain("Sam's current");
        using (var db = Seed())
        {
            var ledger = await JarLedgerReader.ReadAsync(db, Household, today, CancellationToken.None);
            ledger.BalanceOf(jar.Id).Should().Be(0m);
            ledger.Accounts[mine].Unallocated.Should().Be(950m);
        }
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

    // ---- Review of PR #277: privacy through the other flows ------------------------------------

    [Fact]
    public async Task APrivateEntryLeftOffTheBudget_IsNeverAutoCategorisedOntoALine_P56()
    {
        var groceries = SeedLine();
        var joint = await CreateAccountAsync(Chris, "Joint", holders: null);
        var mine = await CreateAccountAsync(Sam, "Sam's current", new[] { _sam });
        using (var db = Seed())
        {
            // The household's history teaches "Pharmacy -> Groceries".
            LedgerFixtures.Expense(db, Household, joint, 20m, new DateOnly(2026, 6, 1), groceries).Payee = "Pharmacy";
            db.SaveChanges();
        }

        await using (var db = As(Sam))
        {
            var dto = await new CreateTransactionCommandHandler(db, Sam).Handle(
                new CreateTransactionCommand(June10, "Pharmacy", 85m, TransactionType.Expense, BudgetItemId: null, AccountId: mine),
                CancellationToken.None);
            dto.BudgetItemId.Should().BeNull("only its holder puts private money on the budget");
        }
        (await TransactionsAsync(Chris)).Should().NotContain(t => t.Amount == 85m);
    }

    [Fact]
    public async Task IncomeAllocation_IntoAPrivateSavingsAccount_IsRefusedUpFront_ThenItsHolderRunsIt_P53()
    {
        var (joint, samSavings) = await SeedAllocationAsync();

        await using (var db = As(Chris))
        {
            var preview = await new PreviewIncomeAllocationQueryHandler(db, Chris)
                .Handle(new PreviewIncomeAllocationQuery(2026, 6), CancellationToken.None);
            preview.Members.Single(m => m.MemberId == _sam).SavingsPrivate.Should().BeTrue();
            preview.Members.Single(m => m.MemberId == _chris).SavingsPrivate.Should().BeFalse();

            var act = () => new AllocateIncomeCommandHandler(db, Chris).Handle(
                new AllocateIncomeCommand(2026, 6, DepartedOn: new DateOnly(2026, 6, 3), ConfirmedCompleted: true),
                CancellationToken.None);
            (await act.Should().ThrowAsync<ValidationException>()).Which.Errors["Allocation"].Single()
                .Should().StartWith("Sam's savings account is private");
        }
        using (var check = Seed())
        {
            check.Transactions.Should().NotContain(t => t.Type == TransactionType.Transfer, "nothing moves for anyone");
        }

        await using (var db = As(Sam))
        {
            await new AllocateIncomeCommandHandler(db, Sam).Handle(
                new AllocateIncomeCommand(2026, 6, DepartedOn: new DateOnly(2026, 6, 3), ConfirmedCompleted: true),
                CancellationToken.None);
        }
        using (var check = Seed())
        {
            check.Transactions.Should().Contain(t => t.AccountId == joint && t.TransferAccountId == samSavings);
        }
    }

    private async Task<(Guid Joint, Guid SamSavings)> SeedAllocationAsync()
    {
        var joint = await CreateAccountAsync(Chris, "Joint", holders: null, opening: 20000m);
        var chrisSavings = await CreateAccountAsync(Chris, "Chris savings", new[] { _chris }, isPrivate: false);
        var samSavings = await CreateAccountAsync(Sam, "Sam savings", new[] { _sam });
        using (var db = Seed())
        {
            db.HouseholdMembers.Single(m => m.Id == _chris).PersonalSavingsAccountId = chrisSavings;
            db.HouseholdMembers.Single(m => m.Id == _sam).PersonalSavingsAccountId = samSavings;
            db.BudgetMonths.Add(new BudgetMonth
            {
                OwnerId = Household, Year = 2026, Month = 6, BaseCurrency = CurrencyCode.Eur,
                Categories = new List<BudgetCategory>
                {
                    new()
                    {
                        Name = "Income", Kind = CategoryKind.Income,
                        Items = new List<BudgetItem>
                        {
                            new() { Name = "Chris", PlannedAmount = 3000m, MemberId = _chris },
                            new() { Name = "Sam", PlannedAmount = 3000m, MemberId = _sam },
                        },
                    },
                    new() { Name = "Living", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { new() { Name = "Living", PlannedAmount = 1000m } } },
                },
            });
            db.SaveChanges();
        }
        await using (var db = As(Chris))
        {
            await new UpsertAllocationProfileCommandHandler(db, Chris).Handle(
                new UpsertAllocationProfileCommand(null, "Monthly", joint, new List<AllocationRuleSpec>
                {
                    new(0, AllocationRuleType.FundEnvelopes, SplitMethod.Equal, 0m),
                    new(1, AllocationRuleType.SplitRemainderToMembers, SplitMethod.Equal, 0m),
                }), CancellationToken.None);
        }
        return (joint, samSavings);
    }

    [Fact]
    public async Task ARefundInAPrivateAccount_StillCountsAgainstThePurchase_ForEveryone_P20()
    {
        var groceries = SeedLine();
        var joint = await CreateAccountAsync(Chris, "Joint", holders: null);
        var mine = await CreateAccountAsync(Sam, "Sam's current", new[] { _sam });
        Guid purchase;
        using (var db = Seed())
        {
            purchase = LedgerFixtures.Expense(db, Household, joint, 100m, new DateOnly(2026, 6, 1), groceries).Id;
        }
        // Sam takes 60 back into his private account and keeps it off the budget.
        await using (var db = As(Sam))
        {
            var refund = await new CreateTransactionCommandHandler(db, Sam).Handle(
                new CreateTransactionCommand(June10, "Shop refund", 60m, TransactionType.Income, BudgetItemId: null,
                    AccountId: mine, RefundOfTransactionId: purchase),
                CancellationToken.None);
            await new AssignTransactionCommandHandler(db, Sam).Handle(new AssignTransactionCommand(refund.Id, null), CancellationToken.None);
        }
        (await TransactionsAsync(Chris)).Should().NotContain(t => t.Payee == "Shop refund");

        await using (var db = As(Chris))
        {
            var second = () => new CreateTransactionCommandHandler(db, Chris).Handle(
                new CreateTransactionCommand(June10, "Shop refund", 60m, TransactionType.Income, BudgetItemId: null,
                    AccountId: joint, RefundOfTransactionId: purchase),
                CancellationToken.None);
            (await second.Should().ThrowAsync<ValidationException>("120 back on a 100 purchase")).Which.Errors
                .SelectMany(e => e.Value).Should().NotContain(m => m.Contains("60"), "the private refund's amount stays private");

            var shrink = () => new UpdateTransactionCommandHandler(db, Chris).Handle(
                new UpdateTransactionCommand(purchase, new DateOnly(2026, 6, 1), "Shop", 50m, TransactionType.Expense, AccountId: joint),
                CancellationToken.None);
            (await shrink.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey("Amount");

            var delete = () => new DeleteTransactionCommandHandler(db, Chris).Handle(
                new DeleteTransactionCommand(purchase), CancellationToken.None);
            (await delete.Should().ThrowAsync<ValidationException>()).Which.Errors["TransactionId"].Single()
                .Should().Contain("private account");
        }
    }

    [Fact]
    public async Task AnAccountWithAnArchivedHolder_CanStillBeRenamed()
    {
        var account = await CreateAccountAsync(Chris, "Sam's old current", new[] { _sam });
        using (var db = Seed())
        {
            foreach (var person in db.HouseholdMembers.Where(m => m.Id == _sam || m.Id == _kid))
            {
                person.IsArchived = true;
            }
            db.SaveChanges();
        }

        await using (var db = As(Chris))
        {
            var dto = await new UpdateAccountCommandHandler(db, Chris).Handle(
                new UpdateAccountCommand(account, "Old current (closed)", AccountType.Current, 1000m, LedgerFixtures.DefaultOpening,
                    HolderIds: new[] { _sam }),
                CancellationToken.None);
            dto.Name.Should().Be("Old current (closed)");

            var addKid = () => new UpdateAccountCommandHandler(db, Chris).Handle(
                new UpdateAccountCommand(account, "Old current (closed)", AccountType.Current, 1000m, LedgerFixtures.DefaultOpening,
                    HolderIds: new[] { _sam, _kid }),
                CancellationToken.None);
            (await addKid.Should().ThrowAsync<ValidationException>("an archived person still can't be given a new account"))
                .Which.Errors.Should().ContainKey("HolderIds");
        }
    }

    [Fact]
    public async Task AnAccountThatGetsAJarWhileItIsBeingMadePrivate_StaysShared_Rule33()
    {
        var account = await CreateAccountAsync(Sam, "Sam's savings", new[] { _sam }, isPrivate: false);

        // Sam's request passed its checks (no jar yet) and is about to save...
        await using var sam = As(Sam);
        sam.AccountPrivacies.Add(new AccountPrivacy { AccountId = account, UserId = SamLogin });
        // ...when Chris puts a jar on the account.
        await using (var db = As(Chris))
        {
            await new CreateJarCommandHandler(db, Chris).Handle(
                new CreateJarCommand("Holiday", JarKind.Goal, 1000m, null, AccrualMethod.FixedMonthly, account, MonthlyContribution: 100m),
                CancellationToken.None);
        }

        var save = () => sam.SaveChangesAsync();
        (await save.Should().ThrowAsync<ValidationException>()).Which.Errors["IsPrivate"].Single().Should().Contain("Holiday");
        (await AccountNamesAsync(Chris)).Should().Contain("Sam's savings");
    }

    [Fact]
    public async Task AJarPutOnAnAccountThatWentPrivateMeanwhile_IsWarnedAboutAgain_Rule34()
    {
        var account = await CreateAccountAsync(Sam, "Sam's savings", new[] { _sam }, isPrivate: false);

        // Sam's jar passed its check (the account was shared) and is about to save...
        await using var creating = As(Sam);
        creating.Jars.Add(new Jar { OwnerId = Household, Name = "Holiday", FundingAccountId = account });
        // ...when Sam, on another device, makes the account private.
        await using (var db = As(Sam))
        {
            await new SetAccountSharingCommandHandler(db, Sam).Handle(new SetAccountSharingCommand(account, true), CancellationToken.None);
        }

        var save = () => creating.SaveChangesAsync();
        (await save.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey(JarAccounts.AccountPrivateKey);
        using var check = Seed();
        check.Jars.Should().BeEmpty();
    }

    // ── P59 owner-side erase (Christopher's "Add", 30 September 2026) ──

    private sealed class OwnerAs(string userId, Guid? memberId, HouseholdRole role) : ICurrentUser
    {
        public string? UserId { get; } = userId;
        public string? OwnerId => Household;
        public HouseholdRole? Role => role;
        public Guid? MemberId { get; } = memberId;
    }

    /// <summary>Sam's private account with an entry off the budget, one on the budget and a transfer in from the joint account.</summary>
    private async Task<(Guid Joint, Guid Mine, Guid Transfer)> SeedSamsPrivateMoneyAsync()
    {
        var line = SeedLine();
        var joint = await CreateAccountAsync(Chris, "Joint", holders: null, opening: 1000m);
        var mine = await CreateAccountAsync(Sam, "Sam's current", new[] { _sam });
        Guid transfer;
        await using (var db = As(Sam))
        {
            var sam = new CreateTransactionCommandHandler(db, Sam);
            await sam.Handle(new CreateTransactionCommand(June10, "Pharmacy", 40m, TransactionType.Expense, BudgetItemId: null, AccountId: mine), CancellationToken.None);
            await sam.Handle(new CreateTransactionCommand(June10, "Groceries", 60m, TransactionType.Expense, BudgetItemId: line, AccountId: mine), CancellationToken.None);
            transfer = (await new CreateTransferCommandHandler(db, Sam).Handle(
                new CreateTransferCommand(June10, 200m, joint, mine, ReceivedOn: June10), CancellationToken.None)).Id;
        }
        return (joint, mine, transfer);
    }

    [Fact]
    public async Task TheOwnerCanEraseAnAccountNobodyCanReach_WithEverythingInIt_P59()
    {
        var (joint, mine, transfer) = await SeedSamsPrivateMoneyAsync();
        await RemoveSamsLoginAsync();

        await using (var db = As(Chris))
        {
            var listed = await new GetUnreachableAccountsQueryHandler(db, Chris).Handle(new GetUnreachableAccountsQuery(), CancellationToken.None);
            var only = listed.Should().ContainSingle().Subject;
            only.Id.Should().Be(mine);
            only.Name.Should().Be("Sam's current");
            only.HolderName.Should().Be("Sam");
            only.EntryCount.Should().Be(3, "two entries in it and the transfer into it");

            var erase = new EraseUnreachableAccountCommandHandler(db, Chris);
            var wrongName = () => erase.Handle(new EraseUnreachableAccountCommand(mine, "Sams current"), CancellationToken.None);
            (await wrongName.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey("ConfirmName");

            await erase.Handle(new EraseUnreachableAccountCommand(mine, " sam's CURRENT "), CancellationToken.None);
        }

        using var check = Seed();
        check.Accounts.Should().NotContain(a => a.Id == mine);
        check.AccountPrivacies.Should().NotContain(p => p.AccountId == mine);
        check.AccountHolders.Should().NotContain(h => h.AccountId == mine);
        check.Transactions.Should().NotContain(t => t.AccountId == mine || t.TransferAccountId == mine);
        check.Transactions.Should().NotContain(t => t.Id == transfer, "the transfer into the account went with it");
        check.Accounts.Should().Contain(a => a.Id == joint);
        (await AccountNamesAsync(Chris)).Should().Contain("Joint").And.NotContain("Sam's current");
        (await new GetUnreachableAccountsQueryHandler(As(Chris), Chris).Handle(new GetUnreachableAccountsQuery(), CancellationToken.None)).Should().BeEmpty();
    }

    [Fact]
    public async Task AnAccountItsHolderCanStillReach_IsNeitherListed_NorErasable_P59()
    {
        var (_, mine, _) = await SeedSamsPrivateMoneyAsync();

        await using var db = As(Chris);
        (await new GetUnreachableAccountsQueryHandler(db, Chris).Handle(new GetUnreachableAccountsQuery(), CancellationToken.None)).Should().BeEmpty();
        var erase = () => new EraseUnreachableAccountCommandHandler(db, Chris).Handle(new EraseUnreachableAccountCommand(mine, "Sam's current"), CancellationToken.None);
        await erase.Should().ThrowAsync<NotFoundException>();
        (await AccountNamesAsync(Sam)).Should().Contain("Sam's current");
    }

    [Fact]
    public async Task OnlyTheOwnerSeesWhatNobodyCanReach_P59()
    {
        var (_, mine, _) = await SeedSamsPrivateMoneyAsync();
        await RemoveSamsLoginAsync();
        var admin = new OwnerAs("admin-login", null, HouseholdRole.Admin);

        await using var db = As(admin);
        (await new GetUnreachableAccountsQueryHandler(db, admin).Handle(new GetUnreachableAccountsQuery(), CancellationToken.None)).Should().BeEmpty();
        using var check = Seed();
        check.Accounts.Should().Contain(a => a.Id == mine);
    }

    [Fact]
    public async Task ErasingIsRefused_WhileTheSharedSideWouldGoBelowZero_Rule74()
    {
        var (joint, mine, _) = await SeedSamsPrivateMoneyAsync();
        // The joint account spent what came back from Sam's account: without that transfer it dips below zero.
        await using (var db = As(Sam))
        {
            await new CreateTransferCommandHandler(db, Sam).Handle(
                new CreateTransferCommand(June10.AddDays(1), 400m, mine, joint, ReceivedOn: June10.AddDays(1)), CancellationToken.None);
        }
        using (var db = Seed())
        {
            // Joint: 1,000 − 200 + 400 − 1,100 = 100 today; without the two transfers it would read −100.
            LedgerFixtures.Expense(db, Household, joint, 1100m, June10.AddDays(2));
        }
        await RemoveSamsLoginAsync();

        await using (var db = As(Chris))
        {
            var erase = () => new EraseUnreachableAccountCommandHandler(db, Chris).Handle(new EraseUnreachableAccountCommand(mine, "Sam's current"), CancellationToken.None);
            (await erase.Should().ThrowAsync<ValidationException>()).Which.Errors["Id"].Single().Should().Contain("Joint");
        }
        using var check = Seed();
        check.Accounts.Should().Contain(a => a.Id == mine);
    }

    // #277 P3-6: an earlier run's transfer into a private account this caller can't remove is
    // refused with a message naming the person, not the privacy guard's 403.
    [Fact]
    public async Task ReRunningTheAllocation_OverATransferIntoAPrivateAccount_NamesThePerson_P53()
    {
        var (joint, samSavings) = await SeedAllocationAsync();
        await using (var db = As(Sam))
        {
            await new AllocateIncomeCommandHandler(db, Sam).Handle(
                new AllocateIncomeCommand(2026, 6, DepartedOn: new DateOnly(2026, 6, 3), ConfirmedCompleted: true), CancellationToken.None);
        }
        // Sam's savings now point at a shared account, so Chris's re-run would replace Sam's transfer.
        var shared = await CreateAccountAsync(Chris, "Sam shared savings", new[] { _sam }, isPrivate: false);
        using (var db = Seed())
        {
            db.HouseholdMembers.Single(m => m.Id == _sam).PersonalSavingsAccountId = shared;
            db.SaveChanges();
        }

        await using (var db = As(Chris))
        {
            var act = () => new AllocateIncomeCommandHandler(db, Chris).Handle(
                new AllocateIncomeCommand(2026, 6, DepartedOn: new DateOnly(2026, 6, 4), ConfirmedCompleted: true), CancellationToken.None);
            (await act.Should().ThrowAsync<ValidationException>()).Which.Errors["Allocation"].Single()
                .Should().Contain("private to Sam").And.Contain("only Sam");
        }
        using var check = Seed();
        check.Transactions.Should().ContainSingle(t => t.TransferAccountId == samSavings, "nothing moved");
        check.Transactions.Should().NotContain(t => t.TransferAccountId == shared);
        _ = joint;
    }
}

using FluentAssertions;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Identity;

namespace AllotJar.IntegrationTests;

/// <summary>
/// "Delete my account" (compliance fix 5) on the real schema: the restricting links between a
/// transfer and its fee, a refund and its purchase, a jar and its account and the jar's postings
/// don't stop the household's rows from going, and it all goes in one transaction. The unit suite
/// covers the rules on EF InMemory, which ignores those constraints.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class AccountDeletionSqlTests
{
    private readonly SqlServerFixture _fixture;

    public AccountDeletionSqlTests(SqlServerFixture fixture) => _fixture = fixture;

    private static readonly DateOnly June10 = new(2026, 6, 10);

    [Fact]
    public async Task Deleting_an_owner_removes_every_row_of_the_household_and_the_login()
    {
        var owner = $"user-{Guid.NewGuid():N}";
        var member = $"sam-{Guid.NewGuid():N}";
        await using (var db = _fixture.CreateContext())
        {
            db.Users.AddRange(
                new ApplicationUser { Id = owner, Email = $"{owner}@example.com", UserName = $"{owner}@example.com" },
                new ApplicationUser { Id = member, Email = $"{member}@example.com", UserName = $"{member}@example.com", ActiveOwnerId = owner });
            db.UserLogins.Add(new IdentityUserLogin<string> { UserId = owner, LoginProvider = "Google", ProviderKey = owner, ProviderDisplayName = "Google" });
            db.RefreshTokens.Add(new RefreshToken { UserId = owner, TokenHash = $"hash-{owner}", ExpiresUtc = DateTime.UtcNow.AddDays(1) });

            var chris = new HouseholdMember { OwnerId = owner, Name = "Chris" };
            var sam = new HouseholdMember { OwnerId = owner, Name = "Sam" };
            db.HouseholdMembers.AddRange(chris, sam);
            db.HouseholdMemberships.AddRange(
                new HouseholdMembership { OwnerId = owner, UserId = owner, Role = HouseholdRole.Owner, MemberId = chris.Id, InvitedEmail = "c@example.com", Status = MembershipStatus.Active },
                new HouseholdMembership { OwnerId = owner, UserId = member, Role = HouseholdRole.Admin, MemberId = sam.Id, InvitedEmail = "s@example.com", Status = MembershipStatus.Active });
            db.PersonLogins.Add(new PersonLogin { HouseholdMemberId = sam.Id, UserId = member });

            var joint = Account(owner, "Joint");
            var samsOwn = Account(owner, "Sam's current");
            db.Accounts.AddRange(joint, samsOwn);
            db.AccountHolders.Add(new AccountHolder { AccountId = samsOwn.Id, MemberId = sam.Id });
            db.AccountPrivacies.Add(new AccountPrivacy { AccountId = samsOwn.Id, UserId = member });

            var jar = new Jar { OwnerId = owner, Name = "Holiday", FundingAccountId = joint.Id, TargetAmount = 600m };
            db.Jars.Add(jar);
            var month = new BudgetMonth { OwnerId = owner, Year = 2026, Month = 6 };
            var category = new BudgetCategory { BudgetMonth = month, Name = "Food", Kind = CategoryKind.Expense };
            var line = new BudgetItem { BudgetCategory = category, Name = "Groceries", PlannedAmount = 300m, SavingsId = jar.Id };
            category.Items.Add(line);
            month.Categories.Add(category);
            db.BudgetMonths.Add(month);

            var purchase = Row(owner, joint.Id, TransactionType.Expense, 30m, line.Id);
            var refund = Row(owner, joint.Id, TransactionType.Income, 10m, line.Id);
            refund.RefundOfTransactionId = purchase.Id;
            var transfer = new Transaction
            {
                OwnerId = owner, Type = TransactionType.Transfer, AccountId = joint.Id, TransferAccountId = samsOwn.Id,
                Amount = 100m, Currency = CurrencyCode.Eur, Date = June10, DepartedOn = June10, ReceivedOn = June10, Payee = "To Sam",
            };
            var fee = Row(owner, joint.Id, TransactionType.Expense, 2m, line.Id);
            fee.FeeForTransferId = transfer.Id;
            db.Transactions.AddRange(purchase, refund, transfer, fee);
            db.TransactionSplits.Add(new TransactionSplit { TransactionId = purchase.Id, BudgetItemId = line.Id, Amount = 30m });

            var allocation = new JarAllocation { OwnerId = owner, AccountId = joint.Id, Kind = JarAllocationKind.Movement, Date = June10, TransactionId = transfer.Id };
            allocation.Postings.Add(new JarAllocationPosting { JarId = jar.Id, Amount = 50m });
            db.JarAllocations.Add(allocation);
            db.JarCycles.Add(new JarCycle { OwnerId = owner, JarId = jar.Id, Deadline = June10, TargetAmount = 600m, PaymentTransactionId = purchase.Id, ClosedOn = June10 });

            var profile = new AllocationProfile { OwnerId = owner, Name = "Default", SourceAccountId = joint.Id };
            profile.Rules.Add(new AllocationRule { Order = 1, Type = AllocationRuleType.FixedPerMember });
            db.AllocationProfiles.Add(profile);
            await db.SaveChangesAsync();
        }

        await new AccountDeletion(_fixture.Options).DeleteAsync(owner, CancellationToken.None);

        await using var check = _fixture.CreateContext();
        (await check.Users.AnyAsync(u => u.Id == owner)).Should().BeFalse();
        (await check.UserLogins.AnyAsync(l => l.UserId == owner)).Should().BeFalse();
        (await check.RefreshTokens.AnyAsync(t => t.UserId == owner)).Should().BeFalse();
        (await check.Accounts.AnyAsync(a => a.OwnerId == owner)).Should().BeFalse();
        (await check.Transactions.AnyAsync(t => t.OwnerId == owner)).Should().BeFalse();
        (await check.Jars.AnyAsync(j => j.OwnerId == owner)).Should().BeFalse();
        (await check.JarAllocations.AnyAsync(a => a.OwnerId == owner)).Should().BeFalse();
        (await check.JarCycles.AnyAsync(c => c.OwnerId == owner)).Should().BeFalse();
        (await check.BudgetMonths.AnyAsync(m => m.OwnerId == owner)).Should().BeFalse();
        (await check.AllocationProfiles.AnyAsync(p => p.OwnerId == owner)).Should().BeFalse();
        (await check.HouseholdMembers.AnyAsync(m => m.OwnerId == owner)).Should().BeFalse();
        (await check.HouseholdMemberships.AnyAsync(m => m.OwnerId == owner)).Should().BeFalse();
        (await check.PersonLogins.AnyAsync(p => p.UserId == member)).Should().BeFalse();
        // Sam keeps the login and gets a household of their own to land in.
        var samAfter = await check.Users.SingleAsync(u => u.Id == member);
        samAfter.ActiveOwnerId.Should().BeNull();
        (await check.HouseholdMemberships.AnyAsync(m => m.OwnerId == member && m.UserId == member && m.Role == HouseholdRole.Owner))
            .Should().BeTrue();
    }

    [Fact]
    public async Task Deleting_a_member_erases_their_private_account_and_keeps_the_joint_side_in_one_transaction()
    {
        var owner = $"user-{Guid.NewGuid():N}";
        var member = $"sam-{Guid.NewGuid():N}";
        Guid joint, mine, transfer;
        await using (var db = _fixture.CreateContext())
        {
            db.Users.AddRange(
                new ApplicationUser { Id = owner, Email = $"{owner}@example.com", UserName = $"{owner}@example.com" },
                new ApplicationUser { Id = member, Email = $"{member}@example.com", UserName = $"{member}@example.com" });
            db.HouseholdMemberships.AddRange(
                new HouseholdMembership { OwnerId = owner, UserId = owner, Role = HouseholdRole.Owner, InvitedEmail = "c@example.com", Status = MembershipStatus.Active },
                new HouseholdMembership { OwnerId = owner, UserId = member, Role = HouseholdRole.Admin, InvitedEmail = "s@example.com", Status = MembershipStatus.Active });
            var shared = Account(owner, "Joint");
            var own = Account(owner, "Sam's current");
            db.Accounts.AddRange(shared, own);
            db.AccountPrivacies.Add(new AccountPrivacy { AccountId = own.Id, UserId = member });
            var move = new Transaction
            {
                OwnerId = owner, Type = TransactionType.Transfer, AccountId = shared.Id, TransferAccountId = own.Id,
                Amount = 100m, Currency = CurrencyCode.Eur, Date = June10, DepartedOn = June10, ReceivedOn = June10, Payee = "To Sam",
            };
            db.Transactions.AddRange(move, Row(owner, own.Id, TransactionType.Expense, 40m, null));
            await db.SaveChangesAsync();
            (joint, mine, transfer) = (shared.Id, own.Id, move.Id);
        }

        await new AccountDeletion(_fixture.Options).DeleteAsync(member, CancellationToken.None);

        await using var check = _fixture.CreateContext();
        (await check.Users.AnyAsync(u => u.Id == member)).Should().BeFalse();
        (await check.Accounts.AnyAsync(a => a.Id == mine)).Should().BeFalse();
        (await check.Transactions.AnyAsync(t => t.AccountId == mine)).Should().BeFalse();
        var kept = await check.Transactions.SingleAsync(t => t.Id == transfer);
        kept.AccountId.Should().Be(joint);
        kept.Type.Should().Be(TransactionType.Expense);
        kept.CounterpartyErased.Should().BeTrue();
        (await check.HouseholdMemberships.AnyAsync(m => m.OwnerId == owner && m.UserId == owner)).Should().BeTrue();
        (await check.Users.AnyAsync(u => u.Id == owner)).Should().BeTrue();
    }

    private static Account Account(string owner, string name) => new()
    {
        OwnerId = owner, Name = name, Type = AccountType.Current, Currency = CurrencyCode.Eur,
        OpeningBalance = 1000m, OpeningDate = new DateOnly(2026, 1, 1),
    };

    private static Transaction Row(string owner, Guid account, TransactionType type, decimal amount, Guid? line) => new()
    {
        OwnerId = owner, AccountId = account, Type = type, Amount = amount, Currency = CurrencyCode.Eur,
        Date = June10, Payee = "Shop", BudgetItemId = line,
    };
}

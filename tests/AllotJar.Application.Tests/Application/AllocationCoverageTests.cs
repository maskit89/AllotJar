using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Allocation.Commands.AllocateIncome;
using AllotJar.Application.Allocation.Commands.UpsertAllocationProfile;
using AllotJar.Application.Allocation.Dtos;
using AllotJar.Application.Allocation.Queries.PreviewIncomeAllocation;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Application-layer coverage for the income-allocation catalog (docs/testing/cases/14-allocation.md)
/// exercised end-to-end through the real preview query + commit command (so the AllocationPlanner's
/// budget resolution, savings-balance filtering and dangling-account nulling are all in the loop).
/// Complements the pure-math Domain/IncomeAllocatorTests and the SQL-level AllocationRerunTests.
/// Money is decimal(18,4); actuals are transaction-derived at read time; assertions check invariants
/// (sum-exactness, reconciliation, skip conditions), never fragile per-cent placement.
/// </summary>
public class AllocationCoverageTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private const string Owner = "user-1";

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-alloc-cov-{Guid.NewGuid()}")
            .Options);

    private static Account SeedAccount(
        ApplicationDbContext db, string name, decimal opening = 0m, CurrencyCode? currency = null)
    {
        var a = new Account
        {
            OwnerId = Owner, Name = name, Type = AccountType.Current,
            Currency = currency ?? CurrencyCode.Eur, OpeningBalance = opening,
        };
        db.Accounts.Add(a);
        db.SaveChanges();
        return a;
    }

    private static HouseholdMember SeedMember(
        ApplicationDbContext db, string name, decimal net, int order, Guid? savings)
    {
        var m = new HouseholdMember
        {
            OwnerId = Owner, Name = name, NetMonthlyIncome = net, DisplayOrder = order,
            PersonalSavingsAccountId = savings,
        };
        db.HouseholdMembers.Add(m);
        db.SaveChanges();
        return m;
    }

    private static void SeedBudget(
        ApplicationDbContext db, int year, int month, decimal envelopes, decimal funds, CurrencyCode? currency = null)
    {
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = year, Month = month, BaseCurrency = currency ?? CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Living", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { new() { Name = "Living", PlannedAmount = envelopes } } },
                new() { Name = "Funds", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { new() { Name = "Funds", SavingsId = Guid.NewGuid(), PlannedAmount = funds } } },
            },
        });
        db.SaveChanges();
    }

    /// <summary>A transfer moving <paramref name="amount"/> INTO <paramref name="intoAccount"/>.</summary>
    private static void SeedTransferInto(
        ApplicationDbContext db, Guid intoAccount, decimal amount, string? bankRef)
    {
        db.Transactions.Add(new Transaction
        {
            OwnerId = Owner, Type = TransactionType.Transfer, Date = new DateOnly(2026, 7, 1),
            Amount = amount, Currency = CurrencyCode.Eur, ExchangeRate = 1m,
            TransferAccountId = intoAccount, BankReference = bankRef, Payee = "prior transfer",
        });
        db.SaveChanges();
    }

    // The standard four-rule waterfall the client always writes: fund envelopes, fund jars,
    // fixed pocket money, then split the remainder to savings.
    private static List<AllocationRuleSpec> StandardRules(
        SplitMethod costSplit = SplitMethod.Equal,
        SplitMethod savingsSplit = SplitMethod.BalanceTilt,
        decimal pocket = 0m) => new()
    {
        new(0, AllocationRuleType.FundEnvelopes, costSplit, 0m),
        new(1, AllocationRuleType.FundJars, costSplit, 0m),
        new(2, AllocationRuleType.FixedPerMember, SplitMethod.Equal, pocket),
        new(3, AllocationRuleType.SplitRemainderToMembers, savingsSplit, 0m),
    };

    private static Task Upsert(
        ApplicationDbContext db, ICurrentUser user, IReadOnlyList<AllocationRuleSpec> rules, Guid? source = null, int lean = 25) =>
        new UpsertAllocationProfileCommandHandler(db, user)
            .Handle(new UpsertAllocationProfileCommand(null, "Household allocation", source, rules, lean), CancellationToken.None);

    private static Task<AllocationResultDto> Preview(ApplicationDbContext db, ICurrentUser user, int year, int month) =>
        new PreviewIncomeAllocationQueryHandler(db, user)
            .Handle(new PreviewIncomeAllocationQuery(year, month), CancellationToken.None);

    private static Task<AllocationResultDto> Commit(ApplicationDbContext db, ICurrentUser user, int year, int month) =>
        new AllocateIncomeCommandHandler(db, user)
            .Handle(new AllocateIncomeCommand(year, month), CancellationToken.None);

    private static decimal StepTotal(AllocationResultDto r, AllocationRuleType type) =>
        r.Steps.Single(s => s.Type == type).Total;

    // ALLOC-029, ALLOC-030 — the hero: Income to allocate / Shared spending / To savings, and the
    // by-construction reconciliation Shared spending + To savings = the pool.
    [Fact]
    public async Task Preview_HeroSums_ReconcileToThePool()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub(Owner);
        SeedMember(db, "Alex", 3000m, 0, null);
        SeedMember(db, "Robin", 2000m, 1, null);
        SeedBudget(db, 2026, 7, envelopes: 2000m, funds: 500m);
        await Upsert(db, user, StandardRules());

        var result = await Preview(db, user, 2026, 7);

        result.Pool.Should().Be(5000m);          // "Income to allocate" = Σ net income
        result.EnvelopesTotal.Should().Be(2000m);
        result.JarsTotal.Should().Be(500m);

        var pocket = StepTotal(result, AllocationRuleType.FixedPerMember); // 0 here
        var sharedSpending = result.EnvelopesTotal + result.JarsTotal + pocket;
        var toSavings = StepTotal(result, AllocationRuleType.SplitRemainderToMembers);

        sharedSpending.Should().Be(2500m); // envelopes + jars + pocket
        toSavings.Should().Be(2500m);      // the terminal step total

        // The two hero tiles always reconcile to the pool, to the cent.
        (sharedSpending + toSavings).Should().Be(result.Pool);
    }

    // ALLOC-031 — an over-committed month: Shared spending exceeds the pool, To savings goes
    // negative, yet the two tiles still reconcile; remainder <= 0 hands each member their own
    // (possibly negative) keep-own leftover.
    [Fact]
    public async Task Preview_OverCommittedMonth_NegativeToSavings_StillReconciles()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub(Owner);
        SeedMember(db, "Alex", 3000m, 0, null);
        SeedMember(db, "Robin", 2000m, 1, null);
        SeedBudget(db, 2026, 7, envelopes: 4000m, funds: 1500m); // shared spending 5500 > pool 5000
        await Upsert(db, user, StandardRules());

        var result = await Preview(db, user, 2026, 7);

        result.Pool.Should().Be(5000m);
        var pocket = StepTotal(result, AllocationRuleType.FixedPerMember);
        var sharedSpending = result.EnvelopesTotal + result.JarsTotal + pocket;
        var toSavings = StepTotal(result, AllocationRuleType.SplitRemainderToMembers);

        sharedSpending.Should().Be(5500m);
        toSavings.Should().Be(-500m);
        (sharedSpending + toSavings).Should().Be(result.Pool); // still reconciles

        // Keep-own: each keeps their own leftover; Robin's income can't cover his equal share.
        result.Members.Single(m => m.Name == "Alex").Residual.Should().Be(250m);
        result.Members.Single(m => m.Name == "Robin").Residual.Should().Be(-750m);
        result.Members.Sum(m => m.Residual).Should().Be(-500m);
    }

    // ALLOC-038 — "Split shared costs: By income" charges each member in proportion to net income;
    // the step totals are unchanged (the split only redistributes who pays), and each split sums
    // exactly with the last member absorbing any rounding remainder.
    [Fact]
    public async Task Preview_ByIncomeCostSplit_ChargesInProportionToIncome()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub(Owner);
        SeedMember(db, "Alex", 3000m, 0, null); // 60% of the 5000 pool
        SeedMember(db, "Robin", 2000m, 1, null); // 40%
        SeedBudget(db, 2026, 7, envelopes: 2000m, funds: 500m);
        await Upsert(db, user, StandardRules(costSplit: SplitMethod.ByIncomeRatio));

        var result = await Preview(db, user, 2026, 7);

        var env = result.Steps.Single(s => s.Type == AllocationRuleType.FundEnvelopes);
        env.Total.Should().Be(2000m); // total unchanged
        env.PerMember.Single(p => p.Name == "Alex").Amount.Should().Be(1200m); // 2000 * 3000/5000
        env.PerMember.Single(p => p.Name == "Robin").Amount.Should().Be(800m);

        var jars = result.Steps.Single(s => s.Type == AllocationRuleType.FundJars);
        jars.Total.Should().Be(500m);
        jars.PerMember.Single(p => p.Name == "Alex").Amount.Should().Be(300m); // 500 * 0.6
        jars.PerMember.Single(p => p.Name == "Robin").Amount.Should().Be(200m);

        // Combined shared-cost charge per member: Alex 1500, Robin 1000 (Round2(2500 * ratio)).
        (env.PerMember.Single(p => p.Name == "Alex").Amount + jars.PerMember.Single(p => p.Name == "Alex").Amount)
            .Should().Be(1500m);
        (env.PerMember.Single(p => p.Name == "Robin").Amount + jars.PerMember.Single(p => p.Name == "Robin").Amount)
            .Should().Be(1000m);
    }

    // ALLOC-042 — the highest-value regression: a brand-new couple with equal (zero) savings
    // balances used to throw OverflowException in WaterFill's top tier, 500-ing BOTH preview and
    // commit. Both must now succeed and split the surplus evenly.
    [Fact]
    public async Task EqualBalanceCouple_PreviewAndCommit_DoNotOverflow_AndSplitEvenly()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub(Owner);
        var source = SeedAccount(db, "Joint");
        var chrisSavings = SeedAccount(db, "Alex Savings", opening: 0m);
        var robinSavings = SeedAccount(db, "Robin Savings", opening: 0m);
        SeedMember(db, "Alex", 3000m, 0, chrisSavings.Id);
        SeedMember(db, "Robin", 2000m, 1, robinSavings.Id);
        SeedBudget(db, 2026, 7, envelopes: 2000m, funds: 500m); // remainder 2500
        await Upsert(db, user, StandardRules(savingsSplit: SplitMethod.BalanceTilt), source.Id, lean: 25);

        // Preview: equal (zero) balances degenerate the tilt to an even split — no overflow.
        var preview = await Preview(db, user, 2026, 7);
        preview.Members.Sum(m => m.Residual).Should().Be(2500m);
        preview.Members.Should().OnlyContain(m => m.Residual == 1250m);

        // Commit: same path, also no overflow; two even savings transfers.
        var commit = await Commit(db, user, 2026, 7);
        commit.TransfersCreated.Should().Be(2);
        var transfers = await db.Transactions.Where(t => t.Type == TransactionType.Transfer).ToListAsync();
        transfers.Should().HaveCount(2);
        transfers.Sum(t => t.Amount).Should().Be(2500m);
        transfers.Should().OnlyContain(t => t.Amount == 1250m);
    }

    // ALLOC-047 — the savings balances that feed the balance tilt must EXCLUDE this month's own
    // allocation transfers (BankReference prefix "alloc:{year}-{month}:") so preview == a re-commit
    // view; ordinary (non-alloc) transfers still count.
    [Fact]
    public async Task Preview_SavingsBalanceForTilt_ExcludesThisMonthsAllocationTransfers()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub(Owner);
        var chrisSavings = SeedAccount(db, "Alex Savings", opening: 1000m);
        var robinSavings = SeedAccount(db, "Robin Savings", opening: 500m);
        SeedMember(db, "Alex", 3000m, 0, chrisSavings.Id);
        SeedMember(db, "Robin", 2000m, 1, robinSavings.Id);
        SeedBudget(db, 2026, 7, envelopes: 2000m, funds: 500m);

        // This month's own allocation transfer INTO Alex's savings — must be excluded from the tilt.
        SeedTransferInto(db, chrisSavings.Id, amount: 500m, bankRef: "alloc:2026-7:someone");
        // An ordinary transfer INTO Alex's savings — must be included.
        SeedTransferInto(db, chrisSavings.Id, amount: 200m, bankRef: null);

        await Upsert(db, user, StandardRules(savingsSplit: SplitMethod.BalanceTilt));

        var result = await Preview(db, user, 2026, 7);

        // 1000 opening + 200 ordinary transfer; the 500 alloc transfer is filtered out.
        result.Members.Single(m => m.Name == "Alex").SavingsBalance.Should().Be(1200m);
        result.Members.Single(m => m.Name == "Robin").SavingsBalance.Should().Be(500m);
    }

    // ALLOC-051 — when no member has both a positive residual and a savings account, the commit
    // writes zero transfers (the singular "no savings transfers needed" case) and touches nothing.
    [Fact]
    public async Task Commit_WhenNothingLeftToSave_CreatesZeroTransfers()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub(Owner);
        var source = SeedAccount(db, "Joint");
        var chrisSavings = SeedAccount(db, "Alex Savings");
        var robinSavings = SeedAccount(db, "Robin Savings");
        SeedMember(db, "Alex", 3000m, 0, chrisSavings.Id);
        SeedMember(db, "Robin", 2000m, 1, robinSavings.Id);
        SeedBudget(db, 2026, 7, envelopes: 6000m, funds: 0m); // equal share 3000 each, exhausts the pool
        await Upsert(db, user, StandardRules(), source.Id);

        var result = await Commit(db, user, 2026, 7);

        result.TransfersCreated.Should().Be(0);
        (await db.Transactions.CountAsync(t => t.Type == TransactionType.Transfer)).Should().Be(0);
    }

    // ALLOC-054 — a member whose PersonalSavingsAccountId points at a deleted/foreign account:
    // the planner nulls the dangling link (so no broken Transfer FK is written), the preview shows
    // no savings account, and the commit skips that member while the other's transfer still writes.
    [Fact]
    public async Task DanglingSavingsAccount_PreviewNullsLink_AndCommitSkipsThatMember()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub(Owner);
        var source = SeedAccount(db, "Joint");
        var chrisSavings = SeedAccount(db, "Alex Savings", opening: 0m);
        var ghostId = Guid.NewGuid(); // an account that no longer exists
        SeedMember(db, "Alex", 3000m, 0, chrisSavings.Id);
        SeedMember(db, "Robin", 2000m, 1, ghostId);
        SeedBudget(db, 2026, 7, envelopes: 2000m, funds: 500m); // remainder 2500 → 1250 each
        await Upsert(db, user, StandardRules(savingsSplit: SplitMethod.BalanceTilt), source.Id);

        var preview = await Preview(db, user, 2026, 7);
        var robin = preview.Members.Single(m => m.Name == "Robin");
        robin.SavingsAccountId.Should().BeNull();   // dangling link nulled
        robin.SavingsBalance.Should().Be(0m);
        robin.Residual.Should().Be(1250m);          // still allocated a positive share

        var commit = await Commit(db, user, 2026, 7);
        commit.TransfersCreated.Should().Be(1);     // only Alex
        var transfers = await db.Transactions.Where(t => t.Type == TransactionType.Transfer).ToListAsync();
        transfers.Should().ContainSingle(t => t.TransferAccountId == chrisSavings.Id && t.Amount == 1250m);
        transfers.Should().NotContain(t => t.TransferAccountId == ghostId);
    }

    // ALLOC-045, ALLOC-046, ALLOC-057 — commit transfers ONLY members with residual > 0 AND a
    // savings account. A mixed household: one qualifies, one has a zero residual, one negative,
    // one has a positive residual but no savings account — exactly one transfer is written.
    [Fact]
    public async Task Commit_TransfersOnlyMembers_WithPositiveResidual_AndASavingsAccount()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub(Owner);
        var source = SeedAccount(db, "Joint");
        var aliceSavings = SeedAccount(db, "Alice Savings");
        var bobSavings = SeedAccount(db, "Bob Savings");
        var caraSavings = SeedAccount(db, "Cara Savings");
        SeedMember(db, "Alice", 2200m, 0, aliceSavings.Id); // residual +1200, has account → transfers
        SeedMember(db, "Bob", 1000m, 1, bobSavings.Id);     // residual  0     → skipped (not > 0)
        SeedMember(db, "Cara", 950m, 2, caraSavings.Id);    // residual  -50   → skipped (<= 0)
        SeedMember(db, "Dan", 1900m, 3, null);              // residual +900, no account → stranded/skipped
        SeedBudget(db, 2026, 7, envelopes: 4000m, funds: 0m); // equal share 1000 each

        // A single FundEnvelopes rule (no terminal pooling) so residuals are deterministic keep-own.
        await Upsert(db, user, new List<AllocationRuleSpec>
        {
            new(0, AllocationRuleType.FundEnvelopes, SplitMethod.Equal, 0m),
        }, source.Id);

        var preview = await Preview(db, user, 2026, 7);
        preview.Members.Single(m => m.Name == "Alice").Residual.Should().Be(1200m);
        preview.Members.Single(m => m.Name == "Bob").Residual.Should().Be(0m);
        preview.Members.Single(m => m.Name == "Cara").Residual.Should().Be(-50m);
        var dan = preview.Members.Single(m => m.Name == "Dan");
        dan.Residual.Should().Be(900m);
        dan.SavingsAccountId.Should().BeNull(); // no savings account → note + stranded on commit

        var commit = await Commit(db, user, 2026, 7);
        commit.TransfersCreated.Should().Be(1);
        var transfers = await db.Transactions.Where(t => t.Type == TransactionType.Transfer).ToListAsync();
        transfers.Should().ContainSingle();
        var only = transfers.Single();
        only.TransferAccountId.Should().Be(aliceSavings.Id);
        only.Amount.Should().Be(1200m);
    }

    // ALLOC-058, ALLOC-060 — the written transfer's composition, and that a solo (1-member)
    // household commits server-side (the "add people first" gate is client-only). For a GBP
    // budget both accounts and the transfer must be GBP. The idempotency key's month is NOT
    // zero-padded ("alloc:2026-7:", not "2026-07").
    [Fact]
    public async Task SoloCommit_WritesOneTransfer_InTheAccountsCurrency_AndNonPaddedReference()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub(Owner);
        var gbp = CurrencyCode.From("GBP");
        var source = SeedAccount(db, "Joint", currency: gbp);
        var chrisSavings = SeedAccount(db, "Alex Savings", currency: gbp);
        var alex = SeedMember(db, "Alex", 3000m, 0, chrisSavings.Id);
        SeedBudget(db, 2026, 7, envelopes: 2000m, funds: 0m, currency: gbp); // remainder 1000
        await Upsert(db, user, StandardRules(savingsSplit: SplitMethod.Equal), source.Id);

        var result = await Commit(db, user, 2026, 7);
        result.TransfersCreated.Should().Be(1); // solo household commit allowed server-side

        var transfer = (await db.Transactions.Where(t => t.Type == TransactionType.Transfer).ToListAsync()).Single();
        transfer.Date.Should().Be(new DateOnly(2026, 7, 1));
        transfer.Payee.Should().Be("Income allocation — Alex");
        transfer.Amount.Should().Be(1000m);
        transfer.Currency.Should().Be(gbp); // the source/savings currency, not a hardcoded EUR
        transfer.ExchangeRate.Should().Be(1m);
        transfer.AccountId.Should().Be(source.Id);
        transfer.TransferAccountId.Should().Be(chrisSavings.Id);
        transfer.BankReference.Should().Be($"alloc:2026-7:{alex.Id}");
        transfer.BankReference.Should().NotContain("2026-07"); // month not zero-padded
    }

    // A member's savings account in a different currency than the source is rejected — an allocation
    // transfer, like any transfer, must stay in one currency (previously it was silently stamped EUR).
    [Fact]
    public async Task Commit_WithASavingsAccountInADifferentCurrency_IsRejected()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub(Owner);
        var gbp = CurrencyCode.From("GBP");
        var source = SeedAccount(db, "Joint", currency: gbp);
        var eurSavings = SeedAccount(db, "Alex Savings", currency: CurrencyCode.Eur); // mismatched
        var alex = SeedMember(db, "Alex", 3000m, 0, eurSavings.Id);
        SeedBudget(db, 2026, 7, envelopes: 2000m, funds: 0m, currency: gbp);
        await Upsert(db, user, StandardRules(savingsSplit: SplitMethod.Equal), source.Id);

        Func<Task> act = () => Commit(db, user, 2026, 7);

        var ex = (await act.Should().ThrowAsync<ValidationException>()).Which;
        ex.Errors.Should().ContainKey("Allocation");
        (await db.Transactions.CountAsync(t => t.Type == TransactionType.Transfer)).Should().Be(0);
    }

    [Fact]
    public async Task Commit_WhenBothAccountsUseADifferentCurrencyThanTheBudget_PreservesPriorTransfers()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub(Owner);
        var gbp = CurrencyCode.From("GBP");
        var source = SeedAccount(db, "Joint", currency: gbp);
        var savings = SeedAccount(db, "Savings", currency: gbp);
        var member = SeedMember(db, "Alex", 3000m, 0, savings.Id);
        SeedBudget(db, 2026, 6, 2000m, 0m, currency: gbp);
        SeedBudget(db, 2026, 7, 2000m, 0m, currency: CurrencyCode.Eur);
        await Upsert(db, user, StandardRules(savingsSplit: SplitMethod.Equal), source.Id);
        var prior = new Transaction
        {
            OwnerId = Owner, Type = TransactionType.Transfer, Date = new DateOnly(2026, 7, 1),
            Amount = 75m, Currency = gbp, AccountId = source.Id, TransferAccountId = savings.Id,
            BankReference = $"alloc:2026-7:{member.Id}", Payee = "Existing allocation",
        };
        db.Transactions.Add(prior);
        await db.SaveChangesAsync();

        Func<Task> act = () => Commit(db, user, 2026, 7);

        var ex = (await act.Should().ThrowAsync<ValidationException>()).Which;
        ex.Errors.Should().ContainKey("SourceAccountId");
        ex.Errors["SourceAccountId"].Single().Should().Contain("GBP").And.Contain("EUR");
        db.Entry(prior).State.Should().Be(EntityState.Unchanged);
        var remaining = await db.Transactions.AsNoTracking().SingleAsync();
        remaining.Id.Should().Be(prior.Id);
        remaining.Amount.Should().Be(75m);
    }

    [Fact]
    public async Task Commit_WithoutAnOwnedBudget_CannotInferItsCurrency()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub(Owner);
        var source = SeedAccount(db, "Joint");
        var savings = SeedAccount(db, "Savings");
        SeedMember(db, "Alex", 3000m, 0, savings.Id);
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "another-household", Year = 2026, Month = 7, BaseCurrency = CurrencyCode.Eur,
        });
        await db.SaveChangesAsync();
        await Upsert(db, user, StandardRules(savingsSplit: SplitMethod.Equal), source.Id);

        Func<Task> act = () => Commit(db, user, 2026, 7);

        await act.Should().ThrowAsync<NotFoundException>();
        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    // ALLOC-049, ALLOC-053 — committing a profile with no source account is a 400 ValidationException
    // keyed on SourceAccountId, before any transaction is written.
    [Fact]
    public async Task Commit_WithProfileButNoSourceAccount_ThrowsValidationException()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub(Owner);
        SeedMember(db, "Alex", 3000m, 0, null);
        SeedBudget(db, 2026, 7, envelopes: 2000m, funds: 500m);
        await Upsert(db, user, StandardRules(), source: null);

        Func<Task> act = () => Commit(db, user, 2026, 7);

        var ex = (await act.Should().ThrowAsync<ValidationException>()).Which;
        ex.Errors.Should().ContainKey("SourceAccountId");
        ex.Errors["SourceAccountId"].Should().Contain("Set a source account on the allocation profile before committing.");
        (await db.Transactions.CountAsync(t => t.Type == TransactionType.Transfer)).Should().Be(0);
    }

    // ALLOC-059 — committing with no allocation profile is a 404 NotFoundException.
    [Fact]
    public async Task Commit_WithNoProfile_ThrowsNotFound()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub(Owner);
        SeedAccount(db, "Joint");
        SeedMember(db, "Alex", 3000m, 0, null);
        SeedBudget(db, 2026, 7, envelopes: 2000m, funds: 500m);

        Func<Task> act = () => Commit(db, user, 2026, 7);

        var ex = (await act.Should().ThrowAsync<NotFoundException>()).Which;
        ex.Message.Should().Be("There is no allocation profile to run.");
    }

    // ALLOC-062 — the zero-member edge: pool 0, empty splits, no divide-by-zero / 500.
    [Fact]
    public async Task Preview_NoMembers_PoolZero_EmptyMembers_NoThrow()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub(Owner);
        SeedBudget(db, 2026, 7, envelopes: 1000m, funds: 500m); // obligations exist, but no one to charge
        await Upsert(db, user, StandardRules());

        var result = await Preview(db, user, 2026, 7);

        result.Pool.Should().Be(0m);
        result.Members.Should().BeEmpty();
    }

    // ALLOC-062 — the zero-income edge: pool 0, obligations push balances negative (keep-own),
    // no divide-by-zero even with the BalanceTilt terminal rule present.
    [Fact]
    public async Task Preview_AllZeroIncomeMembers_PoolZero_KeepOwnNegatives_NoThrow()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub(Owner);
        SeedMember(db, "Alex", 0m, 0, null);
        SeedMember(db, "Robin", 0m, 1, null);
        SeedBudget(db, 2026, 7, envelopes: 1000m, funds: 500m); // 750 charged to each, nothing to pay it
        await Upsert(db, user, StandardRules(savingsSplit: SplitMethod.BalanceTilt));

        var result = await Preview(db, user, 2026, 7);

        result.Pool.Should().Be(0m);
        result.Members.Should().OnlyContain(m => m.Residual == -750m);
        result.Members.Sum(m => m.Residual).Should().Be(-1500m);
    }
}

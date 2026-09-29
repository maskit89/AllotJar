using FluentAssertions;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Tests.Domain;

/// <summary>
/// The income-allocation waterfall, validated against a hand-computed worked example
/// (synthetic figures: two members earning 4200.50 / 3800.25 against shared obligations
/// of 3500 + 2000 + 250-per-member, leaving a 2000.75 remainder).
/// </summary>
public class IncomeAllocatorTests
{
    private static readonly Guid Alex = Guid.NewGuid();
    private static readonly Guid Sam = Guid.NewGuid();

    private static List<AllocationMember> Couple() => new()
    {
        new(Alex, "Alex", 4200.50m, null),
        new(Sam, "Sam", 3800.25m, null),
    };

    // The three shared obligations funded before the terminal savings split, reused across tests.
    private static List<AllocationRuleInput> Obligations() => new()
    {
        new(0, AllocationRuleType.FundEnvelopes, SplitMethod.Equal, 0m, ResolvedTotal: 3500m),
        new(1, AllocationRuleType.FundJars, SplitMethod.Equal, 0m, ResolvedTotal: 2000m),
        new(2, AllocationRuleType.FixedPerMember, SplitMethod.Equal, FixedAmountPerMember: 250m, ResolvedTotal: 0m),
    };

    [Fact]
    public void Reproduces_TheWorkedExample_Waterfall()
    {
        // No terminal split rule → each member keeps their own post-obligation leftover — the
        // keep-your-own model (a terminal split would instead pool this 2000.75 remainder).
        var result = IncomeAllocator.Compute(Couple(), Obligations());

        result.Pool.Should().Be(8000.75m);
        result.Members.Single(m => m.MemberId == Alex).Residual.Should().Be(1200.50m);
        result.Members.Single(m => m.MemberId == Sam).Residual.Should().Be(800.25m);

        // The leftover equals the pool minus the funded obligations (3500 + 2000 + 500).
        result.Members.Sum(m => m.Residual).Should().Be(8000.75m - 3500m - 2000m - 500m);
    }

    [Fact]
    public void SplitRemainderToMembers_Equally_PoolsAndSplitsEvenly()
    {
        // "Send savings to: Equally" now pools the 2000.75 remainder and splits it evenly, instead of
        // silently letting each member keep their own (1200.50 / 800.25).
        var rules = Obligations();
        rules.Add(new(3, AllocationRuleType.SplitRemainderToMembers, SplitMethod.Equal, 0m, 0m));

        var result = IncomeAllocator.Compute(Couple(), rules);

        result.Members.Sum(m => m.Residual).Should().Be(2000.75m); // conserved to the cent
        var alex = result.Members.Single(m => m.MemberId == Alex).Residual;
        var sam = result.Members.Single(m => m.MemberId == Sam).Residual;
        alex.Should().Be(1000.38m); // tied fractional shares: first in display order gets the odd cent
        sam.Should().Be(1000.37m);
    }

    [Fact]
    public void SplitRemainderToMembers_ByIncome_PoolsAndSplitsByIncome()
    {
        // "Send savings to: By income" pools the remainder and splits it in proportion to income —
        // distinct from both Equal and keep-own; Alex earns more so he saves more.
        var rules = Obligations();
        rules.Add(new(3, AllocationRuleType.SplitRemainderToMembers, SplitMethod.ByIncomeRatio, 0m, 0m));

        var result = IncomeAllocator.Compute(Couple(), rules);

        result.Members.Sum(m => m.Residual).Should().Be(2000.75m);
        var alex = result.Members.Single(m => m.MemberId == Alex).Residual;
        var sam = result.Members.Single(m => m.MemberId == Sam).Residual;
        alex.Should().BeGreaterThan(sam); // 4200.50 vs 3800.25 income
        alex.Should().BeGreaterThan(1000.38m); // and more than an even split
    }

    [Fact]
    public void BalanceTilt_DoesNotOverflow_ForEqualOrZeroBalances()
    {
        // Regression: a brand-new couple has equal (zero) savings balances. WaterFill used to form
        // `n * decimal.MaxValue` at the top tier and throw OverflowException, 500-ing preview/commit.
        var members = new List<AllocationMember>
        {
            new(Alex, "Alex", 4200.50m, null, SavingsBalance: 0m),
            new(Sam, "Sam", 3800.25m, null, SavingsBalance: 0m),
        };
        var rules = Obligations();
        rules.Add(new(3, AllocationRuleType.SplitRemainderToMembers, SplitMethod.BalanceTilt, 0m, 0m));

        var act = () => IncomeAllocator.Compute(members, rules, balanceLeanPercent: 25);

        var result = act.Should().NotThrow().Subject;
        // Equal starting balances → the balance-aware split degenerates to an even split; the odd
        // cent lands on one member (whichever absorbs the rounding drift), so assert the invariants.
        result.Members.Sum(m => m.Residual).Should().Be(2000.75m);
        result.Members.Should().OnlyContain(m => m.Residual == 1000.37m || m.Residual == 1000.38m);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(25)]
    [InlineData(100)]
    public void BalanceTilt_NeverOverflows_AcrossLeanSettings(int lean)
    {
        // Three members, equal balances (the overflow trigger), across the lean range.
        var third = Guid.NewGuid();
        var members = new List<AllocationMember>
        {
            new(Alex, "Alex", 3000m, null, SavingsBalance: 500m),
            new(Sam, "Sam", 3000m, null, SavingsBalance: 500m),
            new(third, "Riley", 3000m, null, SavingsBalance: 500m),
        };
        var rules = new List<AllocationRuleInput>
        {
            new(0, AllocationRuleType.SplitRemainderToMembers, SplitMethod.BalanceTilt, 0m, 0m),
        };

        var act = () => IncomeAllocator.Compute(members, rules, balanceLeanPercent: lean);

        var result = act.Should().NotThrow().Subject;
        result.Members.Sum(m => m.Residual).Should().Be(9000m); // full pool conserved
    }

    [Fact]
    public void Equal_Split_SumsExactly_EvenWithOddCents()
    {
        var rules = new List<AllocationRuleInput>
        {
            new(0, AllocationRuleType.FundEnvelopes, SplitMethod.Equal, 0m, ResolvedTotal: 100.01m),
            new(1, AllocationRuleType.SplitRemainderToMembers, SplitMethod.Equal, 0m, 0m),
        };

        var step = IncomeAllocator.Compute(Couple(), rules).Steps.First();

        step.PerMember.Sum(s => s.Amount).Should().Be(100.01m); // 50.00 + 50.01
        step.PerMember.Select(s => s.Amount).Should().Contain(new[] { 50.00m, 50.01m });
    }

    [Fact]
    public void BalanceTilt_LeansSavingsTowardTheLowerBalance_ButBothStillSave()
    {
        // Alex earns more but has the lower savings balance; Sam is ahead by ~10.4k.
        var members = new List<AllocationMember>
        {
            new(Alex, "Alex", 4200.50m, null, SavingsBalance: 30000m),
            new(Sam, "Sam", 3800.25m, null, SavingsBalance: 40000m),
        };
        var rules = new List<AllocationRuleInput>
        {
            new(0, AllocationRuleType.FundEnvelopes, SplitMethod.Equal, 0m, ResolvedTotal: 3500m),
            new(1, AllocationRuleType.FundJars, SplitMethod.Equal, 0m, ResolvedTotal: 2000m),
            new(2, AllocationRuleType.FixedPerMember, SplitMethod.Equal, FixedAmountPerMember: 250m, ResolvedTotal: 0m),
            new(3, AllocationRuleType.SplitRemainderToMembers, SplitMethod.BalanceTilt, 0m, 0m),
        };

        var result = IncomeAllocator.Compute(members, rules, balanceLeanPercent: 25);
        var alex = result.Members.Single(m => m.MemberId == Alex);
        var sam = result.Members.Single(m => m.MemberId == Sam);

        // The whole 2000.75 remainder is preserved, just tilted toward Alex (the lower balance).
        (alex.Residual + sam.Residual).Should().Be(2000.75m);
        alex.Residual.Should().Be(1250.47m);
        sam.Residual.Should().Be(750.28m);

        // Gentle: both still save, and the gap between the two balances narrows.
        sam.Residual.Should().BeGreaterThan(0m);
        alex.Residual.Should().BeGreaterThan(sam.Residual);
        (alex.SavingsBalance + alex.Residual).Should().BeLessThan(sam.SavingsBalance + sam.Residual);
    }

    [Fact]
    public void BalanceTilt_AtFullLean_PoursEverythingIntoTheLowerAccount()
    {
        var members = new List<AllocationMember>
        {
            new(Alex, "Alex", 4200.50m, null, SavingsBalance: 30000m),
            new(Sam, "Sam", 3800.25m, null, SavingsBalance: 40000m),
        };
        var rules = new List<AllocationRuleInput>
        {
            new(0, AllocationRuleType.FundEnvelopes, SplitMethod.Equal, 0m, ResolvedTotal: 3500m),
            new(1, AllocationRuleType.FundJars, SplitMethod.Equal, 0m, ResolvedTotal: 2000m),
            new(2, AllocationRuleType.FixedPerMember, SplitMethod.Equal, FixedAmountPerMember: 250m, ResolvedTotal: 0m),
            new(3, AllocationRuleType.SplitRemainderToMembers, SplitMethod.BalanceTilt, 0m, 0m),
        };

        var result = IncomeAllocator.Compute(members, rules, balanceLeanPercent: 100);

        // The ~10.4k gap dwarfs the remainder, so at full lean Alex takes all of it.
        result.Members.Single(m => m.MemberId == Alex).Residual.Should().Be(2000.75m);
        result.Members.Single(m => m.MemberId == Sam).Residual.Should().Be(0m);
    }

    [Fact]
    public void ByIncomeRatio_Split_SumsExactly_ToTheTotal()
    {
        var rules = new List<AllocationRuleInput>
        {
            new(0, AllocationRuleType.FundEnvelopes, SplitMethod.ByIncomeRatio, 0m, ResolvedTotal: 1000m),
            new(1, AllocationRuleType.SplitRemainderToMembers, SplitMethod.Equal, 0m, 0m),
        };

        var step = IncomeAllocator.Compute(Couple(), rules).Steps.First();

        step.PerMember.Sum(s => s.Amount).Should().Be(1000m);
        // Alex earns more, so he covers more of the shared cost.
        step.PerMember.Single(s => s.MemberId == Alex).Amount
            .Should().BeGreaterThan(step.PerMember.Single(s => s.MemberId == Sam).Amount);
    }

    [Fact]
    public void Equal_TinyPool_DistributesAvailableCentsInDisplayedOrder()
    {
        var members = Enumerable.Range(0, 4)
            .Select(i => new AllocationMember(Guid.NewGuid(), $"Person {i}", 1m, null)).ToList();
        var rule = new AllocationRuleInput(0, AllocationRuleType.FundEnvelopes, SplitMethod.Equal, 0m, 0.02m);

        var step = IncomeAllocator.Compute(members, new[] { rule }).Steps.Single();

        step.PerMember.Select(s => s.MemberId).Should().Equal(members.Select(m => m.Id));
        step.PerMember.Select(s => s.Amount).Should().Equal(0.01m, 0.01m, 0m, 0m);
        step.PerMember.Sum(s => s.Amount).Should().Be(0.02m);
    }

    [Theory]
    [InlineData(SplitMethod.Equal, 0)]
    [InlineData(SplitMethod.ByIncomeRatio, 0)]
    [InlineData(SplitMethod.BalanceTilt, 0)]
    [InlineData(SplitMethod.BalanceTilt, 25)]
    [InlineData(SplitMethod.BalanceTilt, 100)]
    public void SmallRemainder_NeverCreatesNegativeSharesOrExtraMoney(SplitMethod method, int lean)
    {
        var members = Enumerable.Range(0, 4)
            .Select(i => new AllocationMember(Guid.NewGuid(), $"Person {i}", 0.01m, null)).ToList();
        var rules = new[]
        {
            new AllocationRuleInput(0, AllocationRuleType.FundEnvelopes, SplitMethod.Equal, 0m, 0.02m),
            new AllocationRuleInput(1, AllocationRuleType.SplitRemainderToMembers, method, 0m, 0m),
        };

        var result = IncomeAllocator.Compute(members, rules, lean);

        result.Members.Should().OnlyContain(m => m.Residual >= 0m);
        result.Members.Sum(m => m.Residual).Should().Be(0.02m);
        // The commit writes positive residuals only: these must not exceed the pool.
        result.Members.Where(m => m.Residual > 0m).Sum(m => m.Residual).Should().Be(0.02m);
    }

    [Fact]
    public void IncomeSplit_LargestFractionGetsTheCent_EvenWhenListedLater()
    {
        var members = new[]
        {
            new AllocationMember(Alex, "Alex", 4m, null),
            new AllocationMember(Sam, "Sam", 6m, null),
        };
        var rule = new AllocationRuleInput(0, AllocationRuleType.FundEnvelopes, SplitMethod.ByIncomeRatio, 0m, 0.01m);

        var step = IncomeAllocator.Compute(members, new[] { rule }).Steps.Single();

        step.PerMember.Select(s => s.Amount).Should().Equal(0m, 0.01m);
    }

    [Theory]
    [InlineData(0.0201)]
    [InlineData(0.0001)]
    [InlineData(100.0001)]
    public void EqualSplit_PreservesExistingStoredPrecision(decimal total)
    {
        var members = Enumerable.Range(0, 4)
            .Select(i => new AllocationMember(Guid.NewGuid(), $"Person {i}", 1m, null)).ToList();
        var rule = new AllocationRuleInput(0, AllocationRuleType.FundEnvelopes, SplitMethod.Equal, 0m, total);

        var step = IncomeAllocator.Compute(members, new[] { rule }).Steps.Single();

        step.PerMember.Should().OnlyContain(s => s.Amount >= 0m);
        step.PerMember.Sum(s => s.Amount).Should().Be(total);
    }
}

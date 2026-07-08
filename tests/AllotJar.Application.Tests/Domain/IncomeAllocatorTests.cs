using FluentAssertions;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;
using Xunit;

namespace AllotJar.Application.Tests.Domain;

/// <summary>
/// The income-allocation waterfall, validated against the source spreadsheet's
/// Future Savings figures.
/// </summary>
public class IncomeAllocatorTests
{
    private static readonly Guid Chris = Guid.NewGuid();
    private static readonly Guid Liza = Guid.NewGuid();

    private static List<AllocationMember> Couple() => new()
    {
        new(Chris, "Chris", 4411.64m, null),
        new(Liza, "Liza", 3999.97m, null),
    };

    // The three shared obligations funded before the terminal savings split, reused across tests.
    private static List<AllocationRuleInput> Obligations() => new()
    {
        new(0, AllocationRuleType.FundEnvelopes, SplitMethod.Equal, 0m, ResolvedTotal: 3641m),
        new(1, AllocationRuleType.FundJars, SplitMethod.Equal, 0m, ResolvedTotal: 2164m),
        new(2, AllocationRuleType.FixedPerMember, SplitMethod.Equal, FixedAmountPerMember: 250m, ResolvedTotal: 0m),
    };

    [Fact]
    public void Reproduces_TheSpreadsheet_Waterfall()
    {
        // No terminal split rule → each member keeps their own post-obligation leftover, which is the
        // source spreadsheet's model (a terminal split would instead pool this 2106.61 remainder).
        var result = IncomeAllocator.Compute(Couple(), Obligations());

        result.Pool.Should().Be(8411.61m);
        result.Members.Single(m => m.MemberId == Chris).Residual.Should().Be(1259.14m);
        result.Members.Single(m => m.MemberId == Liza).Residual.Should().Be(847.47m);

        // The leftover equals the pool minus the funded obligations (3641 + 2164 + 500).
        result.Members.Sum(m => m.Residual).Should().Be(8411.61m - 3641m - 2164m - 500m);
    }

    [Fact]
    public void SplitRemainderToMembers_Equally_PoolsAndSplitsEvenly()
    {
        // "Send savings to: Equally" now pools the 2106.61 remainder and splits it evenly, instead of
        // silently letting each member keep their own (1259.14 / 847.47).
        var rules = Obligations();
        rules.Add(new(3, AllocationRuleType.SplitRemainderToMembers, SplitMethod.Equal, 0m, 0m));

        var result = IncomeAllocator.Compute(Couple(), rules);

        result.Members.Sum(m => m.Residual).Should().Be(2106.61m); // conserved to the cent
        var chris = result.Members.Single(m => m.MemberId == Chris).Residual;
        var liza = result.Members.Single(m => m.MemberId == Liza).Residual;
        chris.Should().Be(1053.31m); // 2106.61 / 2, last member absorbs the odd cent
        liza.Should().Be(1053.30m);
    }

    [Fact]
    public void SplitRemainderToMembers_ByIncome_PoolsAndSplitsByIncome()
    {
        // "Send savings to: By income" pools the remainder and splits it in proportion to income —
        // distinct from both Equal and keep-own; Chris earns more so he saves more.
        var rules = Obligations();
        rules.Add(new(3, AllocationRuleType.SplitRemainderToMembers, SplitMethod.ByIncomeRatio, 0m, 0m));

        var result = IncomeAllocator.Compute(Couple(), rules);

        result.Members.Sum(m => m.Residual).Should().Be(2106.61m);
        var chris = result.Members.Single(m => m.MemberId == Chris).Residual;
        var liza = result.Members.Single(m => m.MemberId == Liza).Residual;
        chris.Should().BeGreaterThan(liza); // 4411.64 vs 3999.97 income
        chris.Should().BeGreaterThan(1053.31m); // and more than an even split
    }

    [Fact]
    public void BalanceTilt_DoesNotOverflow_ForEqualOrZeroBalances()
    {
        // Regression: a brand-new couple has equal (zero) savings balances. WaterFill used to form
        // `n * decimal.MaxValue` at the top tier and throw OverflowException, 500-ing preview/commit.
        var members = new List<AllocationMember>
        {
            new(Chris, "Chris", 4411.64m, null, SavingsBalance: 0m),
            new(Liza, "Liza", 3999.97m, null, SavingsBalance: 0m),
        };
        var rules = Obligations();
        rules.Add(new(3, AllocationRuleType.SplitRemainderToMembers, SplitMethod.BalanceTilt, 0m, 0m));

        var act = () => IncomeAllocator.Compute(members, rules, balanceLeanPercent: 25);

        var result = act.Should().NotThrow().Subject;
        // Equal starting balances → the balance-aware split degenerates to an even split; the odd
        // cent lands on one member (whichever absorbs the rounding drift), so assert the invariants.
        result.Members.Sum(m => m.Residual).Should().Be(2106.61m);
        result.Members.Should().OnlyContain(m => m.Residual == 1053.30m || m.Residual == 1053.31m);
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
            new(Chris, "Chris", 3000m, null, SavingsBalance: 500m),
            new(Liza, "Liza", 3000m, null, SavingsBalance: 500m),
            new(third, "Sam", 3000m, null, SavingsBalance: 500m),
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
        // Chris earns more but has the lower savings balance; Liza is ahead by ~10.4k.
        var members = new List<AllocationMember>
        {
            new(Chris, "Chris", 4411.64m, null, SavingsBalance: 35631.96m),
            new(Liza, "Liza", 3999.97m, null, SavingsBalance: 46033.38m),
        };
        var rules = new List<AllocationRuleInput>
        {
            new(0, AllocationRuleType.FundEnvelopes, SplitMethod.Equal, 0m, ResolvedTotal: 3641m),
            new(1, AllocationRuleType.FundJars, SplitMethod.Equal, 0m, ResolvedTotal: 2164m),
            new(2, AllocationRuleType.FixedPerMember, SplitMethod.Equal, FixedAmountPerMember: 250m, ResolvedTotal: 0m),
            new(3, AllocationRuleType.SplitRemainderToMembers, SplitMethod.BalanceTilt, 0m, 0m),
        };

        var result = IncomeAllocator.Compute(members, rules, balanceLeanPercent: 25);
        var chris = result.Members.Single(m => m.MemberId == Chris);
        var liza = result.Members.Single(m => m.MemberId == Liza);

        // The whole 2106.61 remainder is preserved, just tilted toward Chris (the lower balance).
        (chris.Residual + liza.Residual).Should().Be(2106.61m);
        chris.Residual.Should().Be(1316.63m);
        liza.Residual.Should().Be(789.98m);

        // Gentle: both still save, and the gap between the two balances narrows.
        liza.Residual.Should().BeGreaterThan(0m);
        chris.Residual.Should().BeGreaterThan(liza.Residual);
        (chris.SavingsBalance + chris.Residual).Should().BeLessThan(liza.SavingsBalance + liza.Residual);
    }

    [Fact]
    public void BalanceTilt_AtFullLean_PoursEverythingIntoTheLowerAccount()
    {
        var members = new List<AllocationMember>
        {
            new(Chris, "Chris", 4411.64m, null, SavingsBalance: 35631.96m),
            new(Liza, "Liza", 3999.97m, null, SavingsBalance: 46033.38m),
        };
        var rules = new List<AllocationRuleInput>
        {
            new(0, AllocationRuleType.FundEnvelopes, SplitMethod.Equal, 0m, ResolvedTotal: 3641m),
            new(1, AllocationRuleType.FundJars, SplitMethod.Equal, 0m, ResolvedTotal: 2164m),
            new(2, AllocationRuleType.FixedPerMember, SplitMethod.Equal, FixedAmountPerMember: 250m, ResolvedTotal: 0m),
            new(3, AllocationRuleType.SplitRemainderToMembers, SplitMethod.BalanceTilt, 0m, 0m),
        };

        var result = IncomeAllocator.Compute(members, rules, balanceLeanPercent: 100);

        // The ~10.4k gap dwarfs the remainder, so at full lean Chris takes all of it.
        result.Members.Single(m => m.MemberId == Chris).Residual.Should().Be(2106.61m);
        result.Members.Single(m => m.MemberId == Liza).Residual.Should().Be(0m);
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
        // Chris earns more, so he covers more of the shared cost.
        step.PerMember.Single(s => s.MemberId == Chris).Amount
            .Should().BeGreaterThan(step.PerMember.Single(s => s.MemberId == Liza).Amount);
    }
}

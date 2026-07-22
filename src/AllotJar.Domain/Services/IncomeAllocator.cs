using AllotJar.Domain.Enums;

namespace AllotJar.Domain.Services;

/// <summary>
/// Pure (no I/O) income-allocation waterfall. Given each member's net income and an
/// ordered set of rules, it deducts each shared obligation from every member's running
/// balance and reports what each member is left with (their savings). Deterministic and
/// dependency-free, so it can be unit-tested directly against hand-computed fixtures
/// (see IncomeAllocatorTests' worked example).
///
/// Amounts for the fund-* rules are resolved by the caller (from the month's budget) and
/// passed in as <see cref="AllocationRuleInput.ResolvedTotal"/>, keeping this pure.
/// Equal/ratio splits round to the cent and give the last member the remainder so each
/// split sums exactly to its total.
///
/// The terminal <see cref="AllocationRuleType.SplitRemainderToMembers"/> step normally hands
/// each member whatever is left of their own income. With <see cref="SplitMethod.BalanceTilt"/>
/// it instead pools the remainder and tilts it toward whoever's savings balance
/// (<see cref="AllocationMember.SavingsBalance"/>) is lowest — a gentle blend between an even
/// split and a "fill the lowest first" target, weighted by <paramref name="balanceLeanPercent"/>.
/// </summary>
public static class IncomeAllocator
{
    public static AllocationResult Compute(
        IReadOnlyList<AllocationMember> members,
        IReadOnlyList<AllocationRuleInput> rules,
        int balanceLeanPercent = 25)
    {
        var pool = members.Sum(m => m.NetIncome);
        var totalNet = pool;
        var balances = members.ToDictionary(m => m.Id, m => m.NetIncome);
        var steps = new List<AllocationStep>();

        foreach (var rule in rules.OrderBy(r => r.Order))
        {
            switch (rule.Type)
            {
                case AllocationRuleType.FundEnvelopes:
                case AllocationRuleType.FundJars:
                {
                    var shares = Split(members, rule.ResolvedTotal, rule.Split, totalNet);
                    foreach (var s in shares)
                    {
                        balances[s.MemberId] -= s.Amount;
                    }

                    steps.Add(new AllocationStep(rule.Type, rule.ResolvedTotal, shares));
                    break;
                }

                case AllocationRuleType.FixedPerMember:
                {
                    var shares = members
                        .Select(m => new MemberShare(m.Id, m.Name, rule.FixedAmountPerMember))
                        .ToList();
                    foreach (var s in shares)
                    {
                        balances[s.MemberId] -= s.Amount;
                    }

                    steps.Add(new AllocationStep(rule.Type, rule.FixedAmountPerMember * members.Count, shares));
                    break;
                }

                case AllocationRuleType.SplitRemainderToMembers:
                {
                    var remainder = members.Sum(m => balances[m.Id]);
                    // How the pooled remainder is divided into each member's savings, matching the
                    // "Send savings to" control: Balance tilts toward the lowest balance; Equal and
                    // ByIncomeRatio pool it and split evenly / by income. When there's nothing to
                    // share (remainder <= 0) each member keeps their own (non-positive) leftover.
                    var shares = remainder <= 0m
                        ? members.Select(m => new MemberShare(m.Id, m.Name, balances[m.Id])).ToList()
                        : rule.Split switch
                        {
                            SplitMethod.BalanceTilt => BalanceTiltSplit(members, remainder, balanceLeanPercent),
                            _ => Split(members, remainder, rule.Split, totalNet),
                        };

                    // The terminal step *is* each member's savings, so make their running
                    // balance match exactly — residuals are read back from it below.
                    foreach (var s in shares)
                    {
                        balances[s.MemberId] = s.Amount;
                    }

                    steps.Add(new AllocationStep(rule.Type, shares.Sum(s => s.Amount), shares));
                    break;
                }
            }
        }

        var residuals = members
            .Select(m => new MemberResidual(m.Id, m.Name, m.NetIncome, balances[m.Id], m.SavingsAccountId, m.SavingsBalance))
            .ToList();

        return new AllocationResult(pool, steps, residuals);
    }

    private static IReadOnlyList<MemberShare> Split(
        IReadOnlyList<AllocationMember> members, decimal total, SplitMethod split, decimal totalNet)
    {
        var n = members.Count;
        if (n == 0)
        {
            return Array.Empty<MemberShare>();
        }

        var shares = new List<MemberShare>(n);
        decimal allocated = 0m;
        for (var i = 0; i < n; i++)
        {
            var m = members[i];
            decimal amount;
            if (i == n - 1)
            {
                // The last member absorbs the rounding remainder so the split is exact.
                amount = total - allocated;
            }
            else
            {
                amount = split == SplitMethod.ByIncomeRatio && totalNet > 0m
                    ? Math.Round(total * (m.NetIncome / totalNet), 2, MidpointRounding.AwayFromZero)
                    : Math.Round(total / n, 2, MidpointRounding.AwayFromZero);
                allocated += amount;
            }

            shares.Add(new MemberShare(m.Id, m.Name, amount));
        }

        return shares;
    }

    /// <summary>
    /// Distributes the pooled savings remainder across members, leaning toward whoever's
    /// savings balance is lowest. Each member's share is a blend of an even split and a
    /// "fill the lowest balances first" (water-fill) target; <paramref name="leanPercent"/>
    /// (0–100) sets how far toward the water-fill target we lean. At 0 it is a plain even
    /// split; below 100 every member always receives a positive share. Rounds to the cent,
    /// with the largest share absorbing the remainder so the split is exact.
    /// </summary>
    private static IReadOnlyList<MemberShare> BalanceTiltSplit(
        IReadOnlyList<AllocationMember> members, decimal remainder, int leanPercent)
    {
        var n = members.Count;
        var alpha = Math.Clamp(leanPercent, 0, 100) / 100m;
        var even = remainder / n;
        var fill = WaterFill(members, remainder);

        var shares = members
            .Select(m => new MemberShare(
                m.Id, m.Name,
                Math.Round((1m - alpha) * even + alpha * fill[m.Id], 2, MidpointRounding.AwayFromZero)))
            .ToList();

        // Push any rounding drift onto the largest share, which can safely absorb a few cents.
        var drift = remainder - shares.Sum(s => s.Amount);
        if (drift != 0m)
        {
            var maxIndex = 0;
            for (var i = 1; i < n; i++)
            {
                if (shares[i].Amount > shares[maxIndex].Amount)
                {
                    maxIndex = i;
                }
            }

            shares[maxIndex] = shares[maxIndex] with { Amount = shares[maxIndex].Amount + drift };
        }

        return shares;
    }

    /// <summary>
    /// "Water-filling": the shares that would bring the lowest savings balances up to a common
    /// level, distributing exactly <paramref name="remainder"/>. Balances already above that
    /// level get nothing. Used as the fully-converging target that <see cref="BalanceTiltSplit"/>
    /// blends toward.
    /// </summary>
    private static Dictionary<Guid, decimal> WaterFill(IReadOnlyList<AllocationMember> members, decimal remainder)
    {
        var n = members.Count;
        var ordered = members.OrderBy(m => m.SavingsBalance).ToList();
        var result = members.ToDictionary(m => m.Id, _ => 0m);

        decimal prefix = 0m;
        for (var k = 1; k <= n; k++)
        {
            prefix += ordered[k - 1].SavingsBalance;

            // Top tier: no higher balance to fill up to, so level everything remaining across all k.
            // Handle this BEFORE forming a ceiling — the old sentinel `k * decimal.MaxValue` overflows
            // decimal for n >= 2 (it threw OverflowException for any household with equal/zero
            // balances, e.g. a brand-new couple, 500-ing both preview and commit).
            if (k == n)
            {
                FillToLevel(result, ordered, k, remainder, prefix);
                break;
            }

            var costToCeiling = (k * ordered[k].SavingsBalance) - prefix;
            if (remainder <= costToCeiling)
            {
                FillToLevel(result, ordered, k, remainder, prefix);
                break;
            }
        }

        return result;
    }

    /// <summary>Brings the k lowest balances up to a common level with exactly the funds available.</summary>
    private static void FillToLevel(
        Dictionary<Guid, decimal> result, IReadOnlyList<AllocationMember> ordered, int k, decimal remainder, decimal prefix)
    {
        var level = (remainder + prefix) / k;
        for (var j = 0; j < k; j++)
        {
            result[ordered[j].Id] = level - ordered[j].SavingsBalance;
        }
    }
}

public record AllocationMember(Guid Id, string Name, decimal NetIncome, Guid? SavingsAccountId, decimal SavingsBalance = 0m);

public record AllocationRuleInput(
    int Order, AllocationRuleType Type, SplitMethod Split, decimal FixedAmountPerMember, decimal ResolvedTotal);

public record MemberShare(Guid MemberId, string Name, decimal Amount);

public record AllocationStep(AllocationRuleType Type, decimal Total, IReadOnlyList<MemberShare> PerMember);

public record MemberResidual(
    Guid MemberId, string Name, decimal NetIncome, decimal Residual, Guid? SavingsAccountId, decimal SavingsBalance = 0m);

public record AllocationResult(decimal Pool, IReadOnlyList<AllocationStep> Steps, IReadOnlyList<MemberResidual> Members);

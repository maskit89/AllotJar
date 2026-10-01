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
/// Splits round down to cents, then distribute the remainder by fractional share,
/// breaking ties in the supplied member/display order. The original total is preserved.
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

                    steps.Add(new AllocationStep(
                        rule.Type, rule.ResolvedTotal, shares, FellBackToEqual(rule.Split, members, totalNet)));
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

                    steps.Add(new AllocationStep(
                        rule.Type, shares.Sum(s => s.Amount), shares,
                        remainder > 0m && FellBackToEqual(rule.Split, members, totalNet)));
                    break;
                }
            }
        }

        var residuals = members
            .Select(m => new MemberResidual(
                m.Id, m.Name, m.NetIncome, balances[m.Id], m.SavingsAccountId, m.SavingsBalance, m.SavingsBalanceAvailable))
            .ToList();

        return new AllocationResult(pool, steps, residuals);
    }

    /// <summary>
    /// O4 (answered 1 October 2026): an income-based split when the month's income is zero has no
    /// ratio to follow, so it is shared equally instead, and the step says so for the screen's note.
    /// </summary>
    private static bool FellBackToEqual(SplitMethod split, IReadOnlyList<AllocationMember> members, decimal totalNet) =>
        split == SplitMethod.ByIncomeRatio && totalNet <= 0m && members.Count > 0;

    private static IReadOnlyList<MemberShare> Split(
        IReadOnlyList<AllocationMember> members, decimal total, SplitMethod split, decimal totalNet)
    {
        var n = members.Count;
        if (n == 0)
        {
            return Array.Empty<MemberShare>();
        }

        var exact = members.Select(m => split == SplitMethod.ByIncomeRatio && totalNet > 0m
            ? total * (m.NetIncome / totalNet)
            : total / n).ToArray();
        return RoundShares(members, total, exact);
    }

    /// <summary>
    /// Distributes the pooled savings remainder across members, leaning toward whoever's
    /// savings balance is lowest. Each member's share is a blend of an even split and a
    /// "fill the lowest balances first" (water-fill) target; <paramref name="leanPercent"/>
    /// (0–100) sets how far toward the water-fill target we lean. At 0 it is a plain even
    /// split; tiny shares may round to zero. Uses the same conserved rounding as equal
    /// and income-based splits, so a tiny remainder cannot create a negative share.
    /// </summary>
    private static IReadOnlyList<MemberShare> BalanceTiltSplit(
        IReadOnlyList<AllocationMember> members, decimal remainder, int leanPercent)
    {
        var n = members.Count;
        var alpha = Math.Clamp(leanPercent, 0, 100) / 100m;
        var even = remainder / n;
        var fill = WaterFill(members, remainder);

        var exact = members.Select(m => (1m - alpha) * even + alpha * fill[m.Id]).ToArray();
        return RoundShares(members, remainder, exact);
    }

    private static IReadOnlyList<MemberShare> RoundShares(
        IReadOnlyList<AllocationMember> members, decimal total, IReadOnlyList<decimal> exact)
    {
        const decimal cent = 0.01m;
        var sign = total < 0m ? -1m : 1m;
        var amounts = exact.Select(a => Math.Floor(a * sign / cent) * cent).ToArray();
        var remaining = total * sign - amounts.Sum();
        var order = Enumerable.Range(0, members.Count)
            .OrderByDescending(i => exact[i] * sign - amounts[i])
            .ThenBy(i => i);

        foreach (var i in order)
        {
            if (remaining <= 0m) break;
            // Preserve any existing sub-cent amount too; changing storage/currency
            // precision is a separate policy, not a reason to invent or discard money.
            var extra = Math.Min(cent, remaining);
            amounts[i] += extra;
            remaining -= extra;
        }

        return members.Select((m, i) => new MemberShare(m.Id, m.Name, amounts[i] * sign)).ToList();
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

/// <param name="SavingsBalanceAvailable">
/// False when the member's savings balance could not be read (no opening date on the account):
/// the tilt then uses zero as a neutral weight, and readers must show the balance as unknown.
/// </param>
public record AllocationMember(
    Guid Id, string Name, decimal NetIncome, Guid? SavingsAccountId, decimal SavingsBalance = 0m,
    bool SavingsBalanceAvailable = true);

public record AllocationRuleInput(
    int Order, AllocationRuleType Type, SplitMethod Split, decimal FixedAmountPerMember, decimal ResolvedTotal);

public record MemberShare(Guid MemberId, string Name, decimal Amount);

/// <param name="FellBackToEqual">
/// True when the step asked for an income-based split but the month's income is zero, so the
/// amount was shared equally (O4).
/// </param>
public record AllocationStep(
    AllocationRuleType Type, decimal Total, IReadOnlyList<MemberShare> PerMember, bool FellBackToEqual = false);

public record MemberResidual(
    Guid MemberId, string Name, decimal NetIncome, decimal Residual, Guid? SavingsAccountId, decimal SavingsBalance = 0m,
    bool SavingsBalanceAvailable = true);

public record AllocationResult(decimal Pool, IReadOnlyList<AllocationStep> Steps, IReadOnlyList<MemberResidual> Members);

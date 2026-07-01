using FluentAssertions;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;
using Xunit;

namespace AllotJar.Application.Tests.Domain;

/// <summary>
/// Verifies the accrual maths against the actual figures in the source household
/// spreadsheet, so the app reconciles to it to the cent.
/// </summary>
public class JarAccrualCalculatorTests
{
    private static Jar MakeJar(
        decimal target,
        AccrualMethod accrual,
        DateOnly? targetDate = null,
        DateOnly? coverStart = null,
        DateOnly? coverEnd = null) => new()
    {
        Name = "Test",
        TargetAmount = target,
        Accrual = accrual,
        TargetDate = targetDate,
        CoverStart = coverStart,
        CoverEnd = coverEnd,
    };

    // --- StraightLine: spreadsheet "Monthly Expenses" col C = B / 12 ---

    [Theory]
    [InlineData(300, 25.00)]      // Home Insurance  300/12
    [InlineData(790, 65.83)]      // Life Insurance  790/12 = 65.8333 -> 65.83
    [InlineData(1300, 108.33)]    // Health Insurance 1300/12 = 108.333 -> 108.33
    [InlineData(5000, 416.67)]    // Battery Replacement 5000/12 = 416.667 -> 416.67
    public void StraightLine_divides_target_by_twelve(decimal target, decimal expected)
    {
        var jar = MakeJar(target, AccrualMethod.StraightLine);

        JarAccrualCalculator.StraightLine(jar).Should().Be(expected);
    }

    [Fact]
    public void StraightLine_uses_cover_period_length_when_set()
    {
        // A 6-month cover window divides by 6, not 12.
        var jar = MakeJar(600, AccrualMethod.StraightLine,
            coverStart: new DateOnly(2026, 1, 1),
            coverEnd: new DateOnly(2026, 7, 1));

        JarAccrualCalculator.StraightLine(jar).Should().Be(100.00m);
    }

    // --- ProportionalPool: spreadsheet "Yearly Expenses" col F = (B/ΣB) × €1400 ---

    [Theory]
    [InlineData(70, 6.46)]        // Comtec
    [InlineData(125, 11.53)]      // AC Services
    [InlineData(2500, 230.69)]    // Medicine
    public void ProportionalPool_distributes_the_fixed_pool_by_target_weight(decimal target, decimal expected)
    {
        // Σ targets = 15171.94 (col B29), monthly pool = €1400 (B33).
        const decimal poolTargetTotal = 15171.94m;
        const decimal monthlyPool = 1400m;

        JarAccrualCalculator
            .ProportionalContribution(target, poolTargetTotal, monthlyPool)
            .Should().Be(expected);
    }

    [Fact]
    public void ProportionalPool_returns_zero_when_pool_total_is_empty()
        => JarAccrualCalculator.ProportionalContribution(70m, 0m, 1400m).Should().Be(0m);

    // --- DailyRate opening balance: spreadsheet "Yearly Expenses" col J = ROUND(B/365 × days) ---

    [Theory]
    [InlineData(70, 274, 52.55)]      // Comtec        70/365 × 274
    [InlineData(80, 30, 6.58)]        // Transport Lic  80/365 × 30
    [InlineData(12.3, 271, 9.13)]     // Woman Log    12.3/365 × 271
    public void AccruedByDailyRate_matches_the_sheet_opening_balance(decimal target, int days, decimal expected)
    {
        var from = new DateOnly(2026, 1, 1);
        var to = from.AddDays(days);

        JarAccrualCalculator.AccruedByDailyRate(target, from, to).Should().Be(expected);
    }

    [Fact]
    public void AccruedByDailyRate_is_zero_for_a_non_positive_span()
    {
        var d = new DateOnly(2026, 1, 1);

        JarAccrualCalculator.AccruedByDailyRate(100m, d, d).Should().Be(0m);
    }

    // --- TargetByDate: the recommended self-correcting default ---

    [Fact]
    public void TargetByDate_spreads_the_remaining_over_months_until_due()
    {
        var jar = MakeJar(1200, AccrualMethod.TargetByDate, targetDate: new DateOnly(2026, 11, 1));

        // (1200 - 200) / 10 months = 100.00
        JarAccrualCalculator
            .TargetByDate(jar, new DateOnly(2026, 1, 1), currentBalance: 200m)
            .Should().Be(100.00m);
    }

    [Fact]
    public void TargetByDate_returns_zero_once_fully_funded()
    {
        var jar = MakeJar(1200, AccrualMethod.TargetByDate, targetDate: new DateOnly(2026, 11, 1));

        JarAccrualCalculator
            .TargetByDate(jar, new DateOnly(2026, 1, 1), currentBalance: 1200m)
            .Should().Be(0m);
    }

    [Fact]
    public void TargetByDate_floors_at_one_month_when_due_now_or_overdue()
    {
        var jar = MakeJar(500, AccrualMethod.TargetByDate, targetDate: new DateOnly(2026, 1, 1));

        // Due this month with nothing saved -> the whole remaining is required now.
        JarAccrualCalculator
            .TargetByDate(jar, new DateOnly(2026, 1, 15), currentBalance: 0m)
            .Should().Be(500.00m);
    }

    [Fact]
    public void RequiredMonthlyContribution_dispatches_on_the_funds_method()
    {
        var asOf = new DateOnly(2026, 1, 1);

        JarAccrualCalculator
            .RequiredMonthlyContribution(MakeJar(300, AccrualMethod.StraightLine), asOf)
            .Should().Be(25.00m);

        JarAccrualCalculator
            .RequiredMonthlyContribution(
                MakeJar(70, AccrualMethod.ProportionalPool), asOf,
                monthlyPool: 1400m, poolTargetTotal: 15171.94m)
            .Should().Be(6.46m);
    }
}

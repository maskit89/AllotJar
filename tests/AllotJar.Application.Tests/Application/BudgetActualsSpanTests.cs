using FluentAssertions;
using AllotJar.Application.Budgets;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// #395 P3-1: the span a report reads its rows over. A year no date can have holds no rows, so
/// it must not widen the read to the household's whole history.
/// </summary>
public class BudgetActualsSpanTests
{
    [Fact]
    public void Runs_from_the_first_day_of_the_first_month_to_the_last_day_of_the_last()
    {
        BudgetActuals.Span(new[] { (2025, 11), (2024, 2), (2025, 1) })
            .Should().Be((new DateOnly(2024, 2, 1), new DateOnly(2025, 11, 30)));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-5)]
    [InlineData(10000)]
    public void A_year_no_date_can_have_reads_nothing(int year)
    {
        var (from, through) = BudgetActuals.Span(new[] { (year, 1), (year, 12) });

        from.Should().BeAfter(through, "an empty span matches no row");
    }

    [Fact]
    public void A_year_no_date_can_have_leaves_the_other_months_span_alone()
    {
        BudgetActuals.Span(new[] { (0, 1), (2025, 3), (9999, 12) })
            .Should().Be((new DateOnly(2025, 3, 1), new DateOnly(9999, 12, 31)));
    }
}

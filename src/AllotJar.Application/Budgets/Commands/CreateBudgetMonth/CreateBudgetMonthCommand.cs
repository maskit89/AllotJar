using MediatR;
using AllotJar.Application.Budgets.Dtos;

namespace AllotJar.Application.Budgets.Commands.CreateBudgetMonth;

/// <summary>
/// Creates the user's budget for a month. Precedence:
///   1. a non-empty <paramref name="TemplateKey"/> builds from that quick-start template;
///   2. otherwise, when <paramref name="CopyFromPrevious"/> is true and an earlier month
///      exists, its groups/lines (and planned amounts) are copied — actuals reset to zero;
///   3. otherwise a blank budget with a single empty Income group is created.
/// Returns the new month.
/// </summary>
public record CreateBudgetMonthCommand(
    int Year,
    int Month,
    bool CopyFromPrevious = true,
    string? TemplateKey = null) : IRequest<BudgetMonthDto>;

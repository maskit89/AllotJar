using MediatR;
using AllotJar.Application.Budgets.Dtos;

namespace AllotJar.Application.Budgets.Commands.CreateBudgetMonth;

/// <summary>
/// Creates the user's budget for a month. Precedence:
///   1. a non-empty <paramref name="TemplateKey"/> builds from that quick-start template;
///   2. otherwise, when <paramref name="CopyFromPrevious"/> is true and an earlier month
///      exists, its groups/lines (and planned amounts) are copied — actuals reset to zero;
///   3. otherwise a blank budget is created: a single Income group holding one line per
///      active person with a saved Default income, attributed to them (empty when nobody
///      has one).
/// Rule 94: once an earlier month exists, only the copy is allowed (a blank or template request
/// is refused), and a template only when the household has no month at all.
/// Returns the new month.
/// </summary>
public record CreateBudgetMonthCommand(
    int Year,
    int Month,
    bool CopyFromPrevious = true,
    string? TemplateKey = null) : IRequest<BudgetMonthDto>;

using MediatR;
using ZeroBudget.Application.Jars.Dtos;

namespace ZeroBudget.Application.Jars.Queries.GetJars;

/// <summary>
/// Lists the user's sinking funds with their derived balance, required monthly
/// contribution, projection and status. <paramref name="AsOf"/> defaults to today and
/// is injectable so the accrual maths are deterministic in tests.
/// </summary>
public record GetJarsQuery(bool IncludeArchived = false, DateOnly? AsOf = null)
    : IRequest<IReadOnlyList<JarDto>>;

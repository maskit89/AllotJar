using MediatR;
using AllotJar.Application.Jars.Dtos;

namespace AllotJar.Application.Jars.Queries.GetJarPayments;

/// <summary>
/// The payments the user can choose from when marking a Recurring jar's cycle paid (rule 83):
/// expenses not yet linked to any cycle, newest first — those that drew from the jar (on its
/// Savings line, or paid from it, rule 79) or, with <paramref name="IncludeOtherPayments"/>,
/// every expense of the household (a bill paid from another account). At most 100.
/// </summary>
public record GetJarPaymentsQuery(Guid JarId, bool IncludeOtherPayments = false, DateOnly? AsOf = null)
    : IRequest<IReadOnlyList<JarPaymentDto>>;

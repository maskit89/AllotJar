using MediatR;
using AllotJar.Application.Jars.Dtos;

namespace AllotJar.Application.Jars.Commands.DismissJarCycle;

/// <summary>
/// Rule 20: dismisses a Recurring jar's <b>Deadline missed</b> notice — the open cycle due on
/// <paramref name="Deadline"/>, which has passed short of its target (or was reached only
/// afterwards, rule 57) — and resumes saving toward the next deadline. The cycle closes as
/// Missed (or Funded late) without a payment; balances are untouched and nothing is recorded
/// as paid. Returns the jar.
/// </summary>
public record DismissJarCycleCommand(Guid JarId, DateOnly Deadline) : IRequest<JarDto>;

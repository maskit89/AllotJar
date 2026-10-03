using MediatR;
using AllotJar.Application.Jars.Dtos;

namespace AllotJar.Application.Jars.Commands.CompleteJar;

/// <summary>
/// Rules 55–56 (W04): marks a one-off jar's purpose completed. From then on it plans no
/// contributions — this month's remaining contribution and every later month's line are
/// cancelled, and neither an emptied nor a spent balance ever restarts a plan. Whatever the jar
/// still holds stays in it, visible, until the user reallocates it; completion records no
/// payment and moves no money. Only a Goal with a known, non-negative balance can be completed
/// (an overdrawn one is covered first, and the refusal says how much — P41, O3a); a Recurring
/// jar's cycles end by being marked paid (rule 83). A completed Goal can be reopened (O3c).
/// Returns the jar.
/// </summary>
public record CompleteJarCommand(Guid Id) : IRequest<JarDto>;

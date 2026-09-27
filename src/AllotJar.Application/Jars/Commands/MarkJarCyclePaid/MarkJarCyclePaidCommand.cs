using MediatR;
using AllotJar.Application.Jars.Dtos;

namespace AllotJar.Application.Jars.Commands.MarkJarCyclePaid;

/// <summary>
/// Rule 83: the user marks a Recurring jar's cycle as paid and chooses the payment that
/// fulfilled it — the app never infers which payment belongs to which cycle. The cycle due
/// on <paramref name="Deadline"/> is the jar's open cycle (which then advances to the next
/// deadline, rules 21–24) or an already closed one that has no payment yet (a cycle that
/// rolled forward funded, or was dismissed, and is being paid late): it is simply recorded.
/// No money moves: the payment already left the jar when it was recorded. Returns the jar.
/// </summary>
public record MarkJarCyclePaidCommand(Guid JarId, DateOnly Deadline, Guid PaymentTransactionId) : IRequest<JarDto>;

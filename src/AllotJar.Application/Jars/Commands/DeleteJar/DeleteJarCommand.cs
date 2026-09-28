using MediatR;

namespace AllotJar.Application.Jars.Commands.DeleteJar;

/// <summary>
/// Rules 25 and 84 (W04): permanently deletes a jar that never held money — nothing was ever
/// allocated to it and nothing was ever spent from it — removing its planned Savings lines from
/// every month. A jar that has held money is refused: it is archived instead, so its history
/// stays (rules 26–27). Archiving remains available for an unused jar too.
/// </summary>
public record DeleteJarCommand(Guid Id) : IRequest;

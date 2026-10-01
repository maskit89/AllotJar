using MediatR;
using AllotJar.Application.Jars.Dtos;

namespace AllotJar.Application.Jars.Commands.ReopenJar;

/// <summary>
/// O3c (answered 1 October 2026): reopens a completed Goal. It is active again and its plan
/// restarts from the money still in the jar: the current and later months are replanted as an
/// edit would (rule 46, P29). Reopening records no payment and moves no money. An archived jar is
/// restored first. Returns the jar.
/// </summary>
public record ReopenJarCommand(Guid Id) : IRequest<JarDto>;

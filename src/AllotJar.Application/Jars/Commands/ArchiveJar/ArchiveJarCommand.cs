using MediatR;
using AllotJar.Application.Jars.Dtos;

namespace AllotJar.Application.Jars.Commands.ArchiveJar;

/// <summary>
/// Archives (or restores) a jar. Archiving is soft — the jar and its history are kept so past
/// months still reconcile (rule 25) — and needs a zero balance (rule 26); it cancels the jar's
/// remaining planned contribution this month and every later month's (rule 27), hides the jar
/// from the active list and from month creation. Restoring plants its schedule again from the
/// current month (unless the jar is completed). Returns the updated jar.
/// </summary>
public record ArchiveJarCommand(Guid Id, bool Archived = true) : IRequest<JarDto>;

using MediatR;
using AllotJar.Application.Jars.Dtos;

namespace AllotJar.Application.Jars.Commands.ArchiveJar;

/// <summary>
/// Archives (or restores) a sinking fund. Archiving is soft — the fund and its history
/// are kept so past months still reconcile; it is just hidden from the active list and
/// from month-contribution seeding. Returns the updated fund.
/// </summary>
public record ArchiveJarCommand(Guid Id, bool Archived = true) : IRequest<JarDto>;

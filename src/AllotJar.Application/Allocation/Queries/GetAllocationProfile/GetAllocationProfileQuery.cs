using MediatR;
using AllotJar.Application.Allocation.Dtos;

namespace AllotJar.Application.Allocation.Queries.GetAllocationProfile;

/// <summary>Returns the household's allocation profile (the first one), or null if none is set up yet.</summary>
public record GetAllocationProfileQuery : IRequest<AllocationProfileDto?>;

using MediatR;
using AllotJar.Application.Common.Security;

namespace AllotJar.Application.HouseholdAccess.Commands.ReleasePersonLogin;

/// <summary>
/// "This isn't me" (S-P3-8, D5): the calling login releases its own earlier link to the budget
/// person <see cref="MemberId"/>, so it no longer stops the person's own login making their accounts
/// private. It only ever releases the caller's own link: nobody, the owner included, can release
/// another login's, which would let them hide that person's account again. Any role may, since it
/// only gives up something of the caller's.
/// </summary>
[AllowAnyRole]
public record ReleasePersonLoginCommand(Guid MemberId) : IRequest;

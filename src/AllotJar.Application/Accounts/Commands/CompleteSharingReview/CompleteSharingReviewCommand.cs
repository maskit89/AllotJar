using MediatR;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Application.Common.Security;

namespace AllotJar.Application.Accounts.Commands.CompleteSharingReview;

/// <summary>
/// The caller's answer to the sharing review (rule 32): each of their personal accounts listed in
/// <paramref name="PrivateAccountIds"/> becomes private, every other one is shared. Clears the
/// review. Any role may answer for its own accounts.
/// </summary>
[AllowAnyRole]
public record CompleteSharingReviewCommand(IReadOnlyList<Guid> PrivateAccountIds) : IRequest<SharingReviewDto>;

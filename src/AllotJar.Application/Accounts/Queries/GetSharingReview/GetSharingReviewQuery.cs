using MediatR;
using AllotJar.Application.Accounts.Dtos;

namespace AllotJar.Application.Accounts.Queries.GetSharingReview;

/// <summary>The caller's personal accounts and whether their sharing review is due (rule 32).</summary>
public record GetSharingReviewQuery : IRequest<SharingReviewDto>;

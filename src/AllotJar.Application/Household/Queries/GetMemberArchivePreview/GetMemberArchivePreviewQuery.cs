using MediatR;
using AllotJar.Application.Household.Dtos;

namespace AllotJar.Application.Household.Queries.GetMemberArchivePreview;

/// <summary>
/// What archiving a person would do to their pocket money (rule 54): the current month's planned,
/// paid and remaining amounts — the question the People page must ask before archiving when
/// something remains — and the future months whose lines would be cancelled. Owner-scoped.
/// </summary>
public record GetMemberArchivePreviewQuery(Guid Id) : IRequest<MemberArchivePreviewDto>;

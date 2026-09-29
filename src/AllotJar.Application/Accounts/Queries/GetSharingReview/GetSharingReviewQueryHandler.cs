using MediatR;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Accounts.Queries.GetSharingReview;

public class GetSharingReviewQueryHandler : IRequestHandler<GetSharingReviewQuery, SharingReviewDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetSharingReviewQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public Task<SharingReviewDto> Handle(GetSharingReviewQuery request, CancellationToken cancellationToken) =>
        SharingReview.ReadAsync(_db, _currentUser, cancellationToken);
}

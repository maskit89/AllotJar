using MediatR;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Application.Reports.Dtos;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Reports.Queries.GetJarSpending;

public class GetJarSpendingQueryHandler : IRequestHandler<GetJarSpendingQuery, JarSpendingReportDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetJarSpendingQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<JarSpendingReportDto> Handle(GetJarSpendingQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");
        if (request.Year is < 1 or > 9999)
        {
            throw new ValidationException(new Dictionary<string, string[]> { ["year"] = ["Enter a calendar year."] });
        }

        // The same reading of "what left the jar" as the Jars page and the cycle's payment list
        // (rule 79), so a jar's history and this report never disagree.
        var source = await JarLedgerReader.LoadAsync(_db, userId, cancellationToken);
        var (postings, waiting) = source.SpendingBetween(new DateOnly(request.Year, 1, 1), new DateOnly(request.Year, 12, 31));

        var rows = source.Jars
            .OrderBy(j => j.Name, StringComparer.CurrentCultureIgnoreCase)
            .ThenBy(j => j.Id)
            .Select(jar => new JarSpendingRowDto
            {
                JarId = jar.Id,
                Name = jar.Name,
                Currency = source.AccountCurrency(jar.FundingAccountId) ?? string.Empty,
                IsArchived = jar.IsArchived || jar.IsCompleted,
                Months = Enumerable.Repeat(0m, 12).ToList(),
                Refunds = Enumerable.Repeat(0m, 12).ToList(),
            })
            .ToDictionary(r => r.JarId);

        foreach (var posting in postings)
        {
            if (!rows.TryGetValue(posting.JarId, out var row))
            {
                continue;
            }
            var index = posting.Date.Month - 1;
            if (posting.IsRefund)
            {
                row.Months[index] -= posting.Amount;
                row.Refunds[index] += posting.Amount;
            }
            else
            {
                row.Months[index] += posting.Amount;
            }
        }

        foreach (var row in rows.Values)
        {
            row.Total = row.Months.Sum();
            row.TotalRefunds = row.Refunds.Sum();
        }

        return new JarSpendingReportDto
        {
            Year = request.Year,
            // A jar put away stays listed while the year still shows what it paid (rule 27 keeps
            // its history); a live jar is listed even at zero, so "nothing spent" is visible.
            Jars = rows.Values
                .Where(r => !r.IsArchived || r.Total != 0m || r.TotalRefunds != 0m)
                .OrderBy(r => r.IsArchived)
                .ThenBy(r => r.Name, StringComparer.CurrentCultureIgnoreCase)
                .ThenBy(r => r.JarId)
                .ToList(),
            WaitingCount = waiting,
        };
    }
}

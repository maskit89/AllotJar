using AllotJar.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace AllotJar.Application.Tests.TestDoubles;

/// <summary>
/// A fresh, isolated EF in-memory database per call. Imported into every test file by a global
/// <c>using static</c> in the project file, so tests just call <c>NewContext()</c>.
/// </summary>
public static class TestDb
{
    public static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"allotjar-tests-{Guid.NewGuid()}")
            .Options);
}

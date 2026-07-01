using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace AllotJar.Infrastructure.Persistence;

/// <summary>
/// Design-time factory used by the EF Core CLI ("dotnet ef migrations add ...").
/// It lets the tooling construct the context without booting the whole API.
/// The connection string here is only used for scaffolding migrations — the
/// runtime connection string comes from the API's configuration.
/// </summary>
public class ApplicationDbContextFactory : IDesignTimeDbContextFactory<ApplicationDbContext>
{
    public ApplicationDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseSqlServer(
                "Server=(localdb)\\MSSQLLocalDB;Database=ZeroBudget;Trusted_Connection=True;MultipleActiveResultSets=true",
                sql => sql.MigrationsAssembly(typeof(ApplicationDbContext).Assembly.FullName))
            .Options;

        return new ApplicationDbContext(options);
    }
}

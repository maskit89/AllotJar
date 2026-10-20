using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Persistence.Encryption;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// Compliance fix 10 over real HTTP: bank details typed on an account come back on the account
/// screens and in Download my data exactly as typed, while the database holds only encrypted text.
/// </summary>
[Collection(nameof(HttpApiCollection))]
public class BankDetailsHttpTests
{
    private readonly HttpApiFixture _fixture;

    public BankDetailsHttpTests(HttpApiFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task Bank_details_show_and_export_plain_but_are_stored_encrypted()
    {
        using var client = _fixture.CreateClient();
        var email = $"bank-{Guid.NewGuid():N}"[..16] + "@bank.test";
        var register = await client.PostAsJsonAsync("/api/auth/register", new
        {
            email, password = HttpApiFixture.StrongPassword(), firstName = "Ivy", lastName = "Ban",
            preferredCurrency = "EUR", numberFormat = (string?)null, acceptedTerms = true,
        }, HttpApiFixture.Json);
        register.StatusCode.Should().Be(HttpStatusCode.OK, await register.Content.ReadAsStringAsync());
        var token = (await HttpApiFixture.ReadJsonAsync(register)).RootElement.GetProperty("token").GetString()!;

        var created = await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/accounts", token, new
        {
            name = "Bank details", type = 0, currency = "EUR", openingBalance = 0m, openingDate = "2026-01-01",
            iban = "mt84 malt 0110 0001 2345 mtlc ast0 01s", bic = "maltmtmt", sortCode = "12-34-56", accountNumber = "12345678",
        });
        created.StatusCode.Should().Be(HttpStatusCode.Created, await created.Content.ReadAsStringAsync());
        var id = (await HttpApiFixture.ReadJsonAsync(created)).RootElement.GetProperty("id").GetGuid();

        // The account screens read the values as normalised on save.
        var list = await (await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/accounts", token)).Content.ReadAsStringAsync();
        list.Should().Contain("MT84MALT011000012345MTLCAST001S").And.Contain("MALTMTMT")
            .And.Contain("\"sortCode\":\"123456\"").And.Contain("\"accountNumber\":\"12345678\"");

        // Download my data carries them plain too. Asked through a host of its own, so this call does
        // not spend the shared host's export allowance (5 a minute) that the role matrix and the
        // anonymous sweep count on.
        using var exportClient = _fixture.CreateClient(_ => { });
        using var export = await HttpApiFixture.SendAsync(exportClient, HttpMethod.Get, "/api/export", token);
        export.StatusCode.Should().Be(HttpStatusCode.OK);
        using var zip = new ZipArchive(await export.Content.ReadAsStreamAsync());
        using var reader = new StreamReader(zip.GetEntry("accounts.csv")!.Open());
        var csv = await reader.ReadToEndAsync();
        csv.Should().Contain("MT84MALT011000012345MTLCAST001S").And.Contain("MALTMTMT").And.Contain("123456").And.Contain("12345678");
        csv.Should().NotContain(BankDetailsCipher.Prefix);

        // The database holds none of them in the clear.
        using var scope = _fixture.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var stored = await db.Database
            .SqlQuery<string>($"SELECT CONCAT(Iban, '|', Bic, '|', SortCode, '|', AccountNumber) AS Value FROM Accounts WHERE Id = {id}")
            .SingleAsync();
        stored.Should().NotContain("MALT").And.NotContain("123456").And.NotContain("12345678");
        stored.Split('|').Should().AllSatisfy(s => s.Should().StartWith(BankDetailsCipher.Prefix));
    }
}

using System.Net;
using System.Net.Http.Json;
using FluentAssertions;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// Account settings' signed-in devices over real HTTP: the list (one row per sign-in, this device's
/// marked), signing one other device out, and signing out everywhere.
/// </summary>
[Collection(nameof(HttpApiCollection))]
public class SignedInDevicesHttpTests
{
    private const string IPhoneSafari =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    private const string WindowsChrome =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

    private readonly HttpApiFixture _fixture;

    public SignedInDevicesHttpTests(HttpApiFixture fixture) => _fixture = fixture;

    /// <summary>Registers on the laptop, then signs the same login in on the phone. Each client keeps its own cookie.</summary>
    private async Task<(HttpClient Laptop, string LaptopToken, HttpClient Phone, string PhoneToken)> TwoDevicesAsync()
    {
        var laptop = _fixture.CreateClient();
        laptop.DefaultRequestHeaders.UserAgent.ParseAdd(WindowsChrome);
        var phone = _fixture.CreateClient();
        phone.DefaultRequestHeaders.UserAgent.ParseAdd(IPhoneSafari);
        phone.DefaultRequestHeaders.Add("X-AllotJar-App", "1");

        var email = $"dev-{Guid.NewGuid():N}"[..16] + "@devices.test";
        var password = HttpApiFixture.StrongPassword();
        var register = await laptop.PostAsJsonAsync("/api/auth/register", new
        {
            email, password, firstName = "Dev", lastName = "Ices", preferredCurrency = "EUR", numberFormat = (string?)null, acceptedTerms = true,
        }, HttpApiFixture.Json);
        register.StatusCode.Should().Be(HttpStatusCode.OK, await register.Content.ReadAsStringAsync());
        var laptopToken = (await HttpApiFixture.ReadJsonAsync(register)).RootElement.GetProperty("token").GetString()!;

        var login = await phone.PostAsJsonAsync("/api/auth/login", new { email, password }, HttpApiFixture.Json);
        login.StatusCode.Should().Be(HttpStatusCode.OK, await login.Content.ReadAsStringAsync());
        var phoneToken = (await HttpApiFixture.ReadJsonAsync(login)).RootElement.GetProperty("token").GetString()!;
        return (laptop, laptopToken, phone, phoneToken);
    }

    private static async Task<List<(Guid Id, string? Device, bool Current)>> ListAsync(HttpClient client, string token)
    {
        var response = await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/sessions", token);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        return (await HttpApiFixture.ReadJsonAsync(response)).RootElement.EnumerateArray()
            .Select(e => (e.GetProperty("id").GetGuid(), e.GetProperty("device").GetString(), e.GetProperty("current").GetBoolean()))
            .ToList();
    }

    [Fact]
    public async Task The_list_names_each_device_and_marks_the_one_asking()
    {
        var (laptop, laptopToken, phone, phoneToken) = await TwoDevicesAsync();
        using (laptop)
        using (phone)
        {
            var fromLaptop = await ListAsync(laptop, laptopToken);
            fromLaptop.Select(s => (s.Device, s.Current)).Should().Equal(("Chrome on Windows", true), ("AllotJar app on iPhone", false));

            // Times reach the client marked UTC, or a browser would read them as its own local time.
            var raw = await HttpApiFixture.ReadJsonAsync(await HttpApiFixture.SendAsync(laptop, HttpMethod.Get, "/api/auth/sessions", laptopToken));
            raw.RootElement[0].GetProperty("lastActiveUtc").GetString().Should().EndWith("Z");
            raw.RootElement[0].GetProperty("startedUtc").GetString().Should().EndWith("Z");

            var fromPhone = await ListAsync(phone, phoneToken);
            fromPhone.Select(s => (s.Device, s.Current)).Should().Equal(("AllotJar app on iPhone", true), ("Chrome on Windows", false));
        }
    }

    [Fact]
    public async Task Signing_the_phone_out_from_the_laptop_ends_it_there_at_once_and_keeps_the_laptop()
    {
        var (laptop, laptopToken, phone, phoneToken) = await TwoDevicesAsync();
        using (laptop)
        using (phone)
        {
            var phoneSession = (await ListAsync(laptop, laptopToken)).Single(s => !s.Current).Id;

            var ended = await HttpApiFixture.SendAsync(laptop, HttpMethod.Delete, $"/api/auth/sessions/{phoneSession}", laptopToken);
            ended.StatusCode.Should().Be(HttpStatusCode.NoContent);

            // The phone's access token died with the stamp, and its cookie no longer refreshes.
            (await HttpApiFixture.SendAsync(phone, HttpMethod.Get, "/api/auth/me", phoneToken)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
            (await phone.PostAsync("/api/auth/refresh", null)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

            // The laptop recovers silently with its own cookie, as after a sign-out elsewhere.
            var refreshed = await laptop.PostAsync("/api/auth/refresh", null);
            refreshed.StatusCode.Should().Be(HttpStatusCode.OK);
            var newToken = (await HttpApiFixture.ReadJsonAsync(refreshed)).RootElement.GetProperty("token").GetString()!;
            (await ListAsync(laptop, newToken)).Select(s => s.Device).Should().Equal("Chrome on Windows");

            // Ending it again, or a sign-in that isn't there, is a 404.
            (await HttpApiFixture.SendAsync(laptop, HttpMethod.Delete, $"/api/auth/sessions/{phoneSession}", newToken))
                .StatusCode.Should().Be(HttpStatusCode.NotFound);
        }
    }

    [Fact]
    public async Task A_login_cannot_end_another_logins_sign_in()
    {
        var (laptop, laptopToken, phone, phoneToken) = await TwoDevicesAsync();
        var (otherLaptop, otherToken, otherPhone, _) = await TwoDevicesAsync();
        using (laptop)
        using (phone)
        using (otherLaptop)
        using (otherPhone)
        {
            var theirs = (await ListAsync(otherLaptop, otherToken)).First().Id;
            (await HttpApiFixture.SendAsync(laptop, HttpMethod.Delete, $"/api/auth/sessions/{theirs}", laptopToken))
                .StatusCode.Should().Be(HttpStatusCode.NotFound);
            (await ListAsync(otherLaptop, otherToken)).Should().HaveCount(2);
        }
    }

    [Fact]
    public async Task Signing_out_everywhere_ends_every_device_this_one_included()
    {
        var (laptop, laptopToken, phone, phoneToken) = await TwoDevicesAsync();
        using (laptop)
        using (phone)
        {
            var response = await HttpApiFixture.SendAsync(laptop, HttpMethod.Post, "/api/auth/sign-out-everywhere", laptopToken);
            response.StatusCode.Should().Be(HttpStatusCode.NoContent);

            (await HttpApiFixture.SendAsync(laptop, HttpMethod.Get, "/api/auth/me", laptopToken)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
            (await HttpApiFixture.SendAsync(phone, HttpMethod.Get, "/api/auth/me", phoneToken)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
            (await laptop.PostAsync("/api/auth/refresh", null)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
            (await phone.PostAsync("/api/auth/refresh", null)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        }
    }
}

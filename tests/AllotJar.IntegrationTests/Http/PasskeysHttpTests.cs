using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Infrastructure.Email;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// Two-factor sign-in with passkeys (fix 14) over real HTTP, with a software authenticator: adding
/// one, signing in with it alone, the second step it adds to password, Google and reset sign-ins,
/// recovery codes, the proof asked before passkeys change, and the answers the server must refuse.
/// </summary>
[Collection(nameof(HttpApiCollection))]
public class PasskeysHttpTests
{
    private readonly HttpApiFixture _fixture;

    public PasskeysHttpTests(HttpApiFixture fixture) => _fixture = fixture;

    private sealed record Login(HttpClient Client, string Email, string Password, string Token) : IDisposable
    {
        public void Dispose() => Client.Dispose();
    }

    private async Task<Login> RegisterAsync()
    {
        var client = _fixture.CreateClient();
        client.DefaultRequestHeaders.UserAgent.ParseAdd(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36");
        var email = $"pk-{Guid.NewGuid():N}"[..16] + "@passkeys.test";
        var password = HttpApiFixture.StrongPassword();
        var register = await client.PostAsJsonAsync("/api/auth/register", new
        {
            email, password, firstName = "Pass", lastName = "Key", preferredCurrency = "EUR", numberFormat = (string?)null, acceptedTerms = true,
        }, HttpApiFixture.Json);
        register.StatusCode.Should().Be(HttpStatusCode.OK, await register.Content.ReadAsStringAsync());
        return new Login(client, email, password, await TokenAsync(register));
    }

    private static async Task<string> TokenAsync(HttpResponseMessage response) =>
        (await HttpApiFixture.ReadJsonAsync(response)).RootElement.GetProperty("token").GetString()!;

    private static async Task<(string Ceremony, string Options)> CeremonyAsync(HttpResponseMessage response)
    {
        response.StatusCode.Should().Be(HttpStatusCode.OK, await response.Content.ReadAsStringAsync());
        var json = (await HttpApiFixture.ReadJsonAsync(response)).RootElement;
        return (json.GetProperty("ceremony").GetString()!, json.GetProperty("options").GetString()!);
    }

    /// <summary>Adds a passkey on <paramref name="login"/>'s device; returns the recovery codes it came with (null after the first).</summary>
    private static async Task<List<string>?> AddPasskeyAsync(Login login, SoftAuthenticator authenticator, object? proof = null)
    {
        var (ceremony, options) = await CeremonyAsync(await HttpApiFixture.SendAsync(
            login.Client, HttpMethod.Post, "/api/auth/passkeys/options", login.Token, new { proof }));
        var add = await HttpApiFixture.SendAsync(login.Client, HttpMethod.Post, "/api/auth/passkeys", login.Token,
            new { ceremony, credential = authenticator.Create(options) });
        add.StatusCode.Should().Be(HttpStatusCode.OK, await add.Content.ReadAsStringAsync());
        var codes = (await HttpApiFixture.ReadJsonAsync(add)).RootElement.GetProperty("recoveryCodes");
        return codes.ValueKind == JsonValueKind.Null ? null : codes.EnumerateArray().Select(c => c.GetString()!).ToList();
    }

    private static async Task<JsonElement> PasswordSignInAsync(HttpClient client, Login login)
    {
        var response = await client.PostAsJsonAsync("/api/auth/login", new { email = login.Email, password = login.Password }, HttpApiFixture.Json);
        response.StatusCode.Should().Be(HttpStatusCode.OK, await response.Content.ReadAsStringAsync());
        return (await HttpApiFixture.ReadJsonAsync(response)).RootElement.Clone();
    }

    private static Task<HttpResponseMessage> SecondStepAsync(HttpClient client, string ticket, string credential) =>
        client.PostAsJsonAsync("/api/auth/second-step/passkey", new { ticket, credential }, HttpApiFixture.Json);

    private static async Task<int> SessionCountAsync(Login login)
    {
        var response = await HttpApiFixture.SendAsync(login.Client, HttpMethod.Get, "/api/auth/sessions", login.Token);
        return (await HttpApiFixture.ReadJsonAsync(response)).RootElement.GetArrayLength();
    }

    /// <summary>Moves the login's sign-ins half an hour back, past the window in which signing in counts as proof.</summary>
    private async Task AgeSignInsAsync(string email)
    {
        using var scope = _fixture.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var userId = await db.Users.Where(u => u.Email == email).Select(u => u.Id).SingleAsync();
        await db.RefreshTokens.Where(t => t.UserId == userId)
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.SessionStartedUtc, t => t.SessionStartedUtc.AddMinutes(-30)));
    }

    private IReadOnlyList<EmailMessage> Mail(string email) =>
        _fixture.Services.GetRequiredService<DevEmailSink>().ForRecipient(email);

    private async Task WaitForMailAsync(string email, string subjectPart)
    {
        for (var i = 0; i < 100 && !Mail(email).Any(m => m.Subject.Contains(subjectPart)); i++)
        {
            await Task.Delay(50);
        }
        Mail(email).Should().Contain(m => m.Subject.Contains(subjectPart));
    }

    [Fact]
    public async Task Adding_a_passkey_just_after_signing_in_needs_nothing_more_and_gives_ten_codes_once()
    {
        using var login = await RegisterAsync();
        var authenticator = new SoftAuthenticator();

        var codes = await AddPasskeyAsync(login, authenticator);
        codes.Should().HaveCount(RecoveryCodes.Count).And.OnlyHaveUniqueItems();
        codes!.Should().AllSatisfy(c => c.Should().MatchRegex("^[a-z2-9]{5}-[a-z2-9]{5}$"));

        var second = new SoftAuthenticator();
        (await AddPasskeyAsync(login, second)).Should().BeNull("only the first passkey comes with codes");

        var list = (await HttpApiFixture.ReadJsonAsync(
            await HttpApiFixture.SendAsync(login.Client, HttpMethod.Get, "/api/auth/passkeys", login.Token))).RootElement;
        list.GetProperty("passkeys").GetArrayLength().Should().Be(2);
        list.GetProperty("passkeys")[0].GetProperty("name").GetString().Should().Be("Chrome on Windows");
        list.GetProperty("passkeys")[0].GetProperty("createdUtc").GetString().Should().EndWith("Z");
        list.GetProperty("recoveryCodesLeft").GetInt32().Should().Be(RecoveryCodes.Count);
        await WaitForMailAsync(login.Email, "A passkey was added");
    }

    [Fact]
    public async Task A_password_sign_in_starts_no_session_until_the_passkey_answers()
    {
        using var login = await RegisterAsync();
        var authenticator = new SoftAuthenticator();
        await AddPasskeyAsync(login, authenticator);

        using var phone = _fixture.CreateClient();
        var step = await PasswordSignInAsync(phone, login);
        step.GetProperty("passkeyRequired").GetBoolean().Should().BeTrue();
        step.TryGetProperty("token", out _).Should().BeFalse("no session until the second step");
        (await phone.PostAsync("/api/auth/refresh", null)).StatusCode.Should().Be(HttpStatusCode.Unauthorized, "no cookie was set");
        (await SessionCountAsync(login)).Should().Be(1, "the phone isn't signed in yet");

        var ticket = step.GetProperty("ticket").GetString()!;
        var answer = await SecondStepAsync(phone, ticket, authenticator.Get(step.GetProperty("options").GetString()!));
        answer.StatusCode.Should().Be(HttpStatusCode.OK, await answer.Content.ReadAsStringAsync());
        var token = await TokenAsync(answer);
        (await HttpApiFixture.SendAsync(phone, HttpMethod.Get, "/api/auth/me", token)).StatusCode.Should().Be(HttpStatusCode.OK);
        (await SessionCountAsync(login)).Should().Be(2);

        // The ticket is spent: replaying the same answer gets nothing.
        var replay = await SecondStepAsync(phone, ticket, authenticator.Get(step.GetProperty("options").GetString()!));
        replay.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_passkey_alone_signs_in_and_each_ceremony_answers_once()
    {
        using var login = await RegisterAsync();
        var authenticator = new SoftAuthenticator();
        await AddPasskeyAsync(login, authenticator);

        using var laptop = _fixture.CreateClient();
        var (ceremony, options) = await CeremonyAsync(await laptop.PostAsync("/api/auth/passkey-sign-in/options", null));
        JsonDocument.Parse(options).RootElement.GetProperty("allowCredentials").GetArrayLength().Should().Be(0, "no login is named");
        var credential = authenticator.Get(options);

        var signIn = await laptop.PostAsJsonAsync("/api/auth/passkey-sign-in", new { ceremony, credential }, HttpApiFixture.Json);
        signIn.StatusCode.Should().Be(HttpStatusCode.OK, await signIn.Content.ReadAsStringAsync());
        (await HttpApiFixture.ReadJsonAsync(signIn)).RootElement.GetProperty("email").GetString().Should().Be(login.Email);

        var again = await laptop.PostAsJsonAsync("/api/auth/passkey-sign-in", new { ceremony, credential }, HttpApiFixture.Json);
        again.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task An_answer_from_another_site_or_with_the_wrong_key_is_refused()
    {
        using var login = await RegisterAsync();
        var authenticator = new SoftAuthenticator();
        await AddPasskeyAsync(login, authenticator);

        using var client = _fixture.CreateClient();
        var (c1, o1) = await CeremonyAsync(await client.PostAsync("/api/auth/passkey-sign-in/options", null));
        var phished = await client.PostAsJsonAsync("/api/auth/passkey-sign-in",
            new { ceremony = c1, credential = authenticator.Get(o1, origin: "https://allotjar.example") }, HttpApiFixture.Json);
        phished.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        var (c2, o2) = await CeremonyAsync(await client.PostAsync("/api/auth/passkey-sign-in/options", null));
        var forged = await client.PostAsJsonAsync("/api/auth/passkey-sign-in",
            new { ceremony = c2, credential = authenticator.Get(o2, useOtherKey: true) }, HttpApiFixture.Json);
        forged.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        // A stranger's passkey can't answer this login's second step either.
        var stranger = await RegisterAsync();
        using (stranger)
        {
            var theirs = new SoftAuthenticator();
            await AddPasskeyAsync(stranger, theirs);
            var step = await PasswordSignInAsync(client, login);
            var (c3, o3) = await CeremonyAsync(await client.PostAsync("/api/auth/passkey-sign-in/options", null));
            var wrongLogin = await SecondStepAsync(client, step.GetProperty("ticket").GetString()!, theirs.Get(o3));
            wrongLogin.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        }
    }

    [Fact]
    public async Task Five_wrong_answers_end_the_ticket()
    {
        using var login = await RegisterAsync();
        var authenticator = new SoftAuthenticator();
        await AddPasskeyAsync(login, authenticator);

        using var client = _fixture.CreateClient();
        var step = await PasswordSignInAsync(client, login);
        var ticket = step.GetProperty("ticket").GetString()!;
        var options = step.GetProperty("options").GetString()!;
        for (var i = 0; i < PasskeyCeremonies.MaxFailures; i++)
        {
            (await SecondStepAsync(client, ticket, authenticator.Get(options, useOtherKey: true))).StatusCode
                .Should().Be(HttpStatusCode.Unauthorized);
        }

        var right = await SecondStepAsync(client, ticket, authenticator.Get(options));
        right.StatusCode.Should().Be(HttpStatusCode.Unauthorized, "the ticket ended; sign-in starts over");
        (await HttpApiFixture.ReadJsonAsync(right)).RootElement.GetProperty("restart").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task A_recovery_code_stands_in_for_the_passkey_once()
    {
        using var login = await RegisterAsync();
        var codes = await AddPasskeyAsync(login, new SoftAuthenticator());

        using var client = _fixture.CreateClient();
        var step = await PasswordSignInAsync(client, login);
        var typed = codes![3].ToUpperInvariant().Replace("-", " ");
        var used = await client.PostAsJsonAsync("/api/auth/second-step/recovery-code",
            new { ticket = step.GetProperty("ticket").GetString(), code = typed }, HttpApiFixture.Json);
        used.StatusCode.Should().Be(HttpStatusCode.OK, await used.Content.ReadAsStringAsync());
        var token = await TokenAsync(used);
        await WaitForMailAsync(login.Email, "A recovery code was used");

        var left = (await HttpApiFixture.ReadJsonAsync(
            await HttpApiFixture.SendAsync(client, HttpMethod.Get, "/api/auth/passkeys", token))).RootElement;
        left.GetProperty("recoveryCodesLeft").GetInt32().Should().Be(RecoveryCodes.Count - 1);

        using var other = _fixture.CreateClient();
        var again = await PasswordSignInAsync(other, login);
        var reused = await other.PostAsJsonAsync("/api/auth/second-step/recovery-code",
            new { ticket = again.GetProperty("ticket").GetString(), code = codes[3] }, HttpApiFixture.Json);
        reused.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_password_reset_keeps_the_second_step()
    {
        using var login = await RegisterAsync();
        var authenticator = new SoftAuthenticator();
        await AddPasskeyAsync(login, authenticator);

        using var client = _fixture.CreateClient();
        (await client.PostAsJsonAsync("/api/auth/forgot-password", new { email = login.Email }, HttpApiFixture.Json))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);
        var link = await _fixture.WaitForEmailLinkAsync(login.Email, "/reset-password?");
        var reset = await HttpApiFixture.ResetFromLinkAsync(client, link, HttpApiFixture.StrongPassword());
        reset.StatusCode.Should().Be(HttpStatusCode.OK, await reset.Content.ReadAsStringAsync());
        var step = (await HttpApiFixture.ReadJsonAsync(reset)).RootElement;
        step.GetProperty("passkeyRequired").GetBoolean().Should().BeTrue();
        step.TryGetProperty("token", out _).Should().BeFalse("the inbox alone doesn't get past the passkey");

        var answer = await SecondStepAsync(client, step.GetProperty("ticket").GetString()!, authenticator.Get(step.GetProperty("options").GetString()!));
        answer.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Google_sign_in_asks_for_the_passkey_too()
    {
        using var client = _fixture.CreateClient();
        var email = $"pkg-{Guid.NewGuid():N}"[..16] + "@passkeys.test";
        var credential = "fake-google:" + JsonSerializer.Serialize(new { sub = $"g-{Guid.NewGuid():N}", email, emailVerified = true });
        var first = await client.PostAsJsonAsync("/api/auth/google", new { credential }, HttpApiFixture.Json);
        first.StatusCode.Should().Be(HttpStatusCode.OK);
        var login = new Login(client, email, string.Empty, await TokenAsync(first));
        var authenticator = new SoftAuthenticator();
        await AddPasskeyAsync(login, authenticator);

        using var other = _fixture.CreateClient();
        var again = await other.PostAsJsonAsync("/api/auth/google", new { credential }, HttpApiFixture.Json);
        var step = (await HttpApiFixture.ReadJsonAsync(again)).RootElement;
        step.GetProperty("passkeyRequired").GetBoolean().Should().BeTrue();
        (await SecondStepAsync(other, step.GetProperty("ticket").GetString()!, authenticator.Get(step.GetProperty("options").GetString()!)))
            .StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Changing_passkeys_long_after_signing_in_asks_for_proof()
    {
        using var login = await RegisterAsync();
        var authenticator = new SoftAuthenticator();
        var codes = await AddPasskeyAsync(login, authenticator);
        await AgeSignInsAsync(login.Email);

        // Nothing given: the answer says which proofs this login has.
        var bare = await HttpApiFixture.SendAsync(login.Client, HttpMethod.Post, "/api/auth/passkeys/options", login.Token, new { });
        bare.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        var kinds = (await HttpApiFixture.ReadJsonAsync(bare)).RootElement.GetProperty("proof");
        kinds.GetProperty("password").GetBoolean().Should().BeTrue();
        kinds.GetProperty("passkey").GetBoolean().Should().BeTrue();

        (await HttpApiFixture.SendAsync(login.Client, HttpMethod.Post, "/api/auth/passkeys/options", login.Token,
            new { proof = new { password = "Wrong-password-1" } })).StatusCode.Should().Be(HttpStatusCode.Forbidden);

        // The password proves it: a second passkey goes on.
        await AddPasskeyAsync(login, new SoftAuthenticator(), new { password = login.Password });

        // A passkey proves it: the first one is removed.
        var (ceremony, options) = await CeremonyAsync(await HttpApiFixture.SendAsync(
            login.Client, HttpMethod.Post, "/api/auth/passkeys/proof-options", login.Token));
        var firstId = authenticator.LastId;
        var remove = await HttpApiFixture.SendAsync(login.Client, HttpMethod.Post, $"/api/auth/passkeys/{firstId}/remove", login.Token,
            new { proof = new { ceremony, credential = authenticator.Get(options) } });
        remove.StatusCode.Should().Be(HttpStatusCode.NoContent, await remove.Content.ReadAsStringAsync());

        // A recovery code proves it (and is used up): new codes replace the old.
        var replaced = await HttpApiFixture.SendAsync(login.Client, HttpMethod.Post, "/api/auth/passkeys/recovery-codes", login.Token,
            new { proof = new { recoveryCode = codes![0] } });
        replaced.StatusCode.Should().Be(HttpStatusCode.OK, await replaced.Content.ReadAsStringAsync());
        var fresh = (await HttpApiFixture.ReadJsonAsync(replaced)).RootElement.GetProperty("recoveryCodes")
            .EnumerateArray().Select(c => c.GetString()!).ToList();
        fresh.Should().HaveCount(RecoveryCodes.Count).And.NotIntersectWith(codes);
        await WaitForMailAsync(login.Email, "New recovery codes");
    }

    [Fact]
    public async Task Removing_the_last_passkey_switches_the_second_step_off()
    {
        using var login = await RegisterAsync();
        var authenticator = new SoftAuthenticator();
        await AddPasskeyAsync(login, authenticator);

        var remove = await HttpApiFixture.SendAsync(login.Client, HttpMethod.Post,
            $"/api/auth/passkeys/{authenticator.LastId}/remove", login.Token, new { });
        remove.StatusCode.Should().Be(HttpStatusCode.NoContent, await remove.Content.ReadAsStringAsync());
        await WaitForMailAsync(login.Email, "A passkey was removed");

        using var client = _fixture.CreateClient();
        var signIn = await PasswordSignInAsync(client, login);
        signIn.TryGetProperty("token", out _).Should().BeTrue("no passkey, no second step");

        var list = (await HttpApiFixture.ReadJsonAsync(
            await HttpApiFixture.SendAsync(login.Client, HttpMethod.Get, "/api/auth/passkeys", login.Token))).RootElement;
        list.GetProperty("recoveryCodesLeft").GetInt32().Should().Be(0);
    }

    [Fact]
    public async Task One_login_cannot_finish_a_passkey_another_started()
    {
        using var owner = await RegisterAsync();
        using var other = await RegisterAsync();
        var (ceremony, options) = await CeremonyAsync(await HttpApiFixture.SendAsync(
            owner.Client, HttpMethod.Post, "/api/auth/passkeys/options", owner.Token, new { }));

        var hijack = await HttpApiFixture.SendAsync(other.Client, HttpMethod.Post, "/api/auth/passkeys", other.Token,
            new { ceremony, credential = new SoftAuthenticator().Create(options) });
        hijack.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
}

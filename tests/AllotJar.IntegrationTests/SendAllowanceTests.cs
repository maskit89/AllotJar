using FluentAssertions;
using Microsoft.Extensions.Configuration;
using AllotJar.Api.Services;
using AllotJar.Infrastructure.Identity;

namespace AllotJar.IntegrationTests;

/// <summary>The in-memory send allowances and the passkey ceremony cap (security review #6, #7).</summary>
public class SendAllowanceTests
{
    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = new(2026, 11, 3, 9, 0, 0, TimeSpan.Zero);

        public override DateTimeOffset GetUtcNow() => Now;
    }

    private static IConfiguration Settings(Dictionary<string, string?>? values = null) =>
        new ConfigurationBuilder().AddInMemoryCollection(values ?? new()).Build();

    [Fact]
    public void An_invite_allowance_gives_ten_a_day_per_household_and_frees_them_a_day_later()
    {
        var clock = new Clock();
        var allowance = new InviteEmailAllowance(clock, Settings());

        for (var i = 0; i < 10; i++)
        {
            allowance.TryClaim("household-a").Should().BeTrue();
        }
        allowance.TryClaim("household-a").Should().BeFalse();
        allowance.TryClaim("household-b").Should().BeTrue("each household has its own allowance");

        clock.Now += TimeSpan.FromHours(23);
        allowance.TryClaim("household-a").Should().BeFalse();
        clock.Now += TimeSpan.FromHours(1);
        allowance.TryClaim("household-a").Should().BeTrue();
    }

    [Fact]
    public void A_released_claim_does_not_count()
    {
        var allowance = new PasswordLinkAllowance(new Clock(), Settings());
        allowance.TryClaim("login").Should().BeTrue();
        allowance.TryClaim("login").Should().BeTrue();
        allowance.TryClaim("login").Should().BeTrue();
        allowance.TryClaim("login").Should().BeFalse();

        allowance.Release("login");
        allowance.TryClaim("login").Should().BeTrue();
    }

    [Fact]
    public void Password_links_free_up_fifteen_minutes_after_each_was_sent()
    {
        var clock = new Clock();
        var allowance = new PasswordLinkAllowance(clock, Settings());
        allowance.TryClaim("login").Should().BeTrue();
        clock.Now += TimeSpan.FromMinutes(5);
        allowance.TryClaim("login").Should().BeTrue();
        allowance.TryClaim("login").Should().BeTrue();
        allowance.TryClaim("login").Should().BeFalse();

        clock.Now += TimeSpan.FromMinutes(10); // the first is now 15 minutes old
        allowance.TryClaim("login").Should().BeTrue();
        allowance.TryClaim("login").Should().BeFalse();
    }

    [Fact]
    public void The_allowance_tracks_at_most_its_cap_of_keys_and_forgets_them_once_they_age_out()
    {
        var clock = new Clock();
        var allowance = new PasswordLinkAllowance(clock, Settings());
        for (var i = 0; i < allowance.MaxKeys; i++)
        {
            allowance.TryClaim($"login-{i}").Should().BeTrue();
        }
        allowance.TryClaim("one-too-many").Should().BeFalse("the store refuses rather than grow");
        allowance.TryClaim("login-0").Should().BeTrue("a key already tracked still has its own room");

        clock.Now += TimeSpan.FromMinutes(16);
        allowance.TryClaim("one-too-many").Should().BeTrue("aged-out keys were pruned");
    }

    [Fact]
    public void The_limits_can_be_raised_in_configuration()
    {
        var allowance = new InviteEmailAllowance(new Clock(), Settings(new() { ["Limits:InviteEmailsPerDay"] = "50" }));
        allowance.Limit.Should().Be(50);
    }

    [Fact]
    public void Anonymous_passkey_sign_ins_are_refused_past_the_cap_until_old_ones_expire()
    {
        var clock = new Clock();
        var ceremonies = new PasskeyCeremonies(clock);
        for (var i = 0; i < PasskeyCeremonies.MaxSignInEntries; i++)
        {
            ceremonies.Start(PasskeyCeremonyKind.SignIn, null, "state");
        }

        var refused = () => ceremonies.Start(PasskeyCeremonyKind.SignIn, null, "state");
        refused.Should().Throw<PasskeyCeremoniesBusyException>();

        clock.Now += PasskeyCeremonies.Lifetime;
        ceremonies.Start(PasskeyCeremonyKind.SignIn, null, "state").Should().NotBeEmpty();
    }

    [Theory]
    [InlineData(PasskeyCeremonyKind.SecondStep)]
    [InlineData(PasskeyCeremonyKind.Register)]
    [InlineData(PasskeyCeremonyKind.Proof)]
    public void A_store_full_of_anonymous_sign_ins_never_blocks_a_signed_in_or_second_step_ceremony(PasskeyCeremonyKind kind)
    {
        // #423 review P2-1: a flood of anonymous starts must not lock out logins that use 2FA.
        var ceremonies = new PasskeyCeremonies(new Clock());
        for (var i = 0; i < PasskeyCeremonies.MaxSignInEntries; i++)
        {
            ceremonies.Start(PasskeyCeremonyKind.SignIn, null, "state");
        }

        var id = ceremonies.Start(kind, "user-1", "state");
        ceremonies.Find(id, kind).Should().NotBeNull();
    }
}

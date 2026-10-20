using FluentAssertions;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Retention;

namespace AllotJar.Application.Tests.Infrastructure;

/// <summary>
/// The privacy policy (client/src/pages/PrivacyPage.tsx, SIGN_IN_RECORD_DAYS and INVITE_GRACE_DAYS)
/// states how long sign-in records and unaccepted invitations are kept, and LegalPages.test.tsx
/// checks the published text. These fail when a constant changes, so the policy changes with it.
/// </summary>
public class RetentionPolicyGuardTests
{
    [Fact]
    public void A_sign_in_record_is_gone_within_31_days_of_its_last_use()
    {
        // A token expires at most LifetimeDays after the use that minted it; the purge runs daily.
        (RefreshTokenService.LifetimeDays + 1).Should().Be(31,
            "PrivacyPage.tsx says a sign-in's record is deleted within 31 days of its last use: update SIGN_IN_RECORD_DAYS too");
    }

    [Fact]
    public void An_unaccepted_invitation_is_deleted_30_days_after_its_link_expires()
    {
        ExpiredRecordsPurge.InviteGraceDays.Should().Be(30,
            "PrivacyPage.tsx says an unaccepted invitation is deleted 30 days after its link expires: update INVITE_GRACE_DAYS too");
    }
}

using FluentAssertions;
using Xunit;
using AllotJar.Infrastructure.Identity;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The rule that turns a stateless JWT into a revocable one: a token is accepted only if its baked
/// security stamp still matches the user's current stamp — except legacy tokens (no stamp) which
/// are grandfathered so a rollout doesn't sign everyone out.
/// </summary>
public class SecurityStampValidationTests
{
    [Fact]
    public void Legacy_token_without_a_stamp_is_allowed()
    {
        SecurityStampValidation.IsValid(tokenStamp: null, currentStamp: "abc").Should().BeTrue();
        SecurityStampValidation.IsValid(tokenStamp: "", currentStamp: "abc").Should().BeTrue();
    }

    [Fact]
    public void Matching_stamp_is_allowed()
    {
        SecurityStampValidation.IsValid("abc123", "abc123").Should().BeTrue();
    }

    [Fact]
    public void Rotated_stamp_revokes_the_token()
    {
        // Password change / sign-out-everywhere rotated the stamp -> old token no longer matches.
        SecurityStampValidation.IsValid("old-stamp", "new-stamp").Should().BeFalse();
    }

    [Fact]
    public void A_stamped_token_against_a_missing_current_stamp_is_rejected()
    {
        SecurityStampValidation.IsValid("abc123", null).Should().BeFalse();
        SecurityStampValidation.IsValid("abc123", "").Should().BeFalse();
    }
}

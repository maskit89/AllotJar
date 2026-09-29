using FluentAssertions;
using AllotJar.Infrastructure.Identity;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The rule that turns a stateless JWT into a revocable one: a token is accepted only if its baked
/// security stamp still matches the user's current stamp — except legacy tokens (no stamp) which
/// are grandfathered so a rollout doesn't sign everyone out.
/// </summary>
public class SecurityStampValidationTests
{
    [Theory]
    [InlineData(null, "abc", true)]         // legacy token without a stamp: grandfathered
    [InlineData("", "abc", true)]
    [InlineData("abc123", "abc123", true)]  // matching stamp
    [InlineData("old-stamp", "new-stamp", false)] // password change / sign-out-everywhere rotated it
    [InlineData("abc123", null, false)]     // a stamped token against a missing current stamp
    [InlineData("abc123", "", false)]
    public void A_token_is_valid_only_while_its_stamp_matches(string? tokenStamp, string? currentStamp, bool valid) =>
        SecurityStampValidation.IsValid(tokenStamp, currentStamp).Should().Be(valid);
}

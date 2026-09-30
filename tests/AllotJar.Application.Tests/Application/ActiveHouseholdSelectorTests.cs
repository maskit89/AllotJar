using FluentAssertions;
using AllotJar.Application.Common.Households;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Which household a login acts in: its selected one if still accessible, else its own, else the first.
/// </summary>
public class ActiveHouseholdSelectorTests
{
    private static HouseholdMembershipRef M(string ownerId, HouseholdRole role = HouseholdRole.Admin) =>
        new(ownerId, role, null);

    [Fact]
    public void Picks_the_active_household_when_the_pointer_matches()
    {
        var memberships = new[] { M("u1", HouseholdRole.Owner), M("owner-a") };
        ActiveHouseholdSelector.Pick(memberships, "owner-a", "u1")!.Value.OwnerId.Should().Be("owner-a");
    }

    [Fact]
    public void Falls_back_to_own_household_when_no_active_pointer()
    {
        var memberships = new[] { M("owner-a"), M("u1", HouseholdRole.Owner) };
        ActiveHouseholdSelector.Pick(memberships, null, "u1")!.Value.OwnerId.Should().Be("u1");
    }

    [Fact]
    public void Falls_back_to_own_household_when_the_pointer_is_stale()
    {
        var memberships = new[] { M("owner-a"), M("u1", HouseholdRole.Owner) };
        ActiveHouseholdSelector.Pick(memberships, "gone", "u1")!.Value.OwnerId.Should().Be("u1");
    }

    [Fact]
    public void Falls_back_to_the_first_when_neither_active_nor_own_match()
    {
        var memberships = new[] { M("owner-a"), M("owner-b") };
        ActiveHouseholdSelector.Pick(memberships, "gone", "u1")!.Value.OwnerId.Should().Be("owner-a");
    }

    [Fact]
    public void Returns_null_when_there_are_no_memberships()
    {
        ActiveHouseholdSelector.Pick(Array.Empty<HouseholdMembershipRef>(), "x", "u1").Should().BeNull();
    }
}

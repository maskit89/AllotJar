using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using AllotJar.Domain.Entities;

namespace AllotJar.Infrastructure.Persistence.Configurations;

public class HouseholdMembershipConfiguration : IEntityTypeConfiguration<HouseholdMembership>
{
    public void Configure(EntityTypeBuilder<HouseholdMembership> builder)
    {
        builder.ToTable("HouseholdMemberships");
        builder.HasKey(m => m.Id);

        builder.Property(m => m.OwnerId)
            .IsRequired()
            .HasMaxLength(450);

        builder.Property(m => m.UserId)
            .HasMaxLength(450);

        builder.Property(m => m.InvitedEmail)
            .IsRequired()
            .HasMaxLength(256);

        builder.Property(m => m.DisplayName)
            .HasMaxLength(120);

        builder.Property(m => m.InviteTokenHash)
            .HasMaxLength(200);

        // The household a request belongs to is looked up by OwnerId.
        builder.HasIndex(m => m.OwnerId);

        // A login may belong to several households (one membership per household), but only one
        // per household — so the pair is unique, not the login on its own.
        builder.HasIndex(m => new { m.OwnerId, m.UserId })
            .IsUnique()
            .HasFilter("[UserId] IS NOT NULL");

        // The resolution middleware looks a login's memberships up by UserId every request.
        builder.HasIndex(m => m.UserId);

        // A budget person (member) is claimed by at most one login — the link is 1:1.
        builder.HasIndex(m => m.MemberId)
            .IsUnique()
            .HasFilter("[MemberId] IS NOT NULL");

        // Invite-link redemption looks up the membership by token hash.
        builder.HasIndex(m => m.InviteTokenHash)
            .HasFilter("[InviteTokenHash] IS NOT NULL");
    }
}

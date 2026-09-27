using FluentValidation;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars;

/// <summary>The fields that define how a jar saves — shared by create, update and the schedule preview.</summary>
public interface IJarDefinition
{
    JarKind Kind { get; }
    decimal TargetAmount { get; }
    DateOnly? TargetDate { get; }
    AccrualMethod Accrual { get; }
    decimal? MonthlyContribution { get; }
    bool IncludeDeadlineMonth { get; }
    int? RecurMonths { get; }
}

public static class JarDefinitionRules
{
    // Mirrors the decimal(18,4) range used elsewhere (e.g. account opening balance).
    public const decimal MaxAmount = 99_999_999_999_999.9999m;

    /// <summary>
    /// Rules 16–17: a jar with a target saves by a deadline or at a fixed monthly amount; an
    /// ongoing jar saves a fixed monthly amount with no target; a recurring jar always saves by
    /// its due date. No twelve-month default is implied by a missing deadline.
    /// </summary>
    public static void JarDefinition<T>(this AbstractValidator<T> validator) where T : IJarDefinition
    {
        validator.RuleFor(x => x.Kind).IsInEnum();
        validator.RuleFor(x => x.Accrual).IsInEnum()
            .WithMessage("Choose how to save: by a deadline, or a fixed amount each month.");

        validator.RuleFor(x => x.TargetAmount)
            .InclusiveBetween(0m, MaxAmount)
            .WithMessage("Target amount is out of range.");

        validator.RuleFor(x => x.MonthlyContribution)
            .InclusiveBetween(0m, MaxAmount)
            .When(x => x.MonthlyContribution.HasValue)
            .WithMessage("Monthly amount is out of range.");

        // Deadline plans: a target and the date it is needed by (rule 17).
        validator.RuleFor(x => x.TargetAmount)
            .GreaterThan(0m)
            .When(x => x.Accrual == AccrualMethod.TargetByDate)
            .WithMessage("A deadline needs a target amount to save toward.");
        validator.RuleFor(x => x.TargetDate)
            .NotNull()
            .When(x => x.Accrual == AccrualMethod.TargetByDate)
            .WithMessage("Give the jar a deadline, or save a fixed amount each month instead.");

        // Fixed monthly plans: the amount, and no deadline (a deadline would make it a deadline plan).
        validator.RuleFor(x => x.MonthlyContribution)
            .Must(m => m is > 0m)
            .When(x => x.Accrual == AccrualMethod.FixedMonthly)
            .WithMessage("Enter the amount to set aside each month.");
        validator.RuleFor(x => x.TargetDate)
            .Null()
            .When(x => x.Accrual == AccrualMethod.FixedMonthly)
            .WithMessage("A fixed monthly plan has no deadline. Remove the date, or save by the deadline instead.");

        // A recurring jar re-arms at its due date, so it always saves toward one.
        validator.RuleFor(x => x.Accrual)
            .Equal(AccrualMethod.TargetByDate)
            .When(x => x.Kind == JarKind.Recurring)
            .WithMessage("A recurring jar saves toward its next due date.");

        // The recurrence cycle, when set, is bounded.
        validator.RuleFor(x => x.RecurMonths)
            .InclusiveBetween(1, 120)
            .When(x => x.RecurMonths.HasValue)
            .WithMessage("Repeat cycle must be between 1 and 120 months.");
    }
}

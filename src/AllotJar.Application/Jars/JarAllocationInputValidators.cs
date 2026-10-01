using FluentValidation;
using AllotJar.Application.Common;

namespace AllotJar.Application.Jars;

/// <summary>Shared shape rules for the incoming-money prompt's answer (rule 78) and the outgoing "paid from" choice (rule 79).</summary>
public static class JarAllocationInputValidators
{
    public static IRuleBuilderOptions<T, IReadOnlyList<JarAllocationInput>?> JarAllocationsWellFormed<T>(
        this IRuleBuilder<T, IReadOnlyList<JarAllocationInput>?> rule) =>
        rule
            .Must(list => list is null || list.All(i => i.JarId != Guid.Empty))
            .WithMessage("Choose a jar for each amount.")
            .Must(list => list is null || list.All(i => i.Amount >= 0m))
            .WithMessage("Jar amounts must be zero or more.")
            .Must(list => list is null || list.Count <= 200)
            .WithMessage("Too many jar amounts.");

    /// <summary>Each jar amount a new entry divides is whole cents (D1); an edit may send stored ones back.</summary>
    public static IRuleBuilderOptions<T, IReadOnlyList<JarAllocationInput>?> JarAllocationsInCents<T>(
        this IRuleBuilder<T, IReadOnlyList<JarAllocationInput>?> rule) =>
        rule
            .Must(list => list is null || list.All(i => MoneyInput.IsWholeCents(i.Amount)))
            .WithMessage(MoneyInput.TooPrecise);
}

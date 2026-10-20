namespace AllotJar.Domain.Common;

/// <summary>
/// Marks text a person types or a bank statement supplies (payees, notes, names). Every save
/// masks any card number in it (<see cref="Services.CardNumberMask"/>), so none is ever stored
/// (compliance fix 12). Never on a bank reference: those identify statement entries for import
/// duplicate detection and transfer matching, and masking could make two of them equal.
/// </summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class MaskCardNumbersAttribute : Attribute
{
}

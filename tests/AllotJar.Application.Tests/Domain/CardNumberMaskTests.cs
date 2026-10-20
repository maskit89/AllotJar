using FluentAssertions;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Tests.Domain;

/// <summary>
/// Compliance fix 12: a card number (a scheme's prefix and length, and the Luhn check) is masked
/// to its last four digits; other long numbers are left alone.
/// </summary>
public class CardNumberMaskTests
{
    [Theory]
    [InlineData("AMAZON 4111111111111111", "AMAZON ••••••••••••1111")]
    [InlineData("card 4111 1111 1111 1111 paid", "card •••• •••• •••• 1111 paid")]
    [InlineData("card 4111-1111-1111-1111", "card ••••-••••-••••-1111")]
    [InlineData("AMEX 3782 822463 10005", "AMEX •••• •••••• •0005")]
    [InlineData("19 digits 4532015112830366120", "19 digits •••••••••••••••6120")]
    [InlineData("4111111111111111", "••••••••••••1111")]
    [InlineData("VISA4111111111111111", "VISA••••••••••••1111")]
    [InlineData("two 4111111111111111 and 5555555555554444", "two ••••••••••••1111 and ••••••••••••4444")]
    [InlineData("card 4111  1111  1111  1111", "card ••••  ••••  ••••  1111")]
    [InlineData("card 4111\u00A01111\u00A01111\u00A01111", "card ••••\u00A0••••\u00A0••••\u00A01111")]
    [InlineData("card 4111.1111.1111.1111", "card ••••.••••.••••.1111")]
    [InlineData("GB29 NWBK 6016 1331 9268 19 4111 1111 1111 1111", "GB29 NWBK 6016 1331 9268 19 •••• •••• •••• 1111")]
    [InlineData("DE62370400440532013001 4111111111111111", "DE62370400440532013001 ••••••••••••1111")]
    public void MasksACardNumber_ToItsLastFourDigits(string text, string expected)
    {
        var masked = CardNumberMask.Mask(text);

        masked.Should().Be(expected);
        masked!.Length.Should().Be(text.Length, "masked text fits wherever the original fitted");
        CardNumberMask.HasCardNumber(text).Should().BeTrue();
    }

    [Fact]
    public void FindsTheCard_InsideALongerRunOfGroups()
    {
        // The expiry printed after the card is a group of its own and stays.
        CardNumberMask.Mask("4111 1111 1111 1111 0428").Should().Be("•••• •••• •••• 1111 0428");
    }

    [Theory]
    [InlineData("TESCO STORES 4111111111111112")] // fails the Luhn check
    [InlineData("POS 2026-10-20 0012344")] // a date and a reference: Luhn-valid together, no card prefix
    [InlineData("Loan 1234567890128")] // Luhn-valid, but no scheme issues 12...
    [InlineData("Ref 9 4111 11111 11111 11")] // a card-valid stretch of a longer run, grouped as no card is printed
    [InlineData("Mandate 3704004405320131")] // Luhn-valid, Amex prefix at a length Amex never issues
    [InlineData("REF 123456789012")] // 12 digits: too short for a card
    [InlineData("MANDATE 41111111111111110000")] // 20 digits written together: not a card
    [InlineData("Paid 1,234.56 on 2026-10-20")]
    [InlineData("HSBC •••• •••• •••• 4242")]
    [InlineData("")]
    [InlineData("Rent")]
    public void LeavesOtherText_AsItIs(string text)
    {
        var masked = CardNumberMask.Mask(text);

        masked.Should().BeSameAs(text);
        CardNumberMask.HasCardNumber(text).Should().BeFalse();
    }

    [Fact]
    public void LeavesNull_AsNull() => CardNumberMask.Mask(null).Should().BeNull();

    [Theory]
    // The 18 digits after the check digits pass the Luhn check, so only the IBAN check keeps them.
    [InlineData("SEPA DE62 3704 0044 0532 0130 01 rent")]
    [InlineData("SEPA de62 3704 0044 0532 0130 01")]
    [InlineData("to DE62370400440532013001")]
    [InlineData("GB82 WEST 1234 5698 7654 32")]
    public void LeavesAValidIban_AsItIs(string text) => CardNumberMask.Mask(text).Should().BeSameAs(text);

    [Fact]
    public void ReadsTheDigits_OfAnIbanShapeWhoseChecksumFails_AsAnyOtherNumber()
    {
        // DE63 is not this account's check, so these are just digits; they fit no card scheme.
        CardNumberMask.Mask("DE63 3704 0044 0532 0130 01").Should().Be("DE63 3704 0044 0532 0130 01");
        CardNumberMask.Mask("DE63 4111 1111 1111 1111").Should().Be("DE63 •••• •••• •••• 1111");
    }

    [Fact]
    public void MaskingTwice_ChangesNothing()
    {
        var once = CardNumberMask.Mask("card 4111 1111 1111 1111");

        CardNumberMask.Mask(once).Should().BeSameAs(once);
    }

    [Theory]
    [InlineData("4111111111111111", true)]
    [InlineData("378282246310005", true)]
    [InlineData("4111111111111112", false)]
    public void PassesLuhn_IsTheStandardCheck(string digits, bool valid) =>
        CardNumberMask.PassesLuhn(digits).Should().Be(valid);

    [Theory]
    [InlineData("4111111111111111", true)] // Visa 16
    [InlineData("4222222222222", true)] // Visa 13
    [InlineData("5555555555554444", true)] // Mastercard
    [InlineData("2223003122003222", true)] // Mastercard 2-series
    [InlineData("378282246310005", true)] // American Express
    [InlineData("6011111111111117", true)] // Discover
    [InlineData("30569309025904", true)] // Diners Club
    [InlineData("3530111333300000", true)] // JCB
    [InlineData("6200000000000005", true)] // UnionPay
    [InlineData("41111111111114", false)] // Luhn-valid Visa prefix, 14 digits: Visa issues none
    [InlineData("1234567890128", false)] // Luhn-valid, no scheme
    [InlineData("4111111111111112", false)] // fails Luhn
    [InlineData("41111111111", false)] // too short
    public void IsCardNumber_NeedsASchemesPrefixAndLength_AndTheLuhnCheck(string digits, bool card) =>
        CardNumberMask.IsCardNumber(digits).Should().Be(card);
}

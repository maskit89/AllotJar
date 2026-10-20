using MediatR;

namespace AllotJar.Application.Export;

/// <summary>
/// "Download my data" (compliance fix 4, the privacy policy's right of access and portability):
/// everything the signed-in login can see in the household it is viewing, as the app's own reads
/// return it. Read-only; private accounts of other logins stay out exactly as they do on screen
/// (rules 31–33, P53/P56/P59). <paramref name="Profile"/> is the login's own identity, which the
/// API layer reads from Identity.
/// </summary>
public record ExportMyDataQuery(ExportProfile Profile, DateOnly? AsOf = null) : IRequest<DataExport>;

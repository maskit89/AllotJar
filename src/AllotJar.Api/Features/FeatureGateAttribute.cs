using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Options;

namespace AllotJar.Api.Features;

/// <summary>
/// Short-circuits an action (or every action on a controller) with 404 when its
/// feature flag is off, so a disabled feature's API can't be used even though the UI
/// already hides it.
/// </summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method)]
public sealed class FeatureGateAttribute : Attribute, IAsyncActionFilter
{
    private readonly string _feature;

    public FeatureGateAttribute(string feature) => _feature = feature;

    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        var flags = context.HttpContext.RequestServices
            .GetRequiredService<IOptionsSnapshot<FeatureFlags>>().Value;

        if (!flags.IsEnabled(_feature))
        {
            context.Result = new NotFoundResult();
            return;
        }

        await next();
    }
}

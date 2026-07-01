using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using AllotJar.Api.Features;

namespace AllotJar.Api.Controllers;

/// <summary>
/// Exposes the feature toggles the client should respect. Non-sensitive, so this is
/// anonymous — the SPA reads it before deciding which nav links, routes and controls
/// to show.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class FeaturesController : ControllerBase
{
    private readonly FeatureFlags _flags;

    public FeaturesController(IOptionsSnapshot<FeatureFlags> flags)
    {
        _flags = flags.Value;
    }

    [HttpGet]
    [ProducesResponseType(typeof(FeatureFlags), StatusCodes.Status200OK)]
    public ActionResult<FeatureFlags> Get() => Ok(_flags);
}

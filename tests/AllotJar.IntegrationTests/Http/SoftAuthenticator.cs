using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// A software passkey authenticator for the HTTP tests: answers WebAuthn creation and request
/// options the way a phone or password manager would (ES256, "none" attestation, user verified,
/// synced), and produces the PublicKeyCredential JSON the browser's toJSON() gives. It can also be
/// made to lie (another site's origin, a wrong key) to prove the server refuses it.
/// </summary>
internal sealed class SoftAuthenticator
{
    public const string Origin = "http://localhost";

    private sealed record Credential(byte[] Id, ECDsa Key, string RpId, byte[] UserHandle);

    private readonly List<Credential> _credentials = [];

    public int Count => _credentials.Count;

    /// <summary>The credential id of the newest passkey, base64url (as the API lists it).</summary>
    public string LastId => B64(_credentials[^1].Id);

    /// <summary>Answers creation options (JSON) with a new passkey: the attestation credential JSON.</summary>
    public string Create(string creationOptionsJson, string origin = Origin)
    {
        var options = JsonNode.Parse(creationOptionsJson)!;
        var challenge = options["challenge"]!.GetValue<string>();
        var rpId = options["rp"]!["id"]!.GetValue<string>();
        var userHandle = FromB64(options["user"]!["id"]!.GetValue<string>());

        var id = RandomNumberGenerator.GetBytes(16);
        var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        _credentials.Add(new Credential(id, key, rpId, userHandle));

        var p = key.ExportParameters(false);
        var cose = Cbor.Map(
            (Cbor.Int(1), Cbor.Int(2)), // kty: EC2
            (Cbor.Int(3), Cbor.Int(-7)), // alg: ES256
            (Cbor.Int(-1), Cbor.Int(1)), // crv: P-256
            (Cbor.Int(-2), Cbor.Bytes(p.Q.X!)),
            (Cbor.Int(-3), Cbor.Bytes(p.Q.Y!)));
        var authData = Concat(
            SHA256.HashData(Encoding.UTF8.GetBytes(rpId)),
            [Flags | 0x40], // + attested credential data
            [0, 0, 0, 0],
            new byte[16], // AAGUID
            [(byte)(id.Length >> 8), (byte)id.Length],
            id,
            cose);
        var attestationObject = Cbor.Map(
            (Cbor.Text("fmt"), Cbor.Text("none")),
            (Cbor.Text("attStmt"), Cbor.Map()),
            (Cbor.Text("authData"), Cbor.Bytes(authData)));
        var clientData = ClientData("webauthn.create", challenge, origin);

        return JsonSerializer.Serialize(new
        {
            id = B64(id),
            rawId = B64(id),
            type = "public-key",
            authenticatorAttachment = "platform",
            clientExtensionResults = new { },
            response = new
            {
                clientDataJSON = B64(clientData),
                attestationObject = B64(attestationObject),
                transports = new[] { "internal", "hybrid" },
            },
        });
    }

    /// <summary>
    /// Answers request options (JSON) with a passkey for its site: one the options allow when they
    /// name some, else this authenticator's newest. <paramref name="useOtherKey"/> signs with a key
    /// the server never saw, as a forged answer would.
    /// </summary>
    public string Get(string requestOptionsJson, string origin = Origin, bool useOtherKey = false)
    {
        var options = JsonNode.Parse(requestOptionsJson)!;
        var challenge = options["challenge"]!.GetValue<string>();
        var rpId = options["rpId"]!.GetValue<string>();
        var allowed = (options["allowCredentials"] as JsonArray ?? [])
            .Select(c => c!["id"]!.GetValue<string>())
            .ToHashSet();
        var credential = _credentials.LastOrDefault(c => c.RpId == rpId && (allowed.Count == 0 || allowed.Contains(B64(c.Id))))
            ?? throw new InvalidOperationException("No passkey for these options.");

        var authData = Concat(SHA256.HashData(Encoding.UTF8.GetBytes(rpId)), [Flags], [0, 0, 0, 0]);
        var clientData = ClientData("webauthn.get", challenge, origin);
        var key = useOtherKey ? ECDsa.Create(ECCurve.NamedCurves.nistP256) : credential.Key;
        var signature = key.SignData(
            Concat(authData, SHA256.HashData(clientData)), HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);

        return JsonSerializer.Serialize(new
        {
            id = B64(credential.Id),
            rawId = B64(credential.Id),
            type = "public-key",
            authenticatorAttachment = "platform",
            clientExtensionResults = new { },
            response = new
            {
                clientDataJSON = B64(clientData),
                authenticatorData = B64(authData),
                signature = B64(signature),
                userHandle = B64(credential.UserHandle),
            },
        });
    }

    // User present, user verified, backup eligible, backed up: a synced passkey.
    private const byte Flags = 0x01 | 0x04 | 0x08 | 0x10;

    private static byte[] ClientData(string type, string challenge, string origin) =>
        JsonSerializer.SerializeToUtf8Bytes(new { type, challenge, origin, crossOrigin = false });

    private static byte[] Concat(params byte[][] parts) => parts.SelectMany(b => b).ToArray();

    public static string B64(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] FromB64(string value)
    {
        var s = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s.PadRight(s.Length + (4 - s.Length % 4) % 4, '='));
    }

    /// <summary>Just enough CBOR (RFC 8949) for an attestation object and a COSE key.</summary>
    private static class Cbor
    {
        public static byte[] Int(long value) =>
            value >= 0 ? Head(0, (ulong)value) : Head(1, (ulong)(-1 - value));

        public static byte[] Bytes(byte[] value) => [.. Head(2, (ulong)value.Length), .. value];

        public static byte[] Text(string value)
        {
            var utf8 = Encoding.UTF8.GetBytes(value);
            return [.. Head(3, (ulong)utf8.Length), .. utf8];
        }

        public static byte[] Map(params (byte[] Key, byte[] Value)[] entries) =>
            [.. Head(5, (ulong)entries.Length), .. entries.SelectMany(e => e.Key.Concat(e.Value))];

        private static byte[] Head(int major, ulong value)
        {
            var m = (byte)(major << 5);
            return value switch
            {
                < 24 => [(byte)(m | (byte)value)],
                <= byte.MaxValue => [(byte)(m | 24), (byte)value],
                <= ushort.MaxValue => [(byte)(m | 25), (byte)(value >> 8), (byte)value],
                _ => [(byte)(m | 26), (byte)(value >> 24), (byte)(value >> 16), (byte)(value >> 8), (byte)value],
            };
        }
    }
}

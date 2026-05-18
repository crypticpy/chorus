/**
 * HMAC verification for inbound GitHub App webhooks.
 *
 * GitHub signs every webhook delivery with the secret you configured
 * for the App, and sends the digest as `X-Hub-Signature-256: sha256=<hex>`.
 * If we accept a delivery without verifying that header, anyone who can
 * reach our webhook URL can forge events — including "PR merged" or
 * "comment added" events that drive the babysit loop. The webhook URL
 * is meant to be publicly reachable, so signature verification is the
 * only thing standing between us and arbitrary takeover of the loop.
 *
 * Two non-obvious correctness points:
 *
 *   1. Compare with `crypto.timingSafeEqual`, not `===`. String equality
 *      short-circuits on the first byte mismatch; an attacker can use the
 *      timing difference to recover the signature one byte at a time.
 *      `timingSafeEqual` requires equal-length buffers and runs in constant
 *      time over those bytes.
 *
 *   2. Hash the RAW request body — the exact bytes GitHub sent, before
 *      JSON parsing. Re-stringifying after parse will reorder keys,
 *      normalize whitespace, or lose number precision, and the digest
 *      will no longer match. Fastify's body parser exposes the raw buffer
 *      via `request.rawBody` only when explicitly configured; the route
 *      handler that calls this helper is responsible for capturing the
 *      buffer before it hits JSON.parse.
 *
 * Webhooks are NOT wired up this session — the daemon only polls. We
 * still write the verifier now because shipping the route without it
 * later is a sharp footgun, and the helper is small + pure-crypto.
 */
import * as crypto from "crypto";

/** Header name GitHub uses for the sha256 HMAC digest. */
export const SIGNATURE_HEADER = "x-hub-signature-256";

/** Prefix that precedes the hex digest in the header value. */
const SIGNATURE_PREFIX = "sha256=";

export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: VerifyFailureReason };

export type VerifyFailureReason =
  | "missing_signature"
  | "malformed_signature"
  | "secret_not_configured"
  | "mismatch";

/**
 * Verify the `X-Hub-Signature-256` header against the raw request body.
 *
 * Returns a discriminated union so the caller can log the precise reason
 * (helpful when debugging a misconfigured webhook secret) without
 * leaking that detail back to the sender — every failure should
 * respond with a generic 401 to GitHub.
 */
export function verifyWebhookSignature(args: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  webhookSecret: string;
}): VerifyResult {
  if (args.webhookSecret.length === 0) {
    // App was registered without a webhook secret. We refuse to accept
    // anything in that mode rather than silently pass — leaving the
    // route open would be exactly the bug this helper exists to prevent.
    return { valid: false, reason: "secret_not_configured" };
  }

  if (!args.signatureHeader) {
    return { valid: false, reason: "missing_signature" };
  }

  if (!args.signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return { valid: false, reason: "malformed_signature" };
  }

  const providedHex = args.signatureHeader.slice(SIGNATURE_PREFIX.length);
  // A sha256 digest in hex is 64 chars. Anything else is malformed; we
  // bail before timingSafeEqual because that throws on length mismatch
  // and we'd rather return a typed reason than catch a CryptoError.
  if (providedHex.length !== 64 || !/^[0-9a-f]+$/i.test(providedHex)) {
    return { valid: false, reason: "malformed_signature" };
  }

  const expected = crypto
    .createHmac("sha256", args.webhookSecret)
    .update(args.rawBody)
    .digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(providedHex, "hex");
  } catch {
    return { valid: false, reason: "malformed_signature" };
  }

  if (provided.length !== expected.length) {
    return { valid: false, reason: "malformed_signature" };
  }

  if (!crypto.timingSafeEqual(provided, expected)) {
    return { valid: false, reason: "mismatch" };
  }

  return { valid: true };
}

/**
 * Convenience for tests + diagnostic tooling. Computes the header value
 * GitHub would send for a given body + secret. Not used by the verifier
 * itself (we compare digests, not header strings).
 */
export function computeSignatureHeader(
  rawBody: Buffer,
  webhookSecret: string,
): string {
  const digest = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");
  return `${SIGNATURE_PREFIX}${digest}`;
}

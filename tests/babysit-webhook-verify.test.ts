/**
 * Tests for HMAC verification of GitHub App webhooks.
 *
 * We aren't wiring the webhook route this session, but a forgeable
 * signature check is the kind of bug you discover via incident, not
 * code review — so the verifier ships with full coverage now.
 *
 * The tests exercise three things:
 *   1. Happy path: a header computed against the raw body verifies.
 *   2. Every typed failure reason fires at the right boundary.
 *   3. The comparison is byte-sensitive against tampering (we don't
 *      accept a payload that's been modified by a single byte).
 */
import * as crypto from "crypto";
import { describe, expect, it } from "vitest";
import {
  computeSignatureHeader,
  SIGNATURE_HEADER,
  verifyWebhookSignature,
} from "../src/daemon/babysit/webhook-verify";

const SECRET = "s3cr3t-webhook-shared-with-github";
const BODY = Buffer.from(
  JSON.stringify({ action: "opened", number: 7, sender: { login: "octocat" } }),
);

describe("verifyWebhookSignature", () => {
  it("accepts a header computed against the same body + secret", () => {
    const header = computeSignatureHeader(BODY, SECRET);
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: header,
      webhookSecret: SECRET,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects when the webhook secret is the empty string (App not configured)", () => {
    const header = computeSignatureHeader(BODY, SECRET);
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: header,
      webhookSecret: "",
    });
    expect(result).toEqual({ valid: false, reason: "secret_not_configured" });
  });

  it("rejects when the signature header is absent", () => {
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: undefined,
      webhookSecret: SECRET,
    });
    expect(result).toEqual({ valid: false, reason: "missing_signature" });
  });

  it("rejects when the header omits the sha256= prefix", () => {
    // bare hex digest, no prefix — common copy-paste mistake
    const bareDigest = crypto
      .createHmac("sha256", SECRET)
      .update(BODY)
      .digest("hex");
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: bareDigest,
      webhookSecret: SECRET,
    });
    expect(result).toEqual({ valid: false, reason: "malformed_signature" });
  });

  it("rejects when the digest portion is the wrong length", () => {
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: "sha256=deadbeef",
      webhookSecret: SECRET,
    });
    expect(result).toEqual({ valid: false, reason: "malformed_signature" });
  });

  it("rejects when the digest portion contains non-hex characters", () => {
    // 64 chars but with a `z` mixed in — must not crash Buffer.from
    const bad = "z".repeat(64);
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: `sha256=${bad}`,
      webhookSecret: SECRET,
    });
    expect(result).toEqual({ valid: false, reason: "malformed_signature" });
  });

  it("rejects when the digest is the right shape but wrong value", () => {
    const wrongHeader = computeSignatureHeader(BODY, "different-secret");
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: wrongHeader,
      webhookSecret: SECRET,
    });
    expect(result).toEqual({ valid: false, reason: "mismatch" });
  });

  it("rejects when the body has been tampered with by a single byte", () => {
    const header = computeSignatureHeader(BODY, SECRET);
    const tampered = Buffer.from(BODY);
    // flip one bit in the middle of the payload
    tampered[10] = tampered[10] ^ 0x01;
    const result = verifyWebhookSignature({
      rawBody: tampered,
      signatureHeader: header,
      webhookSecret: SECRET,
    });
    expect(result).toEqual({ valid: false, reason: "mismatch" });
  });

  it("verifies headers computed by an independent HMAC call (no helper round-trip)", () => {
    // Sanity check: an external producer (e.g. GitHub) computes the
    // digest its own way — make sure we accept it without relying on
    // our own helper for the header construction.
    const digest = crypto
      .createHmac("sha256", SECRET)
      .update(BODY)
      .digest("hex");
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: `sha256=${digest.toUpperCase()}`,
      webhookSecret: SECRET,
    });
    // Hex parse is case-insensitive; uppercase digest must still verify.
    expect(result.valid).toBe(true);
  });

  it("handles empty bodies (e.g. ping events with no payload)", () => {
    const empty = Buffer.alloc(0);
    const header = computeSignatureHeader(empty, SECRET);
    const result = verifyWebhookSignature({
      rawBody: empty,
      signatureHeader: header,
      webhookSecret: SECRET,
    });
    expect(result.valid).toBe(true);
  });
});

describe("SIGNATURE_HEADER constant", () => {
  it("matches the header name GitHub uses (case-insensitive lowercase form)", () => {
    // Fastify normalizes header keys to lowercase, so the constant
    // must already be lowercase for callers using request.headers[SIGNATURE_HEADER].
    expect(SIGNATURE_HEADER).toBe("x-hub-signature-256");
  });
});

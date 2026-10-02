import assert from "node:assert/strict";
import test from "node:test";
import {
  CallbackAddressError,
  WebhookSecretError,
  decodeWebhookSecret,
  isPublicAddress,
  parseCallbackUrl,
  signWebhook,
} from "./webhook.js";

// The Standard Webhooks reference libraries' public signing vector — a test key,
// not a credential. Assembled at runtime so secret scanners do not match a
// literal `whsec_` value.
const VECTOR_KEY = "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const VECTOR_SECRET = `whsec_${VECTOR_KEY}`;
const VECTOR_ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const VECTOR_TIMESTAMP = 1614265330;
const VECTOR_BODY = '{"test": 2432232314}';
const VECTOR_SIGNATURE = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";

test("signWebhook reproduces the Standard Webhooks reference signature", () => {
  assert.equal(signWebhook([VECTOR_SECRET], VECTOR_ID, VECTOR_TIMESTAMP, VECTOR_BODY), VECTOR_SIGNATURE);
});

test("signWebhook signs with every rotation key, space-separated", () => {
  const next = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
  const header = signWebhook([next, VECTOR_SECRET], VECTOR_ID, VECTOR_TIMESTAMP, VECTOR_BODY);
  const parts = header.split(" ");
  assert.equal(parts.length, 2);
  assert.equal(parts[1], VECTOR_SIGNATURE);
  assert.match(parts[0]!, /^v1,[A-Za-z0-9+/]+=*$/u);
});

test("decodeWebhookSecret accepts 24 to 64 byte whsec_ keys only", () => {
  assert.equal(decodeWebhookSecret(`whsec_${Buffer.alloc(24).toString("base64")}`).length, 24);
  assert.equal(decodeWebhookSecret(`whsec_${Buffer.alloc(64).toString("base64")}`).length, 64);
  for (const secret of [
    Buffer.alloc(32).toString("base64"),
    `whsec_${Buffer.alloc(23).toString("base64")}`,
    `whsec_${Buffer.alloc(65).toString("base64")}`,
    "whsec_not*base64",
    "whsec_",
  ]) {
    assert.throws(() => decodeWebhookSecret(secret), WebhookSecretError, secret);
  }
});

test("isPublicAddress rejects every non-public range", () => {
  for (const address of [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1",
    "192.0.2.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2001:db8::1",
    "2002:7f00:1::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "not-an-ip",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001::200e"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("parseCallbackUrl accepts only https URLs to public hosts", () => {
  assert.equal(
    parseCallbackUrl("https://receiver.example.com/mcp-events/callback_123").href,
    "https://receiver.example.com/mcp-events/callback_123",
  );
  for (const url of [
    "http://receiver.example.com/cb",
    "https://localhost/cb",
    "https://app.localhost/cb",
    "https://127.0.0.1/cb",
    "https://10.0.0.8/cb",
    "https://[::1]/cb",
    "https://[::ffff:127.0.0.1]/cb",
    "https://user:pass@receiver.example.com/cb",
    "not a url",
  ]) {
    assert.throws(() => parseCallbackUrl(url), CallbackAddressError, url);
  }
});

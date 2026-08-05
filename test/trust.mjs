// Unit tests for the session-cookie trust boundary. Unlike test/run.mjs these stub
// fetch, so they need no real token and make no network calls.
import { strict as assert } from "assert";
import { SubstackClient } from "../dist/client.js";

const SUBSCRIBED_CUSTOM_DOMAIN = "stratechery.com";

// Records every outbound request so a test can assert who got the Cookie header.
function stubFetch(seen, { redirectTo } = {}) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    seen.push({ host: u.hostname, cookie: !!(opts.headers && opts.headers.Cookie) });
    const body = u.pathname.includes("/subscriptions")
      ? { publications: [{ custom_domain: SUBSCRIBED_CUSTOM_DOMAIN, subdomain: "stratechery" }] }
      : [{ title: "t", slug: "s", post_date: "", audience: "", canonical_url: "" }];
    return {
      ok: true,
      status: 200,
      url: redirectTo && !u.pathname.includes("/subscriptions") ? redirectTo : String(url),
      json: async () => body,
      text: async () => "",
    };
  };
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.error("      " + err.message);
    failed++;
  }
}

const cookieHosts = (seen) => seen.filter((s) => s.cookie).map((s) => s.host);

await test("session cookie is sent to substack.com subdomains", async () => {
  const seen = [];
  stubFetch(seen);
  await new SubstackClient("SECRET").listPublished("lenny.substack.com");
  assert.ok(cookieHosts(seen).includes("lenny.substack.com"));
});

await test("session cookie is sent to a subscribed publication's custom domain", async () => {
  const seen = [];
  stubFetch(seen);
  await new SubstackClient("SECRET").listPublished(SUBSCRIBED_CUSTOM_DOMAIN);
  assert.ok(cookieHosts(seen).includes(SUBSCRIBED_CUSTOM_DOMAIN));
});

await test("session cookie is NOT sent to an arbitrary domain", async () => {
  const seen = [];
  stubFetch(seen);
  await new SubstackClient("SECRET").listPublished("evil-exfil.example.com");
  assert.deepEqual(
    cookieHosts(seen).filter((h) => h === "evil-exfil.example.com"),
    []
  );
});

await test("a redirect to an untrusted host is refused", async () => {
  const seen = [];
  stubFetch(seen, { redirectTo: "https://evil-exfil.example.com/api/v1/archive" });
  await assert.rejects(
    () => new SubstackClient("SECRET").listPublished("lenny.substack.com"),
    /Refusing:/
  );
});

await test("plain-http domains are refused", async () => {
  const seen = [];
  stubFetch(seen);
  await assert.rejects(
    () => new SubstackClient("SECRET").listPublished("http://insecure.example.com"),
    /Refusing:/
  );
});

await test("a malformed @handle is rejected before it becomes a hostname", async () => {
  const seen = [];
  stubFetch(seen);
  await assert.rejects(
    () => new SubstackClient("SECRET").resolveUrl("https://substack.com/@evil.com%2F../p-123"),
    /Invalid publication handle/
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

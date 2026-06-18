import { spawn } from "child_process";
import { strict as assert } from "assert";

const TOKEN = process.env.SUBSTACK_SESSION_TOKEN;
if (!TOKEN) {
  console.error("Set SUBSTACK_SESSION_TOKEN before running tests");
  process.exit(1);
}

const proc = spawn("node", ["dist/index.js"], {
  env: { ...process.env, SUBSTACK_SESSION_TOKEN: TOKEN },
});

let buf = "";
const pending = new Map();
let id = 1;

proc.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let lines = buf.split("\n");
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const resolver = pending.get(msg.id);
    if (resolver) {
      resolver(msg);
      pending.delete(msg.id);
    }
  }
});
proc.stderr.on("data", (d) => process.stderr.write(d));

function send(method, params) {
  const reqId = id++;
  return new Promise((resolve) => {
    pending.set(reqId, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }) + "\n");
  });
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

async function main() {
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  await test("tools/list returns all 11 tools", async () => {
    const res = await send("tools/list", {});
    const names = res.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "get_author_profile",
      "get_notes_feed",
      "get_post",
      "get_post_by_url",
      "get_post_comments",
      "get_post_comments_by_url",
      "get_recommendations",
      "list_published_posts",
      "list_subscriptions",
      "search_all_subscriptions",
      "search_posts",
    ]);
  });

  await test("list_subscriptions returns real data", async () => {
    const res = await send("tools/call", { name: "list_subscriptions", arguments: {} });
    assert.equal(!!res.result.isError, false);
    const data = JSON.parse(res.result.content[0].text);
    assert.ok(Array.isArray(data.publications));
  });

  await test("get_post fetches a known paywalled post", async () => {
    const res = await send("tools/call", {
      name: "get_post",
      arguments: { domain: "citrini.substack.com", slug: "macro-memo-spin-cycle" },
    });
    assert.equal(!!res.result.isError, false);
    const data = JSON.parse(res.result.content[0].text);
    assert.ok(data.body_html.length > 0);
  });

  await test("get_post_by_url resolves a generic substack.com link", async () => {
    const res = await send("tools/call", {
      name: "get_post_by_url",
      arguments: { url: "https://substack.com/@aurelionresearch/p-199927616" },
    });
    assert.equal(!!res.result.isError, false);
    const data = JSON.parse(res.result.content[0].text);
    assert.ok(data.title.length > 0);
  });

  await test("search_all_subscriptions returns results across publications", async () => {
    const res = await send("tools/call", {
      name: "search_all_subscriptions",
      arguments: { query: "oil", limitPerPub: 3 },
    });
    assert.equal(!!res.result.isError, false);
    const data = JSON.parse(res.result.content[0].text);
    assert.ok(Array.isArray(data));
  });

  await test("missing required argument errors clearly", async () => {
    const res = await send("tools/call", { name: "get_post", arguments: { domain: "citrini.substack.com" } });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Missing required argument/);
  });

  await test("unknown tool errors gracefully, no crash", async () => {
    const res = await send("tools/call", { name: "not_a_real_tool", arguments: {} });
    assert.equal(res.result.isError, true);
  });

  await test("nonexistent publication domain errors gracefully", async () => {
    const res = await send("tools/call", {
      name: "list_published_posts",
      arguments: { domain: "this-does-not-exist-xyz123.substack.com" },
    });
    assert.equal(res.result.isError, true);
  });

  await test("limit param is clamped, oversized limit does not error", async () => {
    const res = await send("tools/call", {
      name: "list_published_posts",
      arguments: { domain: "citrini.substack.com", limit: 99999 },
    });
    assert.equal(!!res.result.isError, false);
  });

  await test("get_post_comments fetches comments on a known post", async () => {
    const res = await send("tools/call", {
      name: "get_post_comments",
      arguments: { domain: "citrini.substack.com", slug: "macro-memo-spin-cycle" },
    });
    assert.equal(!!res.result.isError, false);
    const data = JSON.parse(res.result.content[0].text);
    assert.ok(Array.isArray(data));
  });

  await test("get_notes_feed returns recent notes", async () => {
    const res = await send("tools/call", { name: "get_notes_feed", arguments: { limit: 5 } });
    assert.equal(!!res.result.isError, false);
    const data = JSON.parse(res.result.content[0].text);
    assert.ok(Array.isArray(data));
  });

  await test("get_author_profile fetches a known author's profile", async () => {
    const res = await send("tools/call", {
      name: "get_author_profile",
      arguments: { handle: "quantitativo" },
    });
    assert.equal(!!res.result.isError, false);
    const data = JSON.parse(res.result.content[0].text);
    assert.ok(data.name.length > 0);
  });

  await test("get_author_profile errors gracefully on unknown handle", async () => {
    const res = await send("tools/call", {
      name: "get_author_profile",
      arguments: { handle: "this-handle-does-not-exist-xyz123" },
    });
    assert.equal(res.result.isError, true);
  });

  await test("get_recommendations lists publications recommended by a known pub", async () => {
    const res = await send("tools/call", {
      name: "get_recommendations",
      arguments: { domain: "citrini.substack.com" },
    });
    assert.equal(!!res.result.isError, false);
    const data = JSON.parse(res.result.content[0].text);
    assert.ok(Array.isArray(data));
  });

  await test("get_recommendations errors gracefully on nonexistent publication", async () => {
    const res = await send("tools/call", {
      name: "get_recommendations",
      arguments: { domain: "this-does-not-exist-xyz123.substack.com" },
    });
    assert.equal(res.result.isError, true);
  });

  proc.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  proc.kill();
  process.exit(1);
});

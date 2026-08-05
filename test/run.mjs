import { spawn } from "child_process";
import { strict as assert } from "assert";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TOKEN = process.env.SUBSTACK_SESSION_TOKEN;
if (!TOKEN) {
  console.error("Set SUBSTACK_SESSION_TOKEN before running tests");
  process.exit(1);
}

// Isolate tag_publication/list_tags from the real ~/.substack-mcp/tags.json.
const tagsTestDir = mkdtempSync(join(tmpdir(), "substack-mcp-tags-test-"));

const proc = spawn("node", ["dist/index.js"], {
  env: { ...process.env, SUBSTACK_SESSION_TOKEN: TOKEN, SUBSTACK_MCP_TAGS_FILE: join(tagsTestDir, "tags.json") },
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

// Tool output comes back wrapped in <substack-content-NONCE> ... </substack-content-NONCE>
// (see src/untrusted.ts) so the model can tell it apart from instructions. Strip that here
// to get at the JSON payload underneath.
function parseContent(res) {
  const text = res.result.content[0].text;
  const open = text.match(/^<substack-content-([0-9a-f]+)>\n/);
  if (!open) throw new Error(`Tool output missing the untrusted-content envelope: ${text.slice(0, 80)}`);
  const bodyStart = text.indexOf("\n\n", open[0].length) + 2;
  const bodyEnd = text.lastIndexOf(`</substack-content-${open[1]}>`);
  return JSON.parse(text.slice(bodyStart, bodyEnd).replace(/\n$/, ""));
}

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

  await test("tools/list returns all 14 tools", async () => {
    const res = await send("tools/list", {});
    const names = res.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "get_author_profile",
      "get_inbox",
      "get_notes_feed",
      "get_post",
      "get_post_by_url",
      "get_post_comments",
      "get_post_comments_by_url",
      "get_recommendations",
      "list_published_posts",
      "list_subscriptions",
      "list_tags",
      "search_all_subscriptions",
      "search_posts",
      "tag_publication",
    ]);
  });

  await test("list_subscriptions returns real data", async () => {
    const res = await send("tools/call", { name: "list_subscriptions", arguments: {} });
    assert.equal(!!res.result.isError, false);
    const data = parseContent(res);
    assert.ok(Array.isArray(data.publications));
  });

  await test("get_post fetches a known paywalled post", async () => {
    const res = await send("tools/call", {
      name: "get_post",
      arguments: { domain: "citrini.substack.com", slug: "macro-memo-spin-cycle" },
    });
    assert.equal(!!res.result.isError, false);
    const data = parseContent(res);
    assert.ok(data.body_html.length > 0);
  });

  await test("get_post_by_url resolves a generic substack.com link", async () => {
    const res = await send("tools/call", {
      name: "get_post_by_url",
      arguments: { url: "https://substack.com/@aurelionresearch/p-199927616" },
    });
    assert.equal(!!res.result.isError, false);
    const data = parseContent(res);
    assert.ok(data.title.length > 0);
  });

  await test("get_inbox returns posts with domain and read state", async () => {
    const res = await send("tools/call", { name: "get_inbox", arguments: { limit: 5 } });
    assert.equal(!!res.result.isError, false);
    const data = parseContent(res);
    assert.ok(Array.isArray(data));
    assert.ok(data.length > 0);
    assert.ok(data[0].domain.endsWith(".substack.com"));
    assert.equal(typeof data[0].unread, "boolean");
  });

  await test("tag_publication, list_tags, and the tag filters work end to end", async () => {
    // hfbestideas is in this account's inbox, so it's in the discoverPublications() union
    // that search_all_subscriptions filters by tag — a domain the reader isn't actually
    // subscribed/following to wouldn't be in that set, and the tag filter would silently
    // return [] rather than prove anything.
    const TAGGED_DOMAIN = "hfbestideas.substack.com";

    const tagRes = await send("tools/call", {
      name: "tag_publication",
      arguments: { domain: TAGGED_DOMAIN, tags: ["financial-research"] },
    });
    assert.equal(!!tagRes.result.isError, false);

    const listRes = await send("tools/call", { name: "list_tags", arguments: {} });
    assert.deepEqual(parseContent(listRes), { "financial-research": [TAGGED_DOMAIN] });

    const searchRes = await send("tools/call", {
      name: "search_all_subscriptions",
      arguments: { query: "the", limitPerPub: 3, tag: "financial-research" },
    });
    assert.equal(!!searchRes.result.isError, false);
    const results = parseContent(searchRes);
    assert.ok(results.length > 0, "expected at least one match from the tagged publication");
    assert.ok(results.every((r) => r.publication_domain === TAGGED_DOMAIN));

    const untagRes = await send("tools/call", {
      name: "tag_publication",
      arguments: { domain: TAGGED_DOMAIN, tags: [] },
    });
    assert.equal(!!untagRes.result.isError, false);
    assert.deepEqual(parseContent(await send("tools/call", { name: "list_tags", arguments: {} })), {});
  });

  await test("search_all_subscriptions returns results across publications", async () => {
    const res = await send("tools/call", {
      name: "search_all_subscriptions",
      arguments: { query: "oil", limitPerPub: 3 },
    });
    assert.equal(!!res.result.isError, false);
    const data = parseContent(res);
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
    const data = parseContent(res);
    assert.ok(Array.isArray(data));
  });

  await test("get_notes_feed returns recent notes", async () => {
    const res = await send("tools/call", { name: "get_notes_feed", arguments: { limit: 5 } });
    assert.equal(!!res.result.isError, false);
    const data = parseContent(res);
    assert.ok(Array.isArray(data));
  });

  await test("get_author_profile fetches a known author's profile", async () => {
    const res = await send("tools/call", {
      name: "get_author_profile",
      arguments: { handle: "quantitativo" },
    });
    assert.equal(!!res.result.isError, false);
    const data = parseContent(res);
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
    const data = parseContent(res);
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
  rmSync(tagsTestDir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  proc.kill();
  rmSync(tagsTestDir, { recursive: true, force: true });
  process.exit(1);
});

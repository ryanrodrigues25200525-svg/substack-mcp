# substack-mcp 📰

An [MCP](https://modelcontextprotocol.io) server for reading Substack — publications, posts, comments, author profiles, recommendations, and your Notes feed — using your own reader session, no official API required.

For use with Claude, Codex, and other MCP-compatible coding agents.

It's read-only 🔒: nothing it does can post, like, comment, or change your account state. The session cookie is only ever sent to Substack hosts you're actually subscribed to, and tool output is wrapped in a delimited block marking it as untrusted third-party content (post bodies and comments are written by other people, not you) — both defenses against prompt injection carried in what you read.

## 🛠️ Tools

| Tool | Description |
|---|---|
| `list_published_posts` | List recent posts from a publication |
| `get_post` | Get a post's full content by domain + slug (works on paywalled posts if you're a paid subscriber) |
| `get_post_by_url` | Get a post's full content from any post URL, including generic `substack.com/@handle/p-<id>` links |
| `search_posts` | Search posts within a publication |
| `search_all_subscriptions` | Search across every publication you're subscribed to or follow |
| `list_subscriptions` | List your subscriptions (free and paid) |
| `get_inbox` | New posts across every publication you read, newest first, with read/unread state. Optional `tag` filter |
| `get_post_comments` | Get a post's comments, with nested replies, by domain + slug |
| `get_post_comments_by_url` | Same, from any post URL |
| `get_author_profile` | Get an author's public profile (bio, social links, publications they write for) |
| `get_recommendations` | List publications a given publication recommends to its readers |
| `get_notes_feed` | List recent items from your Notes home feed |
| `tag_publication` | Tag a publication by topic (e.g. `financial-research`) for use with `search_all_subscriptions`/`get_inbox`'s `tag` filter. Empty array untags |
| `list_tags` | List every tag you've set and which publications carry each one |

## 🏷️ Tagging

Substack doesn't expose a topic or category field for publications — `tag_publication` is a
local layer this server keeps for you, stored at `~/.substack-mcp/tags.json` (override with
`SUBSTACK_MCP_TAGS_FILE`). Tag your accounts by whatever grouping you want — e.g. `financial-research`
for the ones covering markets, something else for the rest — then pass `tag` to
`search_all_subscriptions` or `get_inbox` to scope to just that group. Nothing here reads or
infers a topic from Substack itself; you (or your agent, reading a few recent post titles) decide
what a publication is about.

## ⚙️ How it works

Substack doesn't expose a public API for these reads. Instead, this server replays the same `/api/v1/*` requests your browser makes when you're logged in, authenticated with your `substack.sid` session cookie. That means:

- You need an active Substack account and a valid session token.
- The token expires periodically — when requests start failing with an auth error, re-extract it (see below).

⚠️ This is an unofficial library and is not affiliated with or endorsed by Substack. It only accesses content you're already entitled to (your own subscriptions, public posts, and your own account data) and doesn't bypass paywalls or rate limits. Be mindful of [Substack's Terms of Use](https://substack.com/tos) when using it.

## 🚀 Setup

```bash
git clone https://github.com/ryanrodrigues25200525-svg/substack-mcp.git
cd substack-mcp
npm install
npm run build
```

### 🔑 Get your session token

1. Log into Substack in your browser.
2. Open DevTools → Application/Storage → Cookies → `substack.com`.
3. Copy the value of the `substack.sid` cookie.

### 🔌 Configure your MCP client

Add to your MCP client's config (e.g. Claude Code's `~/.claude.json`, under `mcpServers`):

```json
{
  "mcpServers": {
    "substack": {
      "command": "node",
      "args": ["/absolute/path/to/substack-mcp/dist/index.js"],
      "env": {
        "SUBSTACK_SESSION_TOKEN": "your_token_here"
      }
    }
  }
}
```

🚫 **Never commit your token.** Keep it in your local MCP client config only, not in this repo or in version control.

## 🧪 Development

```bash
npm run build               # compile TypeScript
SUBSTACK_SESSION_TOKEN=xxx npm test   # integration suite against live Substack endpoints
npm run test:trust           # unit tests for the session-cookie trust boundary (stubbed, no token needed)
```

`npm test` makes real requests against live publications, so it needs a valid `SUBSTACK_SESSION_TOKEN` and is subject to Substack's rate limits. `npm run test:trust` stubs `fetch` and covers which hosts get the session cookie, path escaping, and the untrusted-content envelope — no network, no token.

## 📄 License

[MIT](LICENSE)

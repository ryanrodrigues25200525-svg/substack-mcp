# substack-mcp

An [MCP](https://modelcontextprotocol.io) server for reading Substack — publications, posts, comments, author profiles, recommendations, and your Notes feed — using your own reader session, no official API required.

It's read-only: nothing it does can post, like, comment, or change your account state.

## Tools

| Tool | Description |
|---|---|
| `list_published_posts` | List recent posts from a publication |
| `get_post` | Get a post's full content by domain + slug (works on paywalled posts if you're a paid subscriber) |
| `get_post_by_url` | Get a post's full content from any post URL, including generic `substack.com/@handle/p-<id>` links |
| `search_posts` | Search posts within a publication |
| `search_all_subscriptions` | Search across every publication you're subscribed to |
| `list_subscriptions` | List your subscriptions (free and paid) |
| `get_post_comments` | Get a post's comments, with nested replies, by domain + slug |
| `get_post_comments_by_url` | Same, from any post URL |
| `get_author_profile` | Get an author's public profile (bio, social links, publications they write for) |
| `get_recommendations` | List publications a given publication recommends to its readers |
| `get_notes_feed` | List recent items from your Notes home feed |

## How it works

Substack doesn't expose a public API for these reads. Instead, this server replays the same `/api/v1/*` requests your browser makes when you're logged in, authenticated with your `substack.sid` session cookie. That means:

- You need an active Substack account and a valid session token.
- The token expires periodically — when requests start failing with an auth error, re-extract it (see below).
- This is unofficial and not endorsed by Substack. Use at your own discretion and in line with Substack's Terms of Service.

## Setup

```bash
git clone https://github.com/ryanrodrigues25200525-svg/substack-mcp.git
cd substack-mcp
npm install
npm run build
```

### Get your session token

1. Log into Substack in your browser.
2. Open DevTools → Application/Storage → Cookies → `substack.com`.
3. Copy the value of the `substack.sid` cookie.

### Configure your MCP client

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

**Never commit your token.** Keep it in your local MCP client config only, not in this repo or in version control.

## Development

```bash
npm run build               # compile TypeScript
SUBSTACK_SESSION_TOKEN=xxx npm test   # run the integration test suite against live Substack endpoints
```

The test suite makes real requests against live publications, so it needs a valid `SUBSTACK_SESSION_TOKEN` and is subject to Substack's rate limits.

## License

MIT

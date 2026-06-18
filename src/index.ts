import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SubstackClient } from "./client.js";

const SESSION_TOKEN = process.env.SUBSTACK_SESSION_TOKEN;

if (!SESSION_TOKEN) {
  console.error("Missing SUBSTACK_SESSION_TOKEN env var");
  process.exit(1);
}

const client = new SubstackClient(SESSION_TOKEN);

const TOOLS = [
  {
    name: "list_published_posts",
    description: "List recent published posts from a given Substack publication (e.g. 'stratechery.com' or 'name.substack.com')",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Publication domain, with or without https://" },
        offset: { type: "number", default: 0 },
        limit: { type: "number", default: 25 },
      },
      required: ["domain"],
    },
  },
  {
    name: "get_post",
    description: "Get full content of a post by slug from a given publication. Works on paywalled posts if you're a paid subscriber.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Publication domain" },
        slug: { type: "string", description: "Post slug (the part after /p/ in the URL)" },
      },
      required: ["domain", "slug"],
    },
  },
  {
    name: "search_posts",
    description: "Search posts within a given publication by text query",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Publication domain" },
        query: { type: "string", description: "Search text" },
        limit: { type: "number", default: 20 },
      },
      required: ["domain", "query"],
    },
  },
  {
    name: "list_subscriptions",
    description: "List the publications you're subscribed to (free and paid)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_post_by_url",
    description: "Fetch a post's full content given any post URL, including generic substack.com/@handle/p-<id> links — resolves the real publication domain and slug automatically.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Any Substack post URL" } },
      required: ["url"],
    },
  },
  {
    name: "search_all_subscriptions",
    description: "Search for posts matching a query across every publication you're subscribed to",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text" },
        limitPerPub: { type: "number", default: 10, description: "Max results per publication" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_post_comments",
    description: "Get comments (with nested replies) on a post by domain + slug",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Publication domain" },
        slug: { type: "string", description: "Post slug (the part after /p/ in the URL)" },
      },
      required: ["domain", "slug"],
    },
  },
  {
    name: "get_post_comments_by_url",
    description: "Get comments (with nested replies) on a post given any post URL",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Any Substack post URL" } },
      required: ["url"],
    },
  },
  {
    name: "get_author_profile",
    description: "Get a Substack author's public profile (bio, social links, publications they write for) by their handle",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string", description: "Author handle (the part after @ in substack.com/@handle)" } },
      required: ["handle"],
    },
  },
  {
    name: "get_recommendations",
    description: "List other publications that a given Substack publication recommends to its readers",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string", description: "Publication domain" } },
      required: ["domain"],
    },
  },
  {
    name: "get_notes_feed",
    description: "List recent items from your Substack Notes home feed (short-form posts from people/publications you follow)",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", default: 20 } },
    },
  },
];

const server = new Server(
  { name: "substack-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    const required: Record<string, string[]> = {
      list_published_posts: ["domain"],
      get_post: ["domain", "slug"],
      search_posts: ["domain", "query"],
      list_subscriptions: [],
      get_post_by_url: ["url"],
      search_all_subscriptions: ["query"],
      get_post_comments: ["domain", "slug"],
      get_post_comments_by_url: ["url"],
      get_notes_feed: [],
      get_author_profile: ["handle"],
      get_recommendations: ["domain"],
    };
    if (name in required) {
      const missing = required[name].filter((key) => !args[key]);
      if (missing.length > 0) {
        throw new Error(`Missing required argument(s): ${missing.join(", ")}`);
      }
    }

    let result: unknown;
    switch (name) {
      case "list_published_posts":
        result = await client.listPublished(args.domain as string, args.offset as number, args.limit as number);
        break;
      case "get_post":
        result = await client.getPost(args.domain as string, args.slug as string);
        break;
      case "search_posts":
        result = await client.searchPosts(args.domain as string, args.query as string, args.limit as number);
        break;
      case "list_subscriptions":
        result = await client.listSubscriptions();
        break;
      case "get_post_by_url":
        result = await client.getPostByUrl(args.url as string);
        break;
      case "search_all_subscriptions":
        result = await client.searchAllSubscriptions(args.query as string, args.limitPerPub as number);
        break;
      case "get_post_comments":
        result = await client.getPostComments(args.domain as string, args.slug as string);
        break;
      case "get_post_comments_by_url":
        result = await client.getPostCommentsByUrl(args.url as string);
        break;
      case "get_notes_feed":
        result = await client.getNotesFeed(args.limit as number);
        break;
      case "get_author_profile":
        result = await client.getAuthorProfile(args.handle as string);
        break;
      case "get_recommendations":
        result = await client.getRecommendations(args.domain as string);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

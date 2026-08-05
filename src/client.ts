const BASE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  Accept: "application/json",
};

// Marker for errors that must never be retried — the request was refused on trust grounds,
// so retrying it is pointless and just repeats the attempt.
const UNTRUSTED_PREFIX = "Refusing:";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;

function normalizeDomain(domain: string): string {
  if (!/^https?:\/\//.test(domain)) domain = `https://${domain}`;
  return domain.replace(/\/$/, "");
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== "number" || Number.isNaN(limit)) return fallback;
  return Math.min(50, Math.max(1, Math.floor(limit))); // Substack's archive endpoint rejects limit > 50
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ArchivePost {
  title: string;
  subtitle?: string;
  slug: string;
  post_date: string;
  audience: string;
  canonical_url: string;
  wordcount?: number;
  description?: string;
  publication_domain?: string;
}

function slimArchivePost(p: any, publicationDomain?: string): ArchivePost {
  return {
    title: p.title,
    subtitle: p.subtitle,
    slug: p.slug,
    post_date: p.post_date,
    audience: p.audience,
    canonical_url: p.canonical_url,
    wordcount: p.wordcount,
    description: p.description,
    ...(publicationDomain ? { publication_domain: publicationDomain } : {}),
  };
}

function slimFullPost(p: any) {
  return {
    title: p.title,
    subtitle: p.subtitle,
    slug: p.slug,
    post_date: p.post_date,
    audience: p.audience,
    canonical_url: p.canonical_url,
    wordcount: p.wordcount,
    description: p.description,
    authors: (p.publishedBylines ?? []).map((b: any) => b.name).filter(Boolean),
    body_html: p.body_html,
  };
}

export class SubstackClient {
  private sessionToken: string;
  private customDomainsPromise: Promise<Set<string>> | null = null;

  constructor(sessionToken: string) {
    this.sessionToken = sessionToken;
  }

  // The set of non-substack.com hosts we're willing to send the session cookie to:
  // the custom domains of publications this reader is actually subscribed to.
  // Fetched once, lazily; failures degrade to "trust nothing extra" rather than throwing.
  private customDomains(): Promise<Set<string>> {
    if (!this.customDomainsPromise) {
      this.customDomainsPromise = this.listSubscriptions()
        .then((subs: any) => {
          const set = new Set<string>();
          for (const pub of subs?.publications ?? []) {
            if (pub?.custom_domain) set.add(String(pub.custom_domain).toLowerCase());
          }
          return set;
        })
        .catch(() => new Set<string>());
    }
    return this.customDomainsPromise;
  }

  // Only attach the session cookie to hosts we trust. substack.sid is a full account
  // session, and this server ingests untrusted text (post bodies, comments) that could
  // steer a tool call at an attacker-chosen domain — so a caller-supplied host is not
  // sufficient authority to receive it.
  private async isTrustedHost(hostname: string): Promise<boolean> {
    const host = hostname.toLowerCase();
    if (host === "substack.com" || host.endsWith(".substack.com")) return true;
    return (await this.customDomains()).has(host);
  }

  private async authHeaders(hostname: string): Promise<Record<string, string>> {
    return (await this.isTrustedHost(hostname))
      ? { ...BASE_HEADERS, Cookie: `substack.sid=${this.sessionToken}` }
      : { ...BASE_HEADERS };
  }

  private async request(baseUrl: string, path: string, params: Record<string, string | number> = {}) {
    const url = new URL(`${normalizeDomain(baseUrl)}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    if (url.protocol !== "https:") {
      throw new Error(`${UNTRUSTED_PREFIX} non-HTTPS request to ${url.host}`);
    }

    const headers = await this.authHeaders(url.hostname);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          headers,
          redirect: "follow",
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        // ponytail: no cross-host redirect check — fetch strips Cookie on cross-origin
        // redirects per spec, and publications with a custom domain 301 their API off
        // <pub>.substack.com, so refusing the redirect broke them.

        if (res.status === 401 || res.status === 403) {
          throw new Error("Authentication failed — session token is likely expired. Re-extract substack.sid from the browser.");
        }

        if (res.status === 429 || res.status >= 500) {
          if (attempt < MAX_RETRIES) {
            const backoffMs = 500 * Math.pow(2, attempt);
            await sleep(backoffMs);
            continue;
          }
          throw new Error(`Substack API error ${res.status} after ${MAX_RETRIES} retries: ${await res.text()}`);
        }

        if (!res.ok) {
          throw new Error(`Substack API error ${res.status}: ${await res.text()}`);
        }

        return res.json();
      } catch (err) {
        clearTimeout(timeoutId);
        if (err instanceof Error && err.name === "AbortError") {
          lastError = new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`);
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
        // Auth errors and generic thrown Errors from above already escaped via throw;
        // only network-level failures (fetch rejecting) land here for retry.
        const fatal =
          err instanceof Error &&
          (err.message.startsWith("Authentication failed") || err.message.startsWith(UNTRUSTED_PREFIX));
        if (attempt < MAX_RETRIES && !fatal) {
          await sleep(500 * Math.pow(2, attempt));
          continue;
        }
        throw lastError;
      }
    }

    throw lastError ?? new Error("Request failed for an unknown reason");
  }

  // Resolve a generic substack.com/@handle/p-<id> link (or any post URL) to its
  // real publication domain + slug, since the public API lives on the pub's own domain.
  async resolveUrl(url: string): Promise<{ domain: string; slug: string }> {
    const idMatch = url.match(/\/p-(\d+)(?:[/?]|$)/);
    if (idMatch) {
      // Generic substack.com/@handle/p-<id> links: the handle's own subdomain serves
      // a by-id endpoint (with a 301 to its custom domain, if any) that resolves the real slug.
      const handleMatch = url.match(/@([^/]+)/);
      if (!handleMatch) throw new Error(`Could not extract a publication handle from URL: ${url}`);
      // Constrain the handle to a real subdomain label — otherwise something like
      // "@x?y=" or "@x@evil.com" reinterprets the host once parsed as a URL.
      const handle = handleMatch[1];
      if (!/^[A-Za-z0-9-]+$/.test(handle)) {
        throw new Error(`Invalid publication handle in URL: ${handle}`);
      }
      const guessDomain = `${handle}.substack.com`;

      const res = await fetch(`https://${guessDomain}/api/v1/posts/by-id/${idMatch[1]}`, {
        headers: await this.authHeaders(guessDomain),
      });
      if (!res.ok) throw new Error(`Could not resolve URL ${url}: ${res.status}`);
      const body: any = await res.json();
      const post = body.post ?? body;
      const canonical = new URL(post.canonical_url ?? res.url);
      return { domain: canonical.origin, slug: post.slug };
    }

    // Already a canonical /p/<slug> URL on a real publication domain.
    const parsed = new URL(url);
    const slugMatch = parsed.pathname.match(/\/p\/([^/?]+)/);
    if (!slugMatch) throw new Error(`Could not extract a post slug from URL: ${url}`);
    return { domain: parsed.origin, slug: slugMatch[1] };
  }

  // List recent posts from a given publication (e.g. "yourpub.substack.com")
  async listPublished(domain: string, offset = 0, limit = 25) {
    const posts = await this.request(domain, "/api/v1/archive", { sort: "new", offset, limit: clampLimit(limit, 25) });
    return (posts as any[]).map((p) => slimArchivePost(p));
  }

  // Fetch a single post's full content by slug, from a given publication domain
  async getPost(domain: string, slug: string) {
    const post = await this.request(domain, `/api/v1/posts/${slug}`);
    return slimFullPost(post);
  }

  // Fetch a post directly from any post URL (resolves domain/slug automatically)
  async getPostByUrl(url: string) {
    const { domain, slug } = await this.resolveUrl(url);
    return this.getPost(domain, slug);
  }

  // Search posts within a given publication
  async searchPosts(domain: string, query: string, limit = 20) {
    const posts = await this.request(domain, "/api/v1/archive", { search: query, limit: clampLimit(limit, 20), sort: "new" });
    return (posts as any[]).map((p) => slimArchivePost(p));
  }

  // Search across every publication the reader is subscribed to
  async searchAllSubscriptions(query: string, limitPerPub = 10) {
    const subs: any = await this.listSubscriptions();
    const publications: any[] = subs.publications ?? [];
    const results = await Promise.all(
      publications.map(async (pub) => {
        const domain = `${pub.subdomain}.substack.com`;
        try {
          const posts = await this.searchPosts(domain, query, limitPerPub);
          return posts.map((p) => slimArchivePost(p, domain));
        } catch {
          return []; // skip publications that error (custom domain mismatch, deleted pub, etc.)
        }
      })
    );
    return results.flat();
  }

  // List the reader's own subscriptions (publications they follow/pay for)
  listSubscriptions() {
    return this.request("https://substack.com", "/api/v1/subscriptions", { tvOnly: "false" });
  }

  // Fetch comments on a post (by domain + slug). Looks up the post's internal id first,
  // since the comments endpoint is keyed by id rather than slug.
  async getPostComments(domain: string, slug: string) {
    const post: any = await this.request(domain, `/api/v1/posts/${slug}`);
    const comments: any = await this.request(domain, `/api/v1/post/${post.id}/comments`, { all_comments: "true" });
    return this.slimComments(comments.comments ?? comments);
  }

  // Same as getPostComments but takes any post URL directly
  async getPostCommentsByUrl(url: string) {
    const { domain, slug } = await this.resolveUrl(url);
    return this.getPostComments(domain, slug);
  }

  private slimComments(comments: any[]): any[] {
    return (comments ?? []).map((c: any) => ({
      author: c.name,
      body: c.body,
      date: c.date,
      likes: c.reaction_count ?? c.reactions?.["❤"] ?? undefined,
      replies: c.children ? this.slimComments(c.children) : undefined,
    }));
  }

  // Fetch a Substack author's public profile by handle (bio, links, publications they write for)
  getAuthorProfile(handle: string) {
    return this.request("https://substack.com", `/api/v1/user/${handle}/public_profile`);
  }

  // List publications a given publication recommends to its readers
  async getRecommendations(domain: string) {
    const [recent] = await this.listPublished(domain, 0, 1);
    if (!recent) throw new Error(`Could not find any posts on ${domain} to resolve its publication id`);
    const post: any = await this.request(domain, `/api/v1/posts/${recent.slug}`);
    const recs: any[] = await this.request(domain, `/api/v1/recommendations/from/${post.publication_id}`);
    return recs.map((r) => ({
      name: r.recommendedPublication?.name,
      subdomain: r.recommendedPublication?.subdomain,
      custom_domain: r.recommendedPublication?.custom_domain,
      description: r.recommendedPublication?.hero_text,
    }));
  }

  // List recent Notes (Substack's short-form feed) from your home timeline
  async getNotesFeed(limit = 20) {
    const feed: any = await this.request("https://substack.com", "/api/v1/reader/feed", { limit: clampLimit(limit, 20) });
    const items: any[] = feed.items ?? [];
    return items.map((item: any) => {
      const comment = item.comment ?? item;
      return {
        author: comment.name ?? item.context?.users?.[0]?.name,
        body: comment.body,
        date: comment.date ?? item.context?.timestamp,
        likes: comment.reaction_count,
        url: comment.canonical_url ?? comment.canonical_link,
      };
    });
  }
}

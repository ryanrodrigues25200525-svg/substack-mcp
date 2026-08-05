import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname } from "path";

// Substack has no per-publication topic/category field — postTags is free-text set by
// each author on individual posts, mostly empty, and where present it's a section label
// ("Trading Posts") rather than a genre. So this is a user-defined layer, kept local:
// nothing here is a Substack API call.
// Read lazily rather than once at import time, so a test can point this at a temp file
// per run without spawning a subprocess.
function tagsFilePath(): string {
  return process.env.SUBSTACK_MCP_TAGS_FILE || `${homedir()}/.substack-mcp/tags.json`;
}

type TagMap = Record<string, string[]>; // domain -> tags

function normalizeDomain(domain: string): string {
  return domain
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

async function readTags(): Promise<TagMap> {
  try {
    return JSON.parse(await readFile(tagsFilePath(), "utf8"));
  } catch (err: any) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

// ponytail: read-modify-write, no file lock. Fine for one local MCP server process
// talking to one client; a lock would matter if two clients wrote concurrently.
async function writeTags(tags: TagMap): Promise<void> {
  const path = tagsFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(tags, null, 2));
}

// Replaces the tag set for a domain. An empty array untags it — no separate remove tool.
export async function setTags(domain: string, tags: string[]): Promise<string[]> {
  const key = normalizeDomain(domain);
  const clean = [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
  const all = await readTags();
  if (clean.length === 0) delete all[key];
  else all[key] = clean;
  await writeTags(all);
  return clean;
}

export async function getTagMap(): Promise<TagMap> {
  return readTags();
}

export async function domainsForTag(tag: string): Promise<Set<string>> {
  const all = await readTags();
  const needle = tag.trim().toLowerCase();
  return new Set(Object.entries(all).filter(([, tags]) => tags.includes(needle)).map(([domain]) => domain));
}

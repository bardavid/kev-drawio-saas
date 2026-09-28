import { componentsFromBrief, ideaSubject } from "@/lib/kev/scale";

/**
 * Short factual notes for diagram topics the planner may not know.
 * Wikipedia's public summary API needs no key. Failures fall back to a
 * built-in brief so demo mode and offline tests never wait on the network.
 */

export interface TopicBrief {
  topic: string;
  summary: string;
  source: "builtin" | "web";
}

export const REDIS_USAGE_BRIEF =
  "Redis is an in-memory data store commonly used as a cache. A client calls an application, which reads Redis first and returns a hit. On a miss the application loads the database and writes the value back into Redis. A Redis server replicates to a replica and persists with RDB snapshots or an append-only file.";

const WIKI_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const FETCH_TIMEOUT_MS = 1500;

export function redisDiagramRequest(message: string): boolean {
  if (!/\bredis\b/i.test(message)) return false;
  if (/\bsequence\b/i.test(message)) return false;
  if (/\b(workflow|flowchart)\b/i.test(message)) return false;
  if (/\bin front of\b/i.test(message)) return false;
  // "3-tier web app with Redis" is a tier stack that includes a cache, not a Redis usage diagram.
  if (/\b(\d+|two|three|four|five)[\s-]*tier\b/i.test(message)) return false;
  return /\b(usage|diagram|architecture)\b/i.test(message);
}

function classicUsageTitle(message: string): string | null {
  if (!/\b(draw|sketch)\b/i.test(message) || !/\bdiagram\b/i.test(message)) return null;
  if (!/\b(usage|architecture)\b/i.test(message)) return null;
  if (/\bsequence\b/i.test(message) || /\b(workflow|flowchart)\b/i.test(message)) return null;
  const subject = message
    .replace(/^(?:please\s+)?(?:draw|sketch)\s+(?:me\s+)?(?:a|an|the\s+)?/i, "")
    .replace(/\b(diagram|usage|architecture)\b/gi, " ")
    .replace(/[^a-z0-9 .+_-]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!subject || subject.length < 2 || subject.length > 60) return null;
  if (/^(complex|tier|web|app|system|sequence)$/i.test(subject)) return null;
  return subject
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/** Wikipedia page title for a draw-a-topic-diagram request, or null when research should not run. */
export function wikipediaTitle(message: string): string | null {
  if (redisDiagramRequest(message)) return "Redis";
  return classicUsageTitle(message);
}

export function builtinBrief(message: string): TopicBrief | null {
  if (redisDiagramRequest(message)) return { topic: "Redis", summary: REDIS_USAGE_BRIEF, source: "builtin" };
  return null;
}

function clipBrief(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 480) return clean;
  const cut = clean.slice(0, 480);
  const stop = cut.lastIndexOf(". ");
  return stop > 160 ? cut.slice(0, stop + 1) : `${cut.trim()}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** GET a short Wikipedia summary. Returns null on any failure, including offline. */
export async function fetchTopicBrief(title: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const page = title.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 .()+_-]{0,80}$/.test(page)) return null;
  const url = `${WIKI_SUMMARY}${encodeURIComponent(page.replace(/ /g, "_"))}`;
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        "user-agent": "draw.ai (https://github.com/bardavid/kev-drawio-saas)",
      },
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json().catch(() => null);
    const record = asRecord(payload);
    const extract = typeof record?.extract === "string" ? record.extract : "";
    const summary = clipBrief(extract);
    if (summary.length < 40) return null;
    return summary;
  } catch {
    return null;
  }
}

/**
 * Built-in brief immediately when `network` is false or the lookup fails.
 * Unknown topics return a web summary only, or null offline.
 */
export async function researchTopic(
  message: string,
  options?: { network?: boolean; fetch?: typeof fetch },
): Promise<TopicBrief | null> {
  const title = wikipediaTitle(message);
  const builtin = builtinBrief(message);
  if (!title && !builtin) return null;
  if (options?.network && title) {
    const live = await fetchTopicBrief(title, options.fetch ?? fetch);
    if (live) return { topic: title, summary: live, source: "web" };
  }
  return builtin;
}

const LEADING_TOPIC_WORD =
  /^(?:subsystem|system|service|platform|product|overview|diagram|architecture|design|model|flow|process|general|purpose|of|for|with|about)$/i;

/**
 * Lookup titles for one idea, longest first.
 * A generic head ("subsystem of") is dropped, then words come off the end,
 * then a shorter trailing phrase is tried. The first title is the full subject.
 */
export function topicLookupCandidates(subject: string): string[] {
  const words = subject.split(/\s+/).filter(Boolean);
  const candidates: string[] = [];
  const push = (slice: string[]) => {
    const title = slice.join(" ").trim();
    if (title.length < 2) return;
    if (candidates.some((item) => item.toLowerCase() === title.toLowerCase())) return;
    candidates.push(title);
  };
  push(words);
  let core = [...words];
  while (core.length > 2 && LEADING_TOPIC_WORD.test(core[0] ?? "")) core = core.slice(1);
  push(core);
  if (core.length > 2) push(core.slice(0, -1));
  if (core.length > 3) push(core.slice(0, -2));
  if (core.length >= 3) push(core.slice(-3));
  if (core.length >= 2) push(core.slice(-2));
  return candidates.slice(0, 5);
}

/**
 * One page summary. An exact page that does not name enough interacting parts
 * is unusable, so the caller can try a shorter title. A missing page falls
 * through to a public search title, and that summary must also name parts.
 */
async function usableTopicSummary(title: string, fetchImpl: typeof fetch): Promise<string | null> {
  const exact = await fetchTopicBrief(title, fetchImpl);
  if (exact) return componentsFromBrief(exact) ? exact : null;
  const found = await searchWikiTitle(title, fetchImpl);
  if (!found || found.toLowerCase() === title.toLowerCase()) return null;
  const live = await fetchTopicBrief(found, fetchImpl);
  if (!live || !componentsFromBrief(live)) return null;
  return live;
}

/**
 * Topic notes for a detailed idea whose components were not named.
 * The full subject is looked up first. When that brief does not name enough
 * interacting parts, shorter titles are tried. Offline, or when no brief
 * names those parts, this returns null. There is no built-in diagram for an
 * unnamed topic.
 */
export async function researchIdea(
  message: string,
  options?: { network?: boolean; fetch?: typeof fetch },
): Promise<TopicBrief | null> {
  const topic = ideaSubject(message);
  if (!topic || !options?.network) return null;
  const fetchImpl = options.fetch ?? fetch;
  for (const candidate of topicLookupCandidates(topic)) {
    if (!wikiTitle(candidate)) continue;
    const summary = await usableTopicSummary(candidate, fetchImpl);
    if (summary) return { topic: candidate, summary, source: "web" };
  }
  return null;
}

function wikiTitle(title: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 .()+_-]{0,80}$/.test(title);
}

async function searchWikiTitle(query: string, fetchImpl: typeof fetch): Promise<string | null> {
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&namespace=0&format=json&search=${encodeURIComponent(query)}`;
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        "user-agent": "draw.ai (https://github.com/bardavid/kev-drawio-saas)",
      },
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json().catch(() => null);
    if (!Array.isArray(payload) || !Array.isArray(payload[1])) return null;
    const title = payload[1][0];
    if (typeof title !== "string" || !wikiTitle(title.trim())) return null;
    return title.trim();
  } catch {
    return null;
  }
}

/**
 * An underspecified "subsystem / interactions / how it works" ask.
 * The words name the topic. They are not the boxes.
 */

const TIER_ASK = /\b(\d+|two|three|four|five)[\s-]*(?:tiers?|layers?)\b/i;

/** Glue the chain planner used to promote into a vertex. */
const PLAN_FRAGMENT = new Set([
  "storage",
  "interaction",
  "interactions",
  "general",
  "purpose",
  "caching",
  "cache",
  "subsystem",
  "subsystems",
  "system",
  "systems",
  "architecture",
  "architectures",
  "kv",
  "queueing",
  "queuing",
  "messaging",
]);

export function isInteractionAsk(text: string): boolean {
  if (TIER_ASK.test(text)) return false;
  if (/\bsub-?systems?\b/i.test(text)) return true;
  if (/\binteractions?\b/i.test(text)) return true;
  return /\bhow\b/i.test(text) && /\bworks\b/i.test(text);
}

export function planNodeIsAskFragment(label: string): boolean {
  return PLAN_FRAGMENT.has(label.trim().toLowerCase());
}

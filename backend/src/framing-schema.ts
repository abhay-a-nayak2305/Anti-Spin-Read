import type { IFraming } from "./types.js";

/**
 * Canonical framing validation + normalization.
 *
 * Shared by the Gemini client (framing.ts) and the data layer (db.ts):
 * the same structural rules that accept model output also gate what gets
 * persisted and what gets served back from D1 — so a corrupted row can
 * never surface as valid content.
 */

export const ALLOWED_TONES = new Set([
  "neutral",
  "urgent",
  "alarmist",
  "skeptical",
  "celebratory",
  "analytical",
]);

export const MAX_HEADLINE_DELTAS = 10;
export const MAX_NOTABLE_OMISSIONS = 10;
export const MAX_TONE_TAGS = 15;

function strArray(v: unknown, cap: number): string[] {
  return Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((s) => s.trim())
        .slice(0, cap)
    : [];
}

/**
 * Validate + normalize an unknown value into an IFraming.
 * Throws when the value cannot produce a useful framing (mirrors the
 * "no silent degradation" rule: an empty success is a failure).
 */
export function normalizeFraming(raw: unknown): IFraming {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("model output is not a JSON object");
  }
  const o = raw as Record<string, unknown>;

  const toneTags = Array.isArray(o.toneTags)
    ? o.toneTags
        .filter(
          (t): t is { source: string; tone: string } =>
            typeof t === "object" &&
            t !== null &&
            typeof (t as any).source === "string" &&
            (t as any).source.trim().length > 0 &&
            typeof (t as any).tone === "string" &&
            ALLOWED_TONES.has((t as any).tone.toLowerCase())
        )
        .map((t) => ({
          source: t.source.trim(),
          tone: t.tone.toLowerCase(),
        }))
        .slice(0, MAX_TONE_TAGS)
    : [];

  const headlineDeltas = strArray(o.headlineDeltas, MAX_HEADLINE_DELTAS);
  const notableOmissions = strArray(o.notableOmissions, MAX_NOTABLE_OMISSIONS);
  const neutralSummary =
    typeof o.neutralSummary === "string" ? o.neutralSummary.trim() : "";

  // Reject silent degradation: an "empty success" would permanently mark
  // the cluster as framed with no useful content.
  if (!neutralSummary) {
    throw new Error("model output missing neutralSummary");
  }
  if (headlineDeltas.length === 0 && toneTags.length === 0) {
    throw new Error("model output has no headlineDeltas or toneTags");
  }

  return { headlineDeltas, toneTags, notableOmissions, neutralSummary };
}

/**
 * Parse + validate a stored framing JSON string.
 * Returns null (never throws) for anything that isn't a valid framing —
 * callers treat null as "corrupt row, skip it".
 */
export function parseFraming(json: string): IFraming | null {
  try {
    return normalizeFraming(JSON.parse(json));
  } catch {
    return null;
  }
}

/** True when the value is a structurally valid framing (used by tests). */
export function isFraming(v: unknown): v is IFraming {
  try {
    normalizeFraming(v);
    return true;
  } catch {
    return false;
  }
}
import { frameCluster } from "../src/framing.js";
import type { IFraming } from "../src/types.js";
import type { ClusteredArticle } from "../src/cluster.js";

/**
 * Framing evaluator.
 *
 * Offline mode (default): replays a corpus of realistic Gemini-style
 * outputs (fenced, prose-wrapped, malformed tones, caps) through the real
 * frameCluster + normalization pipeline and scores pass rates.
 *
 * Live mode (GEMINI_API_KEY set): calls Gemini once on a two-outlet cluster
 * and scores the result for spec compliance. Useful for prompt iteration:
 *   GEMINI_API_KEY=... npx tsx scripts/eval-framing.ts --live
 */

const ALLOWED_TONES = new Set(["neutral", "urgent", "alarmist", "skeptical", "celebratory", "analytical"]);

function art(source: string, title: string): ClusteredArticle {
  return {
    dedupKey: `${source}|${title}`,
    source,
    title,
    url: `https://x.example/${source}`,
    lede: "some lede text",
    publishedAt: new Date(),
    imageUrl: "",
    tokens: [],
    tokenSet: new Set(),
  };
}

function scoreFraming(f: IFraming): { points: number; max: number; notes: string[] } {
  const notes: string[] = [];
  let points = 0;
  const max = 6;
  if (f.neutralSummary.length >= 60) { points++; } else { notes.push("summary short"); }
  if (f.headlineDeltas.length >= 1) { points++; } else { notes.push("no deltas"); }
  if (f.headlineDeltas.every((d) => /[A-Z]{2,}|[a-z]{4,}/.test(d) && d.length > 30)) { points++; } else { notes.push("deltas not specific"); }
  if (f.toneTags.length >= 2 && f.toneTags.every((t) => ALLOWED_TONES.has(t.tone))) { points++; } else { notes.push("toneTags missing/invalid"); }
  if (f.toneTags.every((t) => /^[A-Za-z ]+$/.test(t.source))) { points++; } else { notes.push("source names malformed"); }
  if (f.notableOmissions.every((o) => o.length > 20)) { points++; } else { notes.push("omissions not specific"); }
  return { points, max, notes };
}

const corpus: { name: string; body: string }[] = [
  { name: "clean", body: '{"headlineDeltas":["CNN leads with the human toll in its headline, quoting a survivor account.","Reuters leads with the economic figures, citing the central bank."],"toneTags":[{"source":"CNN","tone":"urgent"},{"source":"Reuters","tone":"neutral"}],"notableOmissions":["The environmental angle appears in AP and the Guardian but is entirely absent from CNN and Reuters coverage."],"neutralSummary":"A financial policy change took effect this week, and outlets emphasized different aspects of its impact on households and markets."}' },
  { name: "fenced", body: '```json\n{"headlineDeltas":["CNN leads with the human toll in its headline, quoting a survivor account."],"toneTags":[{"source":"CNN","tone":"alarmist"}],"notableOmissions":[],"neutralSummary":"A policy change took effect this week and outlets covered it differently in meaningful ways."}\n```' },
  { name: "prose-wrapped", body: 'Here is my analysis of the coverage:\n\n{"headlineDeltas":["The Guardian leads with the political fallout angle in its headline, naming the minister involved.","Reuters leads with the legal mechanics instead, citing the court filing."],"toneTags":[{"source":"Guardian","tone":"skeptical"},{"source":"Reuters","tone":"neutral"}],"notableOmissions":["The impact on small businesses is present in the BBC and AP pieces but missing from the Guardian and Reuters coverage."],"neutralSummary":"A new court ruling reshaped the regulatory landscape this week, with outlets framing the decision through different lenses."}\n\nLet me know if you need more detail.' },
  { name: "bad-tones", body: '{"headlineDeltas":["CNN emphasizes the scale of the protests in its headline, citing crowd estimates.","BBC emphasizes the government response instead, quoting officials."],"toneTags":[{"source":"CNN","tone":"hysterical"},{"source":"BBC","tone":"balanced"},{"source":"AP","tone":"analytical"}],"notableOmissions":[],"neutralSummary":"Protests continued for a third day in the capital, with outlets focusing on different aspects of the standoff."}' },
  { name: "overlong", body: JSON.stringify({
    headlineDeltas: Array.from({ length: 14 }, (_, i) => `Outlet ${i} leads with a distinct angle in its headline, emphasizing a different aspect of the story for its readers.`),
    toneTags: Array.from({ length: 25 }, (_, i) => ({ source: `Outlet${i}`, tone: "neutral" })),
    notableOmissions: [],
    neutralSummary: "A major event occurred this week and news outlets covered it with varying emphasis and tone across their platforms.",
  }) },
  { name: "garbage", body: "I'm sorry, but I can't help with that request." },
  { name: "empty-summary", body: '{"headlineDeltas":["CNN leads with the human toll in its headline."],"toneTags":[],"notableOmissions":[],"neutralSummary":""}' },
  { name: "not-object", body: '["just", "an", "array"]' },
];

let live = process.argv.includes("--live");
if (process.env.GEMINI_API_KEY) live = true;

async function offline(): Promise<void> {
  console.log("== offline corpus ==");
  const originalFetch = globalThis.fetch;
  let pass = 0;
  let total = 0;
  try {
    for (const item of corpus) {
      total++;
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: item.body }] } }] }),
      })) as unknown as typeof fetch;
      try {
        const f = await frameCluster([art("CNN", "Protesters gather in capital for third day"), art("BBC", "Capital protests continue as government responds")], { apiKey: "eval", model: "gemini-eval" });
        const { points, max, notes } = scoreFraming(f);
        const ok = item.name !== "garbage" && item.name !== "empty-summary" && item.name !== "not-object";
        const quality = points / max;
        if (ok) {
          pass++;
          console.log(`  OK   ${item.name} (quality ${quality.toFixed(2)})${notes.length ? " — " + notes.join("; ") : ""}`);
        } else {
          console.log(`  FAIL ${item.name} — should have been REJECTED but parsed (quality ${quality.toFixed(2)})`);
        }
      } catch (e) {
        const rejected = item.name === "garbage" || item.name === "empty-summary" || item.name === "not-object";
        if (rejected) {
          pass++;
          console.log(`  OK   ${item.name} — correctly rejected (${e instanceof Error ? e.message : String(e)})`);
        } else {
          console.log(`  FAIL ${item.name} — unexpectedly rejected (${e instanceof Error ? e.message : String(e)})`);
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log(`corpus: ${pass}/${total} behaviors correct`);
  return;
}

async function liveEval(): Promise<void> {
  console.log("== live Gemini eval ==");
  const f = await frameCluster(
    [art("CNN", "Ousted Syrian dictator Bashar al-Assad sentenced to death in absentia"), art("BBC", "Former Syrian President Assad sentenced to death in absentia")],
    { apiKey: process.env.GEMINI_API_KEY!, model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash" }
  );
  const { points, max, notes } = scoreFraming(f);
  console.log(JSON.stringify(f, null, 2));
  console.log(`score: ${points}/${max}${notes.length ? " — " + notes.join("; ") : ""}`);
  if (points < 4) process.exitCode = 1;
}

if (live) {
  await liveEval();
} else {
  await offline();
}
console.log("done");
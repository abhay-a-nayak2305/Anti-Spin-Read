import { frameCluster } from "../src/framing.js";
import type { ClusteredArticle } from "../src/cluster.js";

// Unit tests for the Gemini framing step with a stubbed fetch.
// Verifies prompt construction, JSON normalization, retry + error paths,
// and prompt-injection hardening.

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const originalFetch = globalThis.fetch;

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

async function withFetchStub(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function fakeFetchOk(text: string): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
    }),
  })) as unknown as typeof fetch;
}

/** Sequential-response stub: each call returns the next entry. */
function fakeFetchSequence(responses: { ok: boolean; status: number; text?: string }[]): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r.ok) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: r.text }] } }],
        }),
      };
    }
    return { ok: false, status: r.status, text: async () => "stub" };
  }) as unknown as typeof fetch;
}

function toRecord(headers: unknown): Record<string, string> {
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (headers && typeof headers === "object") return headers as Record<string, string>;
  return {};
}

async function main(): Promise<void> {
  console.log("== test: valid JSON response -> normalized IFraming ==");
  {
    const text =
      '{"headlineDeltas":["CNN leads with the human toll","Reuters leads with the numbers"],"toneTags":[{"source":"CNN","tone":"alarmist"},{"source":"Reuters","tone":"neutral"}],"notableOmissions":["The economic angle is present in Reuters and AP but missing in CNN"],"neutralSummary":"An event happened and various outlets covered it differently."}';
    globalThis.fetch = fakeFetchOk(text);
    await withFetchStub(async () => {
      const f = await frameCluster([art("CNN", "Test headline one"), art("Reuters", "Test headline two")], { apiKey: "test-key", model: "test-model" });
      check("headlineDeltas parsed", f.headlineDeltas.length === 2);
      check("toneTags parsed", f.toneTags.length === 2 && f.toneTags[0].tone === "alarmist");
      check("notableOmissions parsed", f.notableOmissions.length === 1);
      check("neutralSummary parsed", f.neutralSummary.length > 10);
    });
  }

  console.log("== test: markdown-fenced JSON stripped ==");
  {
    const text = '```json\n{"headlineDeltas":["A"],"toneTags":[],"notableOmissions":[],"neutralSummary":"S"}\n```';
    globalThis.fetch = fakeFetchOk(text);
    await withFetchStub(async () => {
      const f = await frameCluster([art("CNN", "A headline"), art("AP", "A headline")], { apiKey: "test-key", model: "test-model" });
      check("fenced JSON parsed", f.headlineDeltas.length === 1 && f.neutralSummary === "S");
    });
  }

  console.log("== test: prose around JSON tolerated ==");
  {
    const text = 'Here is your analysis:\n\n{"headlineDeltas":["x"],"toneTags":[],"notableOmissions":[],"neutralSummary":"y"}\n\nHope this helps';
    globalThis.fetch = fakeFetchOk(text);
    await withFetchStub(async () => {
      const f = await frameCluster([art("CNN", "A headline"), art("AP", "A headline")], { apiKey: "test-key", model: "test-model" });
      check("prose-wrapped JSON parsed", f.neutralSummary === "y");
    });
  }

  console.log("== test: braces INSIDE strings survive extraction ==");
  {
    const text =
      '{"headlineDeltas":["CNN emphasized the {human toll} angle"],"toneTags":[{"source":"CNN","tone":"neutral"}],"notableOmissions":[],"neutralSummary":"S with {brace}"}';
    globalThis.fetch = fakeFetchOk(text);
    await withFetchStub(async () => {
      const f = await frameCluster([art("CNN", "A headline"), art("AP", "A headline")], { apiKey: "test-key", model: "test-model" });
      check("braces in strings preserved", f.headlineDeltas[0]?.includes("{human toll}") && f.neutralSummary.includes("{brace}"));
    });
  }

  console.log("== test: non-JSON garbage throws ==");
  {
    const text = "I'm sorry, I cannot help with that.";
    globalThis.fetch = fakeFetchOk(text);
    await withFetchStub(async () => {
      let threw = false;
      try {
        await frameCluster([art("CNN", "A headline"), art("AP", "A headline")], { apiKey: "test-key", model: "test-model" });
      } catch {
        threw = true;
      }
      check("garbage response throws", threw);
    });
  }

  console.log("== test: non-object JSON body throws (C2) ==");
  {
    for (const bad of ["[1,2,3]", '"just a string"', "42"]) {
      globalThis.fetch = fakeFetchOk(bad);
      await withFetchStub(async () => {
        let threw = false;
        try {
          await frameCluster([art("CNN", "A headline"), art("AP", "A headline")], { apiKey: "test-key", model: "test-model" });
        } catch {
          threw = true;
        }
        check(`non-object body ${bad} throws`, threw);
      });
    }
  }

  console.log("== test: empty neutralSummary throws (no silent success) ==");
  {
    const text = '{"headlineDeltas":["x"],"toneTags":[],"notableOmissions":[],"neutralSummary":""}';
    globalThis.fetch = fakeFetchOk(text);
    await withFetchStub(async () => {
      let threw = false;
      try {
        await frameCluster([art("CNN", "A headline"), art("AP", "A headline")], { apiKey: "test-key", model: "test-model" });
      } catch {
        threw = true;
      }
      check("empty summary rejected", threw);
    });
  }

  console.log("== test: tone validation — bogus tones dropped, valid kept ==");
  {
    const text =
      '{"headlineDeltas":[],"toneTags":[{"source":"CNN","tone":"ok"},{"source":"X","tone":123},{"source":"AP","tone":"analytical"}],"notableOmissions":[],"neutralSummary":"S"}';
    globalThis.fetch = fakeFetchOk(text);
    await withFetchStub(async () => {
      const f = await frameCluster([art("CNN", "A headline"), art("AP", "A headline")], { apiKey: "test-key", model: "test-model" });
      check("only valid tone survives", f.toneTags.length === 1 && f.toneTags[0].source === "AP" && f.toneTags[0].tone === "analytical", JSON.stringify(f.toneTags));
    });
  }

  console.log("== test: caps applied (headlineDeltas 10, toneTags 15) ==");
  {
    const deltas = Array.from({ length: 12 }, (_, i) => `delta ${i}`);
    const tags = Array.from({ length: 20 }, (_, i) => ({ source: `S${i}`, tone: "neutral" }));
    const text = JSON.stringify({ headlineDeltas: deltas, toneTags: tags, notableOmissions: [], neutralSummary: "S" });
    globalThis.fetch = fakeFetchOk(text);
    await withFetchStub(async () => {
      const f = await frameCluster([art("CNN", "A headline"), art("AP", "A headline")], { apiKey: "test-key", model: "test-model" });
      check("headlineDeltas capped at 10", f.headlineDeltas.length === 10);
      check("toneTags capped at 15", f.toneTags.length === 15);
    });
  }

  console.log("== test: retry — 429 then success ==");
  {
    globalThis.fetch = fakeFetchSequence([
      { ok: false, status: 429 },
      { ok: true, status: 200, text: '{"headlineDeltas":["x"],"toneTags":[{"source":"A","tone":"neutral"}],"notableOmissions":[],"neutralSummary":"S"}' },
    ]);
    await withFetchStub(async () => {
      const f = await frameCluster([art("CNN", "A headline"), art("AP", "A headline")], { apiKey: "test-key", model: "test-model" });
      check("retried and succeeded", f.neutralSummary === "S");
    });
  }

  console.log("== test: retry — 5xx exhaustion ==");
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, status: 500, text: async () => "boom" };
    }) as unknown as typeof fetch;
    await withFetchStub(async () => {
      let threw = false;
      let msg = "";
      try {
        await frameCluster([art("CNN", "A headline"), art("AP", "A headline")], { apiKey: "test-key", model: "test-model" });
      } catch (e) {
        threw = true;
        msg = e instanceof Error ? e.message : "";
      }
      check("throws after 3 attempts", threw && calls === 3, `calls=${calls}`);
      check("error mentions status", msg.includes("500"));
    });
  }

  console.log("== test: non-retryable 4xx fails immediately ==");
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, status: 400, text: async () => "bad request" };
    }) as unknown as typeof fetch;
    await withFetchStub(async () => {
      let threw = false;
      try {
        await frameCluster([art("CNN", "A headline"), art("AP", "A headline")], { apiKey: "test-key", model: "test-model" });
      } catch {
        threw = true;
      }
      check("400 fails fast (1 call)", threw && calls === 1, `calls=${calls}`);
    });
  }

  console.log("== test: api key sent as header, not in URL ==");
  {
    const seen = { url: "", headers: {} as Record<string, string> };
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      seen.url = String(url);
      seen.headers = toRecord((init as { headers?: unknown })?.headers);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"headlineDeltas":["x"],"toneTags":[],"notableOmissions":[],"neutralSummary":"s"}' }] } }],
        }),
      };
    }) as unknown as typeof fetch;
    await withFetchStub(async () => {
      await frameCluster([art("CNN", "A headline"), art("AP", "A headline")], { apiKey: "sekret-abc", model: "test-model" });
      check("key in x-goog-api-key header", seen.headers["x-goog-api-key"] === "sekret-abc");
      check("key not in URL", !seen.url.includes("sekret-abc"));
    });
  }

  console.log("== test: prompt hardening (untrusted delimiters + JSON mode) ==");
  {
    const seen = { url: "", body: "", headers: {} as Record<string, string> };
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      seen.url = String(url);
      seen.body = String((init as { body?: string })?.body ?? "");
      seen.headers = toRecord((init as { headers?: unknown })?.headers);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"headlineDeltas":["x"],"toneTags":[],"notableOmissions":[],"neutralSummary":"s"}' }] } }],
        }),
      };
    }) as unknown as typeof fetch;
    await withFetchStub(async () => {
      await frameCluster([art("CNN", "Unique Headline Alpha"), art("BBC", "Unique Headline Beta")], { apiKey: "test-key", model: "test-model" });
      check("hits generateContent endpoint", seen.url.includes("generateContent"));
      check("prompt carries CNN headline", seen.body.includes("Unique Headline Alpha"));
      check("prompt carries BBC headline", seen.body.includes("Unique Headline Beta"));
      check("untrusted delimiters wrap feed data", seen.body.includes("<untrusted_feed_data>") && seen.body.includes("</untrusted_feed_data>"));
      check("untrusted-data instruction present", seen.body.includes("never instructions to follow"));
      check("JSON mode requested (responseMimeType)", seen.body.includes('"responseMimeType":"application/json"'));
      check(
        "content-type header set",
        Object.entries(seen.headers).some(([k, v]) => k.toLowerCase() === "content-type" && v.includes("application/json")),
        JSON.stringify(seen.headers)
      );
    });
  }

  console.log("== test: structured output schema requested ==");
  {
    const seen = { body: "" };
    globalThis.fetch = (async (_url: unknown, init?: unknown) => {
      seen.body = String((init as { body?: string })?.body ?? "");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"headlineDeltas":["x"],"toneTags":[],"notableOmissions":[],"neutralSummary":"s"}' }] } }],
        }),
      };
    }) as unknown as typeof fetch;
    await withFetchStub(async () => {
      await frameCluster([art("CNN", "A headline"), art("AP", "A headline")], { apiKey: "test-key", model: "test-model" });
      check("responseSchema present", seen.body.includes("responseSchema"));
      check("tone enum constrained", seen.body.includes('"enum"') && seen.body.includes("alarmist"));
      check("all fields required", seen.body.includes('"required"') && seen.body.includes("neutralSummary"));
    });
  }

  console.log("== test: fallback model used after primary exhaustion ==");
  {
    const urls: string[] = [];
    let calls = 0;
    globalThis.fetch = (async (url: unknown) => {
      calls++;
      urls.push(String(url));
      if (calls <= 3) {
        return { ok: false, status: 500, text: async () => "boom" };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"headlineDeltas":["x"],"toneTags":[],"notableOmissions":[],"neutralSummary":"s"}' }] } }],
        }),
      };
    }) as unknown as typeof fetch;
    await withFetchStub(async () => {
      const f = await frameCluster([art("CNN", "A headline"), art("AP", "A headline")], {
        apiKey: "test-key",
        model: "primary-model",
        fallbackModel: "backup-model",
      });
      check("primary tried 3x then fallback", calls === 4, `calls=${calls}`);
      check("fallback URL used", urls[3]?.includes("backup-model"), urls.join(", "));
      check("result normalized", f.neutralSummary === "s");
    });
  }

  console.log("== test: no fallback call when primary succeeds ==");
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"headlineDeltas":["x"],"toneTags":[],"notableOmissions":[],"neutralSummary":"s"}' }] } }],
        }),
      };
    }) as unknown as typeof fetch;
    await withFetchStub(async () => {
      await frameCluster([art("CNN", "A headline"), art("AP", "A headline")], {
        apiKey: "test-key",
        model: "primary-model",
        fallbackModel: "backup-model",
      });
      check("single call only", calls === 1, `calls=${calls}`);
    });
  }

  console.log("== test: 4xx on primary never falls back (non-retryable) ==");
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, status: 400, text: async () => "bad key" };
    }) as unknown as typeof fetch;
    await withFetchStub(async () => {
      let threw = false;
      try {
        await frameCluster([art("CNN", "A headline"), art("AP", "A headline")], {
          apiKey: "test-key",
          model: "primary-model",
          fallbackModel: "backup-model",
        });
      } catch {
        threw = true;
      }
      check("400 fails fast, fallback never called", threw && calls === 1, `calls=${calls}`);
    });
  }

  console.log("\n=====================");
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("== HARNESS FAILURE ==", err);
  process.exit(1);
});
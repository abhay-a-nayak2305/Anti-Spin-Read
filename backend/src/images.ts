import type { Db } from "./db.js";
import type { RawArticle } from "./types.js";

const FETCH_TIMEOUT_MS = 6000;
const CONCURRENCY = 5;
const MAX_BODY_CHARS = 512 * 1024;

const PRIVATE_HOST_RE =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[?::1\]?|172\.(1[6-9]|2\d|3[01])\.)/i;
const RESERVED_SUFFIX_RE =
  /\.(local|internal|localhost|test|invalid|home\.arpa)$/i;

/**
 * Parse an IPv4 literal in ANY representation a resolver accepts
 * (inet_aton compatibility): dotted decimal "127.0.0.1", decimal
 * "2130706433", hex "0x7f000001", octal "0177.0.0.1", short forms
 * "127.1" (127.0.0.1). Returns 4 octets or null when not an IPv4 literal.
 */
function parseIpv4Literal(host: string): number[] | null {
  if (!host || host.includes(":")) return null;
  if (!/^[0-9a-fA-Fx.]+$/.test(host)) return null;
  const parts = host.split(".");

  const parsePart = (part: string): number | null => {
    if (/^0x/i.test(part)) {
      const hex = part.slice(2);
      if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
      return parseInt(hex, 16);
    }
    if (!/^\d+$/.test(part)) return null;
    // Leading zero => octal (inet_aton). Digits 8/9 are ambiguous
    // between parsers — fail closed instead of guessing.
    if (part.length > 1 && part.startsWith("0")) {
      if (/[89]/.test(part)) return null;
      return parseInt(part, 8);
    }
    return parseInt(part, 10);
  };

  let octets: number[];
  if (parts.length === 1) {
    // Single 32-bit value (decimal or hex)
    const v = parsePart(parts[0]);
    if (v === null || v > 0xffffffff) return null;
    octets = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  } else {
    if (parts.length > 4) return null;
    octets = [];
    for (const p of parts) {
      const v = parsePart(p);
      if (v === null || v > 255) return null;
      octets.push(v);
    }
    // inet_aton short forms: "127.1" -> 127.0.0.1
    while (octets.length < 4) octets.push(0);
  }
  return octets;
}

/** All IPv4 ranges that must never be fetched (private + special-purpose). */
function isReservedIpv4(o: number[]): boolean {
  const [a, b, c] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192) {
    if (b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
    if (b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
    if (b === 88 && c === 99) return true; // 192.88.99.0/24 deprecated 6to4 relay
    if (b === 168) return true; // 192.168.0.0/16 private
  }
  if (a === 198) {
    if (b === 18 || b === 19) return true; // 198.18.0.0/15 benchmarking
    if (b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  }
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // multicast 224/4, reserved 240/4, limited broadcast
  return false;
}

/**
 * Expand an IPv6 literal (brackets optional) to 8 hex groups, or null.
 * Handles "::" compression and IPv4-mapped forms ("::ffff:1.2.3.4").
 */
function expandIpv6(host: string): string[] | null {
  let h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h) return null;
  const v4tail = h.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  let v4octets: number[] | null = null;
  let head: string;
  if (v4tail) {
    head = v4tail[1];
    v4octets = parseIpv4Literal(v4tail[2]);
    if (!v4octets) return null;
  } else {
    head = h;
  }
  const hasDouble = head.includes("::");
  if (hasDouble && head.split("::").length > 2) return null;
  const groups = head.split("::");
  const left = groups[0] ? groups[0].split(":") : [];
  const right = groups[1] ? groups[1].split(":") : [];
  for (const g of [...left, ...right]) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  }
  const v4Groups = v4octets ? 2 : 0;
  const missing = 8 - left.length - right.length - v4Groups;
  if (missing < 0) return null;
  if (!hasDouble && missing !== 0) return null;
  const out: string[] = left.map((g) => g.padStart(4, "0"));
  for (let i = 0; i < missing; i++) out.push("0000");
  for (const g of right) out.push(g.padStart(4, "0"));
  if (v4octets) {
    out.push(
      ((v4octets[0] << 8) | v4octets[1]).toString(16).padStart(4, "0"),
      ((v4octets[2] << 8) | v4octets[3]).toString(16).padStart(4, "0")
    );
  }
  return out.length === 8 ? out : null;
}

/** IPv6 special-purpose ranges that must never be fetched. */
function isReservedIpv6(g: string[]): boolean {
  if (g.every((x) => x === "0000")) return true; // :: unspecified
  if (g.slice(0, 7).every((x) => x === "0000") && g[7] === "0001") return true; // ::1 loopback
  // IPv4-mapped / IPv4-compatible: validate the embedded IPv4
  if (g.slice(0, 5).every((x) => x === "0000")) {
    const e = (h: string) => parseInt(h, 16);
    if (g[5] === "ffff") {
      const octets = [
        e(g[6].slice(0, 2)),
        e(g[6].slice(2)),
        e(g[7].slice(0, 2)),
        e(g[7].slice(2)),
      ];
      return isReservedIpv4(octets);
    }
    // IPv4-compatible ::a.b.c.d (deprecated) — same embedded check
    if (g[5] === "0000" && g[6] !== "0000") {
      const octets = [
        e(g[6].slice(0, 2)),
        e(g[6].slice(2)),
        e(g[7].slice(0, 2)),
        e(g[7].slice(2)),
      ];
      return isReservedIpv4(octets);
    }
  }
  const first = parseInt(g[0], 16);
  if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7 ULA
  if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10 link-local
  if (g[0] === "2001" && g[1] === "0db8") return true; // 2001:db8::/32 documentation
  if (g[0].startsWith("ff")) return true; // ff00::/8 multicast
  return false;
}

/** Only public http(s) URLs may be fetched or served. */
export function isSafeHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  let host = parsed.hostname.toLowerCase();
  if (!host) return false;
  // FQDN trailing-dot trick: "db.internal." would bypass suffix regexes
  host = host.replace(/\.$/, "");
  if (!host) return false;

  if (host.includes(":")) {
    // IPv6 literal (WHATWG hostname keeps the brackets)
    const groups = expandIpv6(host);
    if (!groups) return false; // malformed -> fail closed
    return !isReservedIpv6(groups);
  }

  // IPv4 literals in any encoding (dotted, decimal, hex, octal, short).
  // Detection is conservative: anything numeric-shaped is parsed and,
  // if unparseable, rejected outright rather than treated as a hostname.
  if (/^\d/.test(host) || /^0x/i.test(host) || /^[0-9a-f]+$/i.test(host)) {
    const octets = parseIpv4Literal(host);
    if (octets) return !isReservedIpv4(octets);
    if (/^[\d.]+$/.test(host) || /^0x/i.test(host)) return false;
  }

  if (PRIVATE_HOST_RE.test(host)) return false;
  if (RESERVED_SUFFIX_RE.test(host)) return false;
  return true;
}

/**
 * Extract the og:image URL from raw HTML. Tolerates property/name in either
 * order relative to content, single/double quotes, and protocol-relative URLs.
 */
export function extractOgImage(html: string): string {
  const re =
    /<meta[^>]+(?:property|name)\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']|content\s*=\s*["']([^"']+)["'][^>]+(?:property|name)\s*=\s*["']og:image["']/i;
  const m = re.exec(html);
  const raw = m?.[1] ?? m?.[2] ?? "";
  if (!raw) return "";

  let url = raw.trim();
  // Protocol-relative: //img.example/x.png -> https://img.example/x.png
  if (url.startsWith("//")) url = `https:${url}`;
  return isSafeHttpUrl(url) ? url : "";
}

/** Read a Response body as text, capped at MAX_BODY_CHARS (streams, cancels). */
async function readCappedText(body: ReadableStream | null): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < MAX_BODY_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out;
}

/**
 * Fetch the og:image URL from a publisher page.
 * Workers runtime uses HTMLRewriter (streaming, cheap); Node tests fall
 * back to the regex extractor. Never follows non-http schemes, reads at
 * most MAX_BODY_CHARS, and requires a text/html content type.
 * Redirects are NOT followed (`redirect: "manual"`): every hop counts as a
 * subrequest against the Worker's 50-per-invocation budget, and article
 * URLs commonly chain 2–3 redirects. A 3xx is treated as "no image" (the
 * row retries next run). The SSRF re-check on `res.url` stays for defense
 * in depth.
 */
export async function fetchOgImage(
  url: string,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<string> {
  if (!isSafeHttpUrl(url)) return "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: {
        // A browser-like UA: several outlets (The Hill, Sky News, DW …)
        // return 403 to non-browser UAs; og:image is public page metadata,
        // the same bytes a visitor's browser would read.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) return "";
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("text/html")) return "";
    if (!isSafeHttpUrl(res.url)) return ""; // redirect chain left the public web

    if (typeof HTMLRewriter !== "undefined") {
      let found = "";
      const transformed = new HTMLRewriter()
        .on("meta", {
          element(el) {
            if (found) return;
            const key = el.getAttribute("property") ?? el.getAttribute("name");
            if (key === "og:image") {
              const content = el.getAttribute("content") ?? "";
              if (content) found = content;
            }
          },
        })
        .transform(res);
      await readCappedText(transformed.body); // drain stream so the request completes
      const og = found.trim();
      if (!og) return "";
      // Protocol-relative: //img.example/x.png -> https://img.example/x.png
      const candidate = og.startsWith("//") ? `https:${og}` : og;
      return isSafeHttpUrl(candidate) ? candidate : "";
    }

    const html = await readCappedText(res.body);
    return extractOgImage(html);
  } catch {
    // Timeout (abort), network error, or parse failure — treat as "no image";
    // enrichment retries on the next pipeline run.
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch og:image for articles that don't have one yet and persist it.
 * Runs only on articles in new clusters (keeps subrequests well under the
 * free-tier limit of 50 per invocation). Failures are logged and skipped —
 * enrichment retries on the next pipeline run.
 */
export async function enrichArticleImages(
  db: Db,
  articles: RawArticle[],
  limit = 30
): Promise<number> {
  const pending = articles.filter((a) => a.url && !a.imageUrl).slice(0, limit);
  if (pending.length === 0) return 0;

  let enriched = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const article = pending[cursor++];
      try {
        const imageUrl = await fetchOgImage(article.url);
        if (imageUrl) {
          await db.setArticleImage(article.dedupKey, imageUrl);
          enriched++;
        }
      } catch (err) {
        console.warn(`[images] ${article.source} failed: ${err}`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker)
  );
  console.log(
    `[images] enriched ${enriched}/${pending.length} articles (${pending.length - enriched} skipped/failed)`
  );
  return enriched;
}
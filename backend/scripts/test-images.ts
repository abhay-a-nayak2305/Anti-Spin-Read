import { extractOgImage, isSafeHttpUrl } from "../src/images.js";

// Unit tests for og:image extraction + URL safety + fetch behavior.

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

console.log("== test: extractOgImage ==");
{
  check(
    "standard meta property",
    extractOgImage(`<html><head><meta property="og:image" content="https://a.example/i.png"></head></html>`) ===
      "https://a.example/i.png"
  );
  check(
    "reversed attribute order (content before property)",
    extractOgImage(`<meta content="https://a.example/i.png" property="og:image">`) ===
      "https://a.example/i.png"
  );
  check(
    "name=og:image variant",
    extractOgImage(`<meta name="og:image" content="https://a.example/i.png">`) ===
      "https://a.example/i.png"
  );
  check(
    "protocol-relative -> https",
    extractOgImage(`<meta property="og:image" content="//img.example/x.png">`) ===
      "https://img.example/x.png"
  );
  check(
    "non-http scheme rejected",
    extractOgImage(`<meta property="og:image" content="file:///etc/passwd">`) === ""
  );
  check(
    "private host rejected",
    extractOgImage(`<meta property="og:image" content="http://127.0.0.1/steal">`) === ""
  );
  check(
    "no og:image -> empty",
    extractOgImage("<html><head><title>hi</title></head></html>") === ""
  );
  check(
    "other meta ignored",
    extractOgImage(`<meta property="og:title" content="https://a.example/x">`) === ""
  );
}

console.log("== test: isSafeHttpUrl ==");
{
  check("https ok", isSafeHttpUrl("https://news.example.com/story"));
  check("http ok", isSafeHttpUrl("http://example.com/"));
  check("javascript rejected", !isSafeHttpUrl("javascript:alert(1)"));
  check("data rejected", !isSafeHttpUrl("data:text/html,<b>x</b>"));
  check("empty/throw url rejected", !isSafeHttpUrl(""));
  // Triple-slash form parses to a public single-label host ("path") —
  // not an SSRF vector; the private-network guards below still hold.
  check("triple-slash private host still blocked", !isSafeHttpUrl("https:///169.254.169.254/latest"));
  check("triple-slash loopback still blocked", !isSafeHttpUrl("https:///127.0.0.1/x"));
  check("localhost rejected", !isSafeHttpUrl("http://localhost:8787/x"));
  check("127.0.0.1 rejected", !isSafeHttpUrl("http://127.0.0.1/x"));
  check("10.x rejected", !isSafeHttpUrl("http://10.0.0.5/x"));
  check("192.168.x rejected", !isSafeHttpUrl("http://192.168.1.1/x"));
  check("172.16-31.x rejected", !isSafeHttpUrl("http://172.20.0.1/x"));
  check("169.254.x rejected", !isSafeHttpUrl("http://169.254.169.254/latest/meta-data"));
  check("ipv6 loopback rejected", !isSafeHttpUrl("http://[::1]/x"));
  check(".internal rejected", !isSafeHttpUrl("https://db.internal/x"));
  check(".local rejected", !isSafeHttpUrl("https://printer.local/x"));
  check("public subdomain ok", isSafeHttpUrl("https://api.example.com/x"));
}

console.log("== test: isSafeHttpUrl encoded + special-range IPv4 ==");
{
  // Decimal, hex, octal and short-form encodings of loopback/private IPs
  check("decimal 2130706433 = 127.0.0.1 rejected", !isSafeHttpUrl("http://2130706433/x"));
  check("hex 0x7f000001 rejected", !isSafeHttpUrl("http://0x7f000001/x"));
  check("octal 0177.0.0.1 rejected", !isSafeHttpUrl("http://0177.0.0.1/x"));
  check("mixed 0x7f.1 rejected", !isSafeHttpUrl("http://0x7f.1/x"));
  check("short 127.1 rejected", !isSafeHttpUrl("http://127.1/x"));
  check("short 10.1 rejected", !isSafeHttpUrl("http://10.1/x"));
  check("invalid octal with 8/9 rejected (fail closed)", !isSafeHttpUrl("http://0178.0.0.1/x"));
  check("5-part dotted rejected (fail closed)", !isSafeHttpUrl("http://1.2.3.4.5/x"));
  check("CGNAT 100.64.0.1 rejected", !isSafeHttpUrl("http://100.64.0.1/x"));
  check("CGNAT edge 100.127.255.255 rejected", !isSafeHttpUrl("http://100.127.255.255/x"));
  check("just past CGNAT 100.128.0.1 allowed", isSafeHttpUrl("http://100.128.0.1/x"));
  check("benchmarking 198.18.0.1 rejected", !isSafeHttpUrl("http://198.18.0.1/x"));
  check("benchmarking 198.19.255.255 rejected", !isSafeHttpUrl("http://198.19.255.255/x"));
  check("TEST-NET-1 192.0.2.1 rejected", !isSafeHttpUrl("http://192.0.2.1/x"));
  check("TEST-NET-2 198.51.100.1 rejected", !isSafeHttpUrl("http://198.51.100.1/x"));
  check("TEST-NET-3 203.0.113.1 rejected", !isSafeHttpUrl("http://203.0.113.1/x"));
  check("6to4 relay 192.88.99.1 rejected", !isSafeHttpUrl("http://192.88.99.1/x"));
  check("reserved 240.0.0.1 rejected", !isSafeHttpUrl("http://240.0.0.1/x"));
  check("limited broadcast rejected", !isSafeHttpUrl("http://255.255.255.255/x"));
  check("0.0.0.0 rejected", !isSafeHttpUrl("http://0.0.0.0/x"));
  check("192.0.0.9 (anycast) rejected", !isSafeHttpUrl("http://192.0.0.9/x"));
}

console.log("== test: isSafeHttpUrl FQDN trailing-dot bypass ==");
{
  check("db.internal. rejected (trailing dot)", !isSafeHttpUrl("https://db.internal./x"));
  check("169.254.169.254. rejected (trailing dot)", !isSafeHttpUrl("http://169.254.169.254./x"));
  check("printer.localhost rejected", !isSafeHttpUrl("https://printer.localhost/x"));
  check("foo.test rejected (reserved TLD)", !isSafeHttpUrl("https://foo.test/x"));
  check("foo.invalid rejected (reserved TLD)", !isSafeHttpUrl("https://foo.invalid/x"));
  check("printer.home.arpa rejected", !isSafeHttpUrl("https://printer.home.arpa/x"));
  check("example.com. allowed (public, trailing dot)", isSafeHttpUrl("https://example.com./x"));
}

console.log("== test: isSafeHttpUrl IPv6 special ranges ==");
{
  check("ipv4-mapped loopback rejected", !isSafeHttpUrl("http://[::ffff:127.0.0.1]/x"));
  check("ipv4-mapped 169.254 rejected", !isSafeHttpUrl("http://[::ffff:169.254.169.254]/x"));
  check("ipv4-mapped 10.0.0.1 rejected", !isSafeHttpUrl("http://[::ffff:10.0.0.1]/x"));
  check("ULA fc00::1 rejected", !isSafeHttpUrl("http://[fc00::1]/x"));
  check("ULA fd12:3456::1 rejected", !isSafeHttpUrl("http://[fd12:3456::1]/x"));
  check("link-local fe80::1 rejected", !isSafeHttpUrl("http://[fe80::1]/x"));
  check("link-local febf::1 rejected", !isSafeHttpUrl("http://[febf::1]/x"));
  check("documentation 2001:db8::1 rejected", !isSafeHttpUrl("http://[2001:db8::1]/x"));
  check("multicast ff02::1 rejected", !isSafeHttpUrl("http://[ff02::1]/x"));
  check("unspecified :: rejected", !isSafeHttpUrl("http://[::]/x"));
  check("public Google DNS 2001:4860:4860::8888 allowed", isSafeHttpUrl("http://[2001:4860:4860::8888]/x"));
  check("ipv4-mapped public 8.8.8.8 allowed", isSafeHttpUrl("http://[::ffff:8.8.8.8]/x"));
  check("malformed ipv6 rejected", !isSafeHttpUrl("http://[2001:::1]/x"));
}

console.log("== test: fetchOgImage via stubbed fetch ==");
{
  const originalFetch = globalThis.fetch;

  async function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Partial<Response>>) {
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      return impl(String(url), init as RequestInit) as unknown as Response;
    }) as typeof fetch;
  }

  try {
    await (async () => {
      // html page -> og:image extracted
      await stubFetch(async () => ({
        ok: true,
        status: 200,
        url: "https://a.example/story",
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('<meta property="og:image" content="https://a.example/img.jpg">'));
            c.close();
          },
        }),
      }));
      // import lazily so the stub is in place
      const { fetchOgImage } = await import("../src/images.js");
      const got = await fetchOgImage("https://a.example/story", 2000);
      check("extracts og:image from html", got === "https://a.example/img.jpg");

      // non-HTML content type -> skip
      await stubFetch(async () => ({
        ok: true,
        status: 200,
        url: "https://a.example/photo.jpg",
        headers: new Headers({ "content-type": "image/jpeg" }),
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("junk"));
            c.close();
          },
        }),
      }));
      const got2 = await fetchOgImage("https://a.example/photo.jpg", 2000);
      check("non-html content-type skipped", got2 === "");

      // unsafe URL -> no fetch at all
      let called = false;
      await stubFetch(async () => {
        called = true;
        return { ok: true, status: 200, url: "http://127.0.0.1/x", headers: new Headers() };
      });
      const got3 = await fetchOgImage("http://127.0.0.1/x", 2000);
      check("unsafe url never fetched", got3 === "" && !called);

      // redirect chain leaving public web -> skipped
      await stubFetch(async () => ({
        ok: true,
        status: 200,
        url: "http://169.254.169.254/latest",
        headers: new Headers({ "content-type": "text/html" }),
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("<html></html>"));
            c.close();
          },
        }),
      }));
      const got4 = await fetchOgImage("https://a.example/redirect", 2000);
      check("final url validated after redirect", got4 === "");

      // timeout abort: fetch that never resolves but honors the signal
      await stubFetch((_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("Aborted"));
          });
        })
      );
      const t0 = Date.now();
      const got5 = await fetchOgImage("https://a.example/slow", 100);
      const elapsed = Date.now() - t0;
      check("aborts on timeout without hanging", got5 === "" && elapsed < 3000, `elapsed ${elapsed}ms`);
    })();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("\n=====================");
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
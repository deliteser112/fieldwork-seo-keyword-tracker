import { test } from "node:test";
import assert from "node:assert/strict";
import {
  publicAddress,
  websiteUrl,
  resolvePublic,
  CrawlError,
  SafeHttp,
} from "../src/infrastructure/safe-http";
import { Crawler, extractPage } from "../src/application/crawler";

test("SSRF rejects private, mapped, reserved and ambiguous URL destinations", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "0.0.0.0",
    "100.64.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "224.0.0.1",
    "192.0.2.1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("8.8.8.8"), true);
  for (const url of [
    "http://2130706433/",
    "http://[::ffff:127.0.0.1]/",
    "http://localhost/",
    "https://user:pass@example.com",
    "file:///tmp/a",
    "https://example.com:8443",
  ])
    assert.throws(() => websiteUrl(url));
  await assert.rejects(resolvePublic("localhost"));
  await assert.rejects(new SafeHttp().get("http://127.0.0.1/"), /UNSAFE/);
});
test("sitemap order, duplicate/cycle protection, first fifteen and shared extraction", async () => {
  const urls = Array.from(
    { length: 17 },
    (_, i) => `https://example.com/blog/post-${i}`,
  );
  const fixtures: Record<string, string> = {
    "https://example.com/robots.txt":
      "User-agent: *\nAllow: /\nSitemap: https://example.com/blog-sitemap.xml",
    "https://example.com/blog-sitemap.xml": `<urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`,
  };
  const crawler = new Crawler({
    async get(url, allowed) {
      await allowed?.(url);
      const text = fixtures[url];
      if (!text) throw new CrawlError("HTTP_404");
      return { url, text, contentType: "application/xml" };
    },
  });
  const selected = await crawler.discover("https://example.com");
  assert.equal(selected.length, 15);
  assert.deepEqual(
    selected.map((s) => s.url),
    urls.slice(0, 15),
  );
  const html =
    '<title>Search engine optimization guide</title><article><h1>Search optimization</h1><p>Search optimization helps search visibility. Search optimization improves website visibility. Website visibility requires useful content and clear search optimization.</p><img src="x"></article><nav>unrelated unrelated unrelated</nav>';
  const a = extractPage(urls[0]!, html);
  assert.deepEqual(a, extractPage(urls[0]!, html));
  assert.ok(a.keywords.length);
  assert.ok(a.keywords.every((k) => !k.term.includes("unrelated")));
  assert.ok(a.issues.some((i) => i.code === "IMAGE_ALT_MISSING"));
  assert.throws(() => extractPage(urls[0]!, "<p>empty</p>"), /INSUFFICIENT/);
});
test("robots blocks content and invalid entity sitemaps cannot select pages", async () => {
  const crawler = new Crawler({
    async get(url, allowed) {
      await allowed?.(url);
      return {
        url,
        contentType: "application/xml",
        text: url.endsWith("robots.txt")
          ? "User-agent: *\nDisallow: /"
          : '<!DOCTYPE x [<!ENTITY y "z">]><urlset/>',
      };
    },
  });
  await assert.rejects(
    crawler.discover("https://example.com"),
    /ROBOTS_DENIED/,
  );
  await assert.rejects(
    crawler.analyze("https://example.com/blog/x"),
    /ROBOTS_DENIED/,
  );
});
test("mixed DNS answers and rebinding cannot reach a prohibited socket", async () => {
  await assert.rejects(
    resolvePublic("mixed.example", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
    /UNSAFE/,
  );
  let resolutions = 0;
  await assert.rejects(
    new SafeHttp(async (host) =>
      resolvePublic(host, async () => {
        resolutions++;
        return [{ address: "169.254.169.254", family: 4 }];
      }),
    ).get("https://rebind.example"),
    /UNSAFE/,
  );
  assert.equal(resolutions, 1);
  const { createServer } = await import("node:net");
  let connected = 0;
  const server = createServer((socket) => {
    connected++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(new SafeHttp().get("http://127.0.0.1/"), /UNSAFE/);
    assert.equal(connected, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("nested map cycles, duplicate URLs, collection metadata and failed selections preserve order", async () => {
  const fixtures: Record<string, string> = {
    "https://example.com/robots.txt":
      "User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml",
    "https://example.com/sitemap.xml":
      "<sitemapindex><sitemap><loc>https://example.com/post-sitemap.xml</loc></sitemap></sitemapindex>",
    "https://example.com/post-sitemap.xml":
      "<urlset><url><loc>https://example.com/blog-index/</loc></url><url><loc>https://example.com/real-post/</loc></url><url><loc>https://example.com/real-post/</loc></url><url><loc>https://example.com/failed-post/</loc></url></urlset>",
    "https://example.com/blog-index/":
      '<script type="application/ld+json">{"@type":"CollectionPage"}</script>',
    "https://example.com/real-post/": "<article>Real blog content</article>",
  };
  const crawler = new Crawler({
    async get(url, allowed) {
      await allowed?.(url);
      if (url.endsWith("/failed-post/")) throw new CrawlError("HTTP_403");
      const text = fixtures[url];
      if (!text) throw new CrawlError("HTTP_404");
      return {
        url,
        text,
        contentType: url.endsWith(".xml") ? "application/xml" : "text/html",
      };
    },
  });
  assert.deepEqual(
    (await crawler.discover("https://example.com")).map((s) => s.url),
    ["https://example.com/real-post/", "https://example.com/failed-post/"],
  );
  await assert.rejects(
    crawler.analyze("https://example.com/failed-post/"),
    /HTTP_403/,
  );
  const cycle = new Crawler({
    async get(url, allowed) {
      await allowed?.(url);
      return {
        url,
        contentType: "application/xml",
        text: url.endsWith("robots.txt")
          ? "User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml"
          : "<sitemapindex><sitemap><loc>https://example.com/sitemap.xml</loc></sitemap></sitemapindex>",
      };
    },
  });
  await assert.rejects(
    cycle.discover("https://example.com"),
    /DISCOVERY_FAILED/,
  );
});
test("real HTTP connector fixtures enforce redirects, socket identity, decompression and attempt caps", async () => {
  const { createServer } = await import("node:http");
  const { connect } = await import("node:net");
  const { gzipSync } = await import("node:zlib");
  let retries = 0;
  let privateRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://127.0.0.1/private" });
      res.end();
    } else if (req.url === "/compressed") {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.alloc(3 * 1024 * 1024, 65)));
    } else if (req.url === "/retry") {
      retries++;
      res.writeHead(retries < 3 ? 503 : 200, { "content-type": "text/plain" });
      res.end("done");
    } else {
      privateRequests++;
      res.end("private");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  // Test-only connector routes the public fixture to a controlled local socket.
  // Production uses buildConnector with pinned lookup and real remoteAddress.
  const connector: typeof import("undici").buildConnector =
    () => (_options, cb) => {
      const socket = connect(address.port, "127.0.0.1");
      socket.once("error", (error) => cb(error, null));
      socket.once("connect", () => {
        Object.defineProperty(socket, "remoteAddress", { value: "8.8.8.8" });
        cb(null, socket);
      });
    };
  const http = new SafeHttp(
    async () => ({ address: "8.8.8.8", family: 4 }),
    connector,
  );
  try {
    await assert.rejects(http.get("http://fixture.example/redirect"), /UNSAFE/);
    assert.equal(privateRequests, 0);
    await assert.rejects(
      http.get("http://fixture.example/compressed"),
      /INVALID_COMPRESSED_BODY/,
    );
    assert.equal((await http.get("http://fixture.example/retry")).text, "done");
    assert.equal(retries, 3);
    const mismatch = new SafeHttp(
      async () => ({ address: "1.1.1.1", family: 4 }),
      connector,
    );
    await assert.rejects(
      mismatch.get("http://fixture.example/private"),
      /UNSAFE/,
    );
    assert.equal(privateRequests, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const auditRoot="https://audit.example";
function auditCrawler(maps:Record<string,string>, mapError?:CrawlError) {
 return new Crawler({async get(url,allowed){
  await allowed?.(url);
  if(url===auditRoot+"/robots.txt")return {url,text:`User-agent: *\nAllow: /\nSitemap: ${auditRoot}/sitemap.xml`,contentType:"text/plain"};
  if(url===auditRoot+"/sitemap.xml"&&mapError)throw mapError;
  if(maps[url])return {url,text:maps[url]!,contentType:"application/xml"};
  if(url.includes("/blog/"))return {url,text:"<article>"+"Useful search content improves website visibility. ".repeat(5)+"</article>",contentType:"text/html"};
  throw new CrawlError("HTTP_404");
 }});
}
test("F2 preserves sitemap-index order without dropping generically named siblings",async()=>{
 const crawler=auditCrawler({
  [auditRoot+"/sitemap.xml"]:`<sitemapindex><sitemap><loc>${auditRoot}/content.xml</loc></sitemap><sitemap><loc>${auditRoot}/post-map.xml</loc></sitemap></sitemapindex>`,
  [auditRoot+"/content.xml"]:`<urlset><url><loc>${auditRoot}/blog/earlier</loc></url></urlset>`,
  [auditRoot+"/post-map.xml"]:`<urlset><url><loc>${auditRoot}/blog/later</loc></url></urlset>`
 });
 assert.deepEqual((await crawler.discover(auditRoot)).map(p=>p.url),[auditRoot+"/blog/earlier",auditRoot+"/blog/later"]);
});
test("F3 decodes XML locations and skips individual invalid or unsafe entries",async()=>{
 const crawler=auditCrawler({[auditRoot+"/sitemap.xml"]:`<urlset><url><loc>${auditRoot}/blog/one?a=1&amp;b=2</loc></url><url><loc>invalid-url</loc></url><url><loc>http://127.0.0.1/private</loc></url><url><loc>${auditRoot}/blog/two</loc></url></urlset>`});
 assert.deepEqual((await crawler.discover(auditRoot)).map(p=>p.url),[auditRoot+"/blog/one?a=1&b=2",auditRoot+"/blog/two"]);
});
test("F4 retains retryability when an advertised sitemap times out and fallbacks return 404",async()=>{
 await assert.rejects(auditCrawler({},new CrawlError("DNS_TIMEOUT",true)).discover(auditRoot),e=>e instanceof CrawlError&&e.code==="DISCOVERY_FAILED_DNS_TIMEOUT"&&e.retryable);
});
test("F8 block text boundaries cannot create fused keywords; inline words stay intact",()=>{
 const html="<title>Search optimization</title><article>"+"<p>search</p><p>optimization </p>".repeat(12)+"<p>micro<strong>service</strong> micro<strong>service</strong></p></article>";
 const page=extractPage(auditRoot+"/blog/text",html);const terms=page.keywords.map(k=>k.term);
 assert.ok(!terms.some(t=>t.includes("searchoptimization")),JSON.stringify(terms));
 assert.ok(terms.includes("search"));assert.ok(terms.includes("optimization"));
 const inline=extractPage(auditRoot+"/blog/inline","<article>"+"<p>micro<strong>service</strong> architecture </p>".repeat(8)+"</article>");
 assert.ok(inline.keywords.some(k=>k.term==="microservice"));
});

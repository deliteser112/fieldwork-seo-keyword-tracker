import { setTimeout as delay } from "node:timers/promises";
import { load } from "cheerio";
import robotsParser from "robots-parser";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { CrawlError } from "./crawl-contract";
import { websiteUrl } from "./website-url";
import type { HttpDocument, HttpReader } from "./crawl-contract";

export interface KeywordAnalysis {
  term: string;
  score: number;
  evidence: string;
}
export interface IssueAnalysis {
  code: string;
  advisory: boolean;
  evidence: string;
}
export interface PageAnalysis {
  url: string;
  title: string;
  keywords: KeywordAnalysis[];
  issues: IssueAnalysis[];
  ruleVersion: string;
}
export interface Selection {
  ordinal: number;
  url: string;
  sourceSitemap: string;
}
const STOP = new Set(
  "a an the and or but for of to in on at by with from is are was were be been this that these those it its you your we our they their as not can will how what why when where which who more about into than also have has had do does did all any get using use".split(
    " ",
  ),
);
export function extractPage(url: string, html: string): PageAnalysis {
  const $ = load(html);
  const title = $("title").first().text().trim().slice(0, 500);
  const description =
    $('meta[name="description"]').attr("content")?.trim() ?? "";
  const h1 = $("h1")
    .map((_, el) => $(el).text().trim())
    .get();
  const imageMissing = $("img:not([alt])").length;
  $(
    'script,style,nav,footer,header,aside,noscript,form,svg,[role="navigation"]',
  ).remove();
  // Preserve block boundaries without splitting words across inline markup.
  $("br").replaceWith("\n");
  $("p,h1,h2,h3,h4,h5,h6,li,div,section,article,main,blockquote,pre,td,tr")
    .each((_, element) => { $(element).append("\n"); });
  const content = (
    $("article").first().text() ||
    $("main").first().text() ||
    $("body").text()
  )
    .replace(/\s+/g, " ")
    .trim();
  if (content.length < 80) throw new CrawlError("INSUFFICIENT_CONTENT");
  const counts = new Map<string, number>();
  const words = content.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (STOP.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
    const next = words[i + 1];
    if (next && !STOP.has(next)) {
      const pair = `${word} ${next}`;
      counts.set(pair, (counts.get(pair) ?? 0) + 1);
    }
  }
  const heading = `${title} ${h1.join(" ")}`.toLowerCase();
  const keywords = [...counts]
    .filter(([, count]) => count >= 2)
    .map(([term, count]) => ({
      term,
      score:
        count * (term.includes(" ") ? 2 : 1) + (heading.includes(term) ? 8 : 0),
      evidence: `${count} occurrence(s) in main text${heading.includes(term) ? "; also in title/heading" : ""}`,
    }))
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term, "en"))
    .slice(0, 5);
  const issues: IssueAnalysis[] = [];
  if (!title)
    issues.push({
      code: "MISSING_TITLE",
      advisory: false,
      evidence: "No nonempty title element",
    });
  else if (title.length < 20 || title.length > 65)
    issues.push({
      code: "TITLE_LENGTH",
      advisory: true,
      evidence: `Title contains ${title.length} characters; review search presentation`,
    });
  if (!description)
    issues.push({
      code: "MISSING_DESCRIPTION",
      advisory: false,
      evidence: "No nonempty meta description",
    });
  if (h1.length !== 1)
    issues.push({
      code: "H1_COUNT",
      advisory: true,
      evidence: `Found ${h1.length} h1 elements`,
    });
  if (imageMissing)
    issues.push({
      code: "IMAGE_ALT_MISSING",
      advisory: false,
      evidence: `${imageMissing} image(s) lack an alt attribute`,
    });
  return { url, title, keywords, issues, ruleVersion: "english-static-v2" };
}
export class Crawler {
  private nextRequest = new Map<string, number>();
  private fetchFailures = new Map<string, unknown>();
  private documents = new Map<string, HttpDocument>();
  private robots = new Map<string, Promise<ReturnType<typeof robotsParser>>>();
  constructor(
    private readonly http: HttpReader,
    private readonly signal?: AbortSignal,
  ) {}
  private rules(url: string, signal = this.signal) {
    const origin = new URL(url).origin;
    let promise = this.robots.get(origin);
    if (!promise) {
      if (this.robots.size >= 40) throw new CrawlError("ORIGIN_LIMIT");
      promise = this.http
        .get(`${origin}/robots.txt`,undefined,signal)
        .then((doc) => robotsParser(`${origin}/robots.txt`, doc.text))
        .catch((e) => {
          if (e instanceof CrawlError && e.code === "HTTP_404")
            return robotsParser(`${origin}/robots.txt`, "");
          throw e;
        });
      this.robots.set(origin, promise);
    }
    return promise;
  }
  private allowed = async (url:string, operationSignal?:AbortSignal) => {
    const signal=this.signal&&operationSignal?AbortSignal.any([this.signal,operationSignal]):this.signal??operationSignal;
    try {
      if(signal?.aborted)throw new CrawlError("INTERRUPTED",true);
      const rules=await this.rules(url,signal);
      if(rules.isAllowed(url,"FieldworkBot")===false)throw new CrawlError("ROBOTS_DENIED");
      const seconds=rules.getCrawlDelay("FieldworkBot")??0;
      if(!Number.isFinite(seconds)||seconds>30)throw new CrawlError("CRAWL_DELAY_EXCEEDS_BUDGET");
      const origin=new URL(url).origin;
      const wait=Math.max(0,(this.nextRequest.get(origin)??0)-Date.now());
      if(wait)await delay(wait,undefined,{...(signal?{signal}:{})});
      if(signal?.aborted)throw new CrawlError("INTERRUPTED",true);
      this.nextRequest.set(origin,Date.now()+Math.max(0,seconds)*1000);
    }catch(error){if(signal?.aborted)throw new CrawlError("INTERRUPTED",true);throw error;}
  };
  async discover(input: string): Promise<Selection[]> {
    const root = new URL(websiteUrl(input));
    const rules = await this.rules(root.href);
    const queue = [
      ...rules.getSitemaps(),
      ...["/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml"].map(
        (p) => new URL(p, root).href,
      ),
    ];
    const seen = new Set<string>();
    const posts = new Map<string, Selection>();
    const failures: CrawlError[] = [];
    const parser = new XMLParser({
      ignoreAttributes: true,
      processEntities: true,
      isArray: (name) => name === "sitemap" || name === "url",
    });
    while (queue.length && seen.size < 40 && posts.size < 15) {
      if (this.signal?.aborted) throw new CrawlError("INTERRUPTED", true);
      const sitemap = queue.shift()!;
      if (seen.has(sitemap)) continue;
      seen.add(sitemap);
      try {
        const doc = await this.http.get(websiteUrl(sitemap), this.allowed,this.signal);
        if (
          /<!DOCTYPE|<!ENTITY/i.test(doc.text) ||
          XMLValidator.validate(doc.text) !== true
        )
          throw new CrawlError("INVALID_SITEMAP");
        const xml = parser.parse(doc.text) as {
          sitemapindex?: { sitemap?: { loc?: string }[] };
          urlset?: { url?: { loc?: string }[] };
        };
        const children = xml.sitemapindex?.sitemap ?? [];
        const maps = children.map(c => c.loc).filter((url): url is string => typeof url === "string");
        queue.unshift(...maps.slice(0,40));
        for (const entry of (xml.urlset?.url ?? []).slice(0, 20000)) {
          if (!entry.loc) continue;
          let url: URL;
          try { url = new URL(websiteUrl(entry.loc)); }
          catch (error) { if (error instanceof CrawlError) continue; throw error; }
          const path = url.pathname;
          const blogMap = /blog|post/i.test(new URL(sitemap).pathname);
          const eligible =
            /\/(blog|articles?|posts?)\/.+/.test(path) ||
            (blogMap && path.split("/").filter(Boolean).length >= 1);
          if (
            url.origin !== root.origin &&
            url.hostname.replace(/^www\./, "") !==
              root.hostname.replace(/^www\./, "")
          )
            continue;
          if (
            !eligible ||
            /\/(tag|category|author|page)\//.test(path) ||
            /\.(jpg|png|pdf|xml)$/i.test(path)
          )
            continue;
          if (posts.has(url.href)) continue;
          // A post sitemap may contain its blog index. Identify explicit collection
          // metadata generically; fetching failures still occupy their selected slot.
          try {
            const page = await this.http.get(url.href, this.allowed,this.signal);
            const $ = load(page.text);
            const structured = $('script[type="application/ld+json"]')
              .map((_, el) => $(el).text())
              .get()
              .join(" ");
            if (
              /"CollectionPage"/.test(structured) &&
              !/"(?:BlogPosting|Article|NewsArticle)"/.test(structured)
            )
              continue;
            if (this.documents.size < 15) this.documents.set(url.href, page);
          } catch (e) {
            if (e instanceof CrawlError && e.code === "INTERRUPTED") throw e;
            this.fetchFailures.set(url.href, e);
          }
          if (!posts.has(url.href))
            posts.set(url.href, {
              ordinal: posts.size,
              url: url.href,
              sourceSitemap: sitemap,
            });
          if (posts.size === 15) break;
        }
      } catch (e) {
        if (e instanceof CrawlError && e.code === "INTERRUPTED") throw e;
        failures.push(e instanceof CrawlError ? e : new CrawlError("INVALID_SITEMAP"));
      }
    }
    if (!posts.size) {
      const failure = failures.find(error => error.retryable)
        ?? failures.find(error => error.code !== "HTTP_404")
        ?? failures.at(-1);
      throw new CrawlError(`DISCOVERY_FAILED_${failure?.code ?? "NO_BLOG_POSTS"}`, failure?.retryable ?? false);
    }
    return [...posts.values()];
  }
  async analyze(url: string): Promise<PageAnalysis> {
    if(this.signal?.aborted)throw new CrawlError("INTERRUPTED",true);
    if (this.fetchFailures.has(url)) throw this.fetchFailures.get(url);
    const doc =
      this.documents.get(url) ??
      (await this.http.get(websiteUrl(url), this.allowed,this.signal));
    if (!/text\/html|application\/xhtml\+xml/i.test(doc.contentType))
      throw new CrawlError("NOT_HTML");
    return extractPage(url, doc.text);
  }
}

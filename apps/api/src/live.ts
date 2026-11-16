import { Crawler } from "./application/crawler";
import { SafeHttp, CrawlError } from "./infrastructure/safe-http";
async function main() {
  let failed = false;
  for (const site of ["https://www.semrush.com", "https://yoast.com"]) {
    const crawler = new Crawler(new SafeHttp());
    try {
      const selected = await crawler.discover(site);
      console.log(JSON.stringify({ site, selected }));
      if (selected.length !== 15) throw new CrawlError("REQUIRES_15_POSTS");
      for (const post of selected) {
        const page = await crawler.analyze(post.url);
        console.log(
          JSON.stringify({
            url: post.url,
            keywords: page.keywords.length,
            issues: page.issues.length,
          }),
        );
      }
    } catch (e) {
      failed = true;
      console.error(
        JSON.stringify({
          site,
          error: e instanceof CrawlError ? e.code : "LIVE_ACCEPTANCE_FAILED",
        }),
      );
    }
  }
  if (failed) process.exitCode = 1;
}
void main();

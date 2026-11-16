import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { CrawlError } from "./crawl-contract";
export function publicAddress(address: string): boolean {
  try {
    const ip = ipaddr.process(address);
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}
export function websiteUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CrawlError("INVALID_URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    url.href.length > 2048
  )
    throw new CrawlError("INVALID_URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    (isIP(host) && !publicAddress(host)) ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  )
    throw new CrawlError("UNSAFE_DESTINATION");
  url.hash = "";
  return url.href;
}

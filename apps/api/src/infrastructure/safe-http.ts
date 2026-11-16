import { publicAddress, websiteUrl } from "../application/website-url";
export { publicAddress, websiteUrl } from "../application/website-url";
import { CrawlError } from "../application/crawl-contract";
import type { HttpDocument, HttpReader, HttpPermission } from "../application/crawl-contract";
export { CrawlError } from "../application/crawl-contract";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { Client, buildConnector } from "undici";
import ipaddr from "ipaddr.js";

function checkCancellation(signal?: AbortSignal) {
  if(signal?.aborted) throw new CrawlError("INTERRUPTED",true);
}
async function abortable<T>(work:Promise<T>,signal?:AbortSignal):Promise<T> {
  if(signal?.aborted){void work.catch(()=>{});throw new CrawlError("INTERRUPTED",true);}
  if(!signal)return work;
  let onAbort:()=>void=()=>{};
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{
    onAbort=()=>reject(new CrawlError("INTERRUPTED",true));
    signal.addEventListener("abort",onAbort,{once:true});
    if(signal.aborted)onAbort();
  })]);}finally{signal.removeEventListener("abort",onAbort);}
}
export async function resolvePublic(
 host:string,
 resolver=(name:string)=>lookup(name,{all:true}),
 signal?:AbortSignal,
):Promise<{address:string;family:number}> {
 checkCancellation(signal);
 let timer:ReturnType<typeof setTimeout>|undefined;
 let addresses:{address:string;family:number}[];
 try {
  addresses=isIP(host)?[{address:host,family:isIP(host)}]:await abortable(Promise.race([
   resolver(host),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new CrawlError("DNS_TIMEOUT",true)),5000);})
  ]),signal);
 }catch(error){if(error instanceof CrawlError)throw error;throw new CrawlError("DNS_FAILURE",true);}
 finally{clearTimeout(timer);}
 if(!addresses.length||addresses.some(address=>!publicAddress(address.address)))throw new CrawlError("UNSAFE_DESTINATION");
 return addresses[0]!;
}
type PublicResolver=(host:string,signal?:AbortSignal)=>Promise<{address:string;family:number}>;
const LIMIT = 2 * 1024 * 1024;
export class SafeHttp implements HttpReader {
  constructor(
    private readonly resolve: PublicResolver = (host,signal)=>resolvePublic(host,undefined,signal),
    private readonly connector = buildConnector,
    private readonly options: {deadlineMs?:number} = {},
  ) {}
  async get(input:string,allowed?:HttpPermission,caller?:AbortSignal):Promise<HttpDocument> {
    const deadline=AbortSignal.timeout(this.options.deadlineMs ?? 45000);
    const signal=caller?AbortSignal.any([caller,deadline]):deadline;
    let last:unknown;
    try {
      for(let attempt=0;attempt<3;attempt++) {
        checkCancellation(signal);
        try{return await this.fetch(input,allowed,signal);}
        catch(error){last=error;if(signal.aborted||!(error instanceof CrawlError)||!error.retryable||attempt===2)throw error;}
        await delay(250*2**attempt+Math.floor(Math.random()*100),undefined,{signal});
      }
      throw last;
    }catch(error){
      if(signal.aborted)throw new CrawlError(caller?.aborted?"INTERRUPTED":"FETCH_DEADLINE",true);
      throw error;
    }
  }
  private async fetch(
    input: string,
    allowed: HttpPermission | undefined,
    signal: AbortSignal,
  ): Promise<HttpDocument> {
    let url = new URL(websiteUrl(input));
    for (let redirect = 0; redirect <= 5; redirect++) {
      await abortable(Promise.resolve(allowed?.(url.href,signal)),signal);
      checkCancellation(signal);
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const pinned = await abortable(this.resolve(host,signal),signal);
      checkCancellation(signal);
      // No environment proxy. Pin the validated DNS answer in the actual connector;
      // retain the original hostname for Host, SNI and certificate verification.
      const connect = this.connector({
        timeout: 5000,
        lookup: (_host, options, cb) => {
          if (options.all) cb(null, [pinned]);
          else cb(null, pinned.address, pinned.family);
        },
      });
      const client = new Client(url.origin, {
        connect: (options, cb) =>
          connect(options, (error, socket) => {
            if (error || !socket) {
              cb(error, null);
              return;
            }
            if (
              !socket.remoteAddress ||
              !publicAddress(socket.remoteAddress) ||
              ipaddr.process(socket.remoteAddress).toString() !==
                ipaddr.process(pinned.address).toString()
            ) {
              socket.destroy();
              cb(new CrawlError("UNSAFE_DESTINATION"), null);
              return;
            }
            cb(null, socket);
          }),
        headersTimeout: 10000,
        bodyTimeout: 10000,
        maxResponseSize: LIMIT,
      });
      try {
        const res = await client.request({
          path: url.pathname + url.search,
          method: "GET",
          headers: {
            "user-agent": "FieldworkBot/1.0",
            accept: "text/html,application/xml,text/xml,text/plain",
            "accept-encoding": "gzip, deflate, br",
          },
          signal: AbortSignal.any([signal,AbortSignal.timeout(15000)]),
        });
        // Explicit destruction on redirects/error statuses emits an abort error.
        // Own that event; async iteration still propagates actual read failures.
        res.body.on("error", () => {});
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const location = res.headers.location;
          res.body.destroy();
          if (typeof location !== "string" || redirect === 5)
            throw new CrawlError("REDIRECT_LIMIT");
          url = new URL(websiteUrl(new URL(location, url).href));
          continue;
        }
        if (res.statusCode >= 400) {
          res.body.destroy();
          throw new CrawlError(
            `HTTP_${res.statusCode}`,
            [408, 429, 500, 502, 503, 504].includes(res.statusCode),
          );
        }
        const parts: Buffer[] = [];
        let size = 0;
        for await (const part of res.body) {
          const b = Buffer.from(part);
          size += b.length;
          if (size > LIMIT) throw new CrawlError("BODY_LIMIT");
          parts.push(b);
        }
        let data = Buffer.concat(parts);
        const encoding = res.headers["content-encoding"];
        const options = { maxOutputLength: LIMIT };
        try {
          if (encoding === "gzip" || url.pathname.endsWith(".gz"))
            data = gunzipSync(data, options);
          else if (encoding === "deflate") data = inflateSync(data, options);
          else if (encoding === "br")
            data = brotliDecompressSync(data, options);
          else if (encoding && encoding !== "identity")
            throw new CrawlError("UNSUPPORTED_ENCODING");
        } catch {
          throw new CrawlError("INVALID_COMPRESSED_BODY");
        }
        return {
          url: url.href,
          text: data.toString("utf8"),
          contentType: String(res.headers["content-type"] ?? ""),
        };
      } catch (e) {
        if (e instanceof CrawlError) throw e;
        const code =
          typeof e === "object" && e !== null && "code" in e
            ? String(e.code)
            : "";
        if (code === "UND_ERR_RES_EXCEEDED_MAX_SIZE")
          throw new CrawlError("BODY_LIMIT");
        if (/CERT|TLS/.test(code)) throw new CrawlError("TLS_FAILURE");
        throw new CrawlError("NETWORK_FAILURE", true);
      } finally {
        await client.destroy();
      }
    }
    throw new CrawlError("REDIRECT_LIMIT");
  }
}

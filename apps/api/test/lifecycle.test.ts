import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {connect} from "node:net";
import type {buildConnector} from "undici";
import {SafeHttp} from "../src/infrastructure/safe-http";
import {CrawlError} from "../src/application/crawl-contract";
import type {HttpDocument} from "../src/application/crawl-contract";
import {Crawler} from "../src/application/crawler";
import {CrawlWorker} from "../src/application/worker";
import type {TrackerStore} from "../src/application/tracker";
async function transportFixture() {
 const server=createServer((req,res)=>{setTimeout(()=>{if(req.url!=="/slow"&&req.url!=="/r2"){res.writeHead(302,{location:req.url==="/r0"?"/r1":"/r2"});res.end();}else{res.writeHead(200,{"content-type":"text/html"});res.end("ok");}},req.url==="/slow"?250:70);});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address&&typeof address!=="string");
 const connector:typeof buildConnector=()=> (_options,cb)=>{const socket=connect(address.port,"127.0.0.1");const failed=(error:Error)=>cb(error,null);socket.once("error",failed);socket.once("connect",()=>{socket.removeListener("error",failed);Object.defineProperty(socket,"remoteAddress",{value:"8.8.8.8"});cb(null,socket);});};
 return {connector,async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
test("F5 caller cancellation interrupts an active HTTP request",async()=>{
 const fixture=await transportFixture();const http=new SafeHttp(async()=>({address:"8.8.8.8",family:4}),fixture.connector);const ac=new AbortController();
 try{const request=Reflect.apply(http.get,http,["http://fixture.example/slow",undefined,ac.signal]) as Promise<HttpDocument>;setTimeout(()=>ac.abort(),30);await assert.rejects(request,e=>e instanceof CrawlError&&e.code==="INTERRUPTED");}finally{await fixture.close();}
});
test("F5 one overall HTTP deadline spans redirects",async()=>{
 const fixture=await transportFixture();
 const Factory=SafeHttp as unknown as new(resolve:ConstructorParameters<typeof SafeHttp>[0],connector:ConstructorParameters<typeof SafeHttp>[1],options:{deadlineMs:number})=>SafeHttp;
 const http=new Factory(async()=>({address:"8.8.8.8",family:4}),fixture.connector,{deadlineMs:100});
 try{await assert.rejects(http.get("http://fixture.example/r0"),e=>e instanceof CrawlError&&e.code==="FETCH_DEADLINE");}finally{await fixture.close();}
});
test("F5 cancellation interrupts robots crawl-delay permission waits",async()=>{
 const ac=new AbortController();let waiting=false;
 const crawler=new Crawler({async get(url,allowed){if(url.endsWith("robots.txt"))return {url,text:"User-agent: *\nAllow: /\nCrawl-delay: 0.2\nSitemap: https://audit.example/blog.xml",contentType:"text/plain"};await allowed?.(url);if(url.endsWith("blog.xml"))return {url,text:"<urlset><url><loc>https://audit.example/blog/a</loc></url></urlset>",contentType:"application/xml"};waiting=true;return {url,text:"<article>"+"real content real content ".repeat(8)+"</article>",contentType:"text/html"};}},ac.signal);
 const pending=crawler.discover("https://audit.example");setTimeout(()=>ac.abort(),30);
 await assert.rejects(pending,e=>e instanceof CrawlError&&e.code==="INTERRUPTED");assert.equal(waiting,false,"no article request after cancellation");
});
test("F5 lease loss aborts in-flight analysis without any stale commit",async(t)=>{
 t.mock.timers.enable({apis:["setInterval"]});const external=new AbortController();let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);let operation:AbortSignal|undefined;let writes=0;
 const store={pending:async()=>[{ordinal:0,url:"https://audit.example/blog/a",state:"pending"}],renew:async()=>{throw new Error("lease unavailable");},save:async()=>{writes++;},failedPage:async()=>{writes++;},finish:async()=>{writes++;}} as unknown as TrackerStore;
 const worker=new CrawlWorker(store,signal=>{operation=signal;return {analyze:async()=>{entered();await new Promise<never>((_,reject)=>signal?.addEventListener("abort",()=>reject(new CrawlError("INTERRUPTED",true)),{once:true}));}} as unknown as Crawler;});
 const pending=worker.process({id:"job",clientId:"client",websiteUrl:"https://audit.example",token:"token"},external.signal);
 try{await started;t.mock.timers.tick(15000);await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(operation?.aborted,true);}finally{external.abort();await pending;t.mock.timers.reset();}
 assert.equal(writes,0);
});

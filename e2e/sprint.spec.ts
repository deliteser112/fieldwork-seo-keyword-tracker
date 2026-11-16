import {test,expect} from "@playwright/test";
const id="11111111-1111-4111-8111-111111111111";
const cid="22222222-2222-4222-8222-222222222222";
async function fixture(page:import('@playwright/test').Page,badDate?:"page"|"history") {
 const state={posts:0};
 const dto={id,clientId:cid,url:"https://audit.example/blog/a",title:"Audit Page",ruleVersion:"fixture",crawledAt:badDate==="page"?"invalid":"2026-11-15T12:00:00.000Z",keywords:[],issues:[]};
 await page.route("**/api/**",async route=>{
  const request=route.request();const url=new URL(request.url());const path=url.pathname;let status=200;let json:unknown;
  if(path==="/api/auth/session")json={user:{id:"audit-user",email:"audit@example.test"},csrfToken:"a".repeat(64)};
  else if(path==="/api/auth/logout"){status=503;json={error:"SERVICE_UNAVAILABLE"};}
  else if(path==="/api/clients"&&request.method()==="POST"){state.posts++;status=state.posts===1?503:202;json=state.posts===1?{error:"SERVICE_UNAVAILABLE"}:{client:{id:cid},jobId:id};}
  else if(path==="/api/clients")json={clients:[{id:cid,name:"Audit client",websiteUrl:"https://audit.example"}]};
  else if(path.endsWith("/history"))json={timezone:"America/Toronto",simulated:true,keywords:[{id:"k",term:"audit",snapshots:badDate==="history"?[{capturedAt:"invalid",position:5}]:[]}]};
  else if(path==="/api/pages")json={pages:url.searchParams.get("search")?[]:[dto],total:url.searchParams.get("search")?0:1,page:1,pageSize:20};
  else if(path===`/api/pages/${id}`)json={page:dto};
  else if(path.endsWith("/crawl"))json={job:null};
  else{status=404;json={error:"NOT_FOUND"};}
  await route.fulfill({status,json});
 });
 return state;
}
test("F9 logout failure is visible on every authenticated screen",async({page})=>{
 await fixture(page);
 for(const route of ["pages",`pages/${id}`,"add","clients"]){await page.goto('/#'+route);await page.getByRole('button',{name:'Sign out',exact:true}).waitFor();await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Could not sign out');await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeEnabled();}
});
test("F10 Add Client retry resubmits retained form values",async({page})=>{
 const state=await fixture(page);await page.goto('/#add');await page.getByLabel('Client name').fill('Audit client');await page.getByLabel('Website URL').fill('https://audit.example');await page.getByRole('button',{name:'Add client',exact:true}).click();await page.getByRole('alert').waitFor();await page.getByRole('button',{name:'Retry request',exact:true}).click();await expect.poll(()=>state.posts).toBe(2);await expect(page.getByRole('heading',{name:'Clients',exact:true})).toBeVisible();
});
test("F11 the search field displays its persisted applied filter after navigation",async({page})=>{
 await fixture(page);await page.goto('/#pages');await page.getByRole('heading',{name:'Audit Page',exact:true}).waitFor();await page.getByLabel('Search URL or keyword').fill('unmatched');await page.getByRole('button',{name:'Search',exact:true}).click();await page.getByRole('heading',{name:'No pages found',exact:true}).waitFor();await page.getByRole('link',{name:'Clients',exact:true}).click();await page.getByRole('link',{name:'Pages',exact:true}).click();await page.getByRole('heading',{name:'No pages found',exact:true}).waitFor();await expect(page.getByLabel('Search URL or keyword')).toHaveValue('unmatched');
});
test("F12 malformed dates show recoverable errors rather than unmounting",async({page})=>{
 for(const field of ["page","history"] as const){await page.unrouteAll();await fixture(page,field);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/#pages/'+id);await expect(page.getByRole('alert')).toContainText('Could not load a valid response');await expect(page.locator('main')).toBeVisible();expect(errors).toEqual([]);}
});

test("F13 browsers receive production-built frontend assets",async({request})=>{
 const response=await request.get('/');expect(response.ok()).toBeTruthy();const html=await response.text();expect(html).not.toContain('/@vite/client');const src=html.match(/src="(\/assets\/[^" ]+\.js)"/);expect(src).not.toBeNull();const asset=await request.get(src![1]!);expect(asset.ok()).toBeTruthy();expect(await asset.text()).not.toContain('Download the React DevTools');
});

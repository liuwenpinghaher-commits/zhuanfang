import { chromium } from "playwright";
import fs from "node:fs";
const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:3210";
const out = { base: BASE, startedAt: new Date().toISOString(), steps: [], ok: true, errors: [] };
function step(name, data={}){ const row={name,at:new Date().toISOString(),...data}; out.steps.push(row); console.log(JSON.stringify(row)); }
function fail(name,err){ out.ok=false; const msg=err instanceof Error?err.message:String(err); out.errors.push({name,msg}); step(name,{status:"fail",error:msg}); }
async function main(){
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage(); page.setDefaultTimeout(40000);
  try{
    const health=await fetch(BASE+"/api/health").then(r=>r.json());
    if(!health.ok) throw new Error("health");
    step("health",{status:"pass"});
    await page.goto(BASE+"/?view=corpus",{waitUntil:"networkidle"});
    await page.evaluate(async()=>{ const r=await fetch("/api/runtime-bootstrap",{credentials:"include"}); if(!r.ok) throw new Error("boot"); });
    await page.getByRole("heading",{name:"从外部专访中学习提问逻辑"}).waitFor();
    const u1=page.url();
    step("corpus-url",{status:u1.includes("view=corpus")&&!u1.includes("filter=")?"pass":"fail",url:u1});
    // sticky clear from my-assets
    await page.goto(BASE+"/?view=my-assets&filter=all&important=0&sort=updated-desc",{waitUntil:"networkidle"});
    await page.getByRole("button",{name:"语料学习",exact:true}).click();
    await page.getByRole("heading",{name:"从外部专访中学习提问逻辑"}).waitFor();
    await page.waitForTimeout(400);
    const u2=page.url();
    step("corpus-clears-sticky",{status:u2.includes("view=corpus")&&!u2.includes("filter=")?"pass":"fail",url:u2});
    await page.getByRole("button",{name:"个人档案",exact:true}).click();
    await page.getByRole("heading",{name:/·/}).waitFor();
    await page.waitForTimeout(400);
    const u3=page.url();
    step("profile-url",{status:u3.includes("view=profile")?"pass":"fail",url:u3});
    // dirty profile
    const name=page.locator("input[placeholder='你希望被怎么称呼']");
    const before=await name.inputValue();
    await name.fill(before+"·");
    await page.waitForTimeout(200);
    const dirty=await page.getByText("有未保存更改").isVisible().catch(()=>false);
    step("profile-dirty",{status:dirty?"pass":"warn",dirty});
    // memory CTA
    const mem=page.getByRole("button",{name:"去记忆"}).first();
    const memVis=await mem.isVisible().catch(()=>false);
    if(memVis){ await mem.click(); await page.waitForTimeout(500); step("profile-memory-cta",{status:page.url().includes("view=memory")?"pass":"warn",url:page.url()}); }
    else step("profile-memory-cta",{status:"warn",reason:"no cta"});
    // restore name via reload profile - skip actual save to avoid dirtying prod data
  }catch(e){ fail("workflow",e); try{ await page.screenshot({path:"/tmp/corpus-profile-smoke.png",fullPage:true}); out.screenshot="/tmp/corpus-profile-smoke.png"; }catch{} }
  finally{
    out.finishedAt=new Date().toISOString();
    const pass=out.steps.filter(s=>s.status==="pass").length;
    const failN=out.steps.filter(s=>s.status==="fail").length;
    const warn=out.steps.filter(s=>s.status==="warn").length;
    out.summary={pass,fail:failN,warn,ok:out.ok&&failN===0};
    fs.writeFileSync("/tmp/corpus-profile-smoke.json",JSON.stringify(out,null,2));
    await browser.close();
    console.log("SUMMARY",JSON.stringify(out.summary));
    console.log("RESULT",out.summary.ok?"PASS":"FAIL");
    if(!out.summary.ok) process.exitCode=1;
  }
}
main();

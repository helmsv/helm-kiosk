// Actual-page recovery QA; every app/provider request is mocked in a fresh context.
const assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
const files=['/tech.html','/nav.js','/nav.css','/rental-mobile.css','/rental-data.js','/rental-dialog.js'];
const destination='https://www.smartwaiver.com/w/a2njtmnzxs7icea9mdxff6/kiosk/';
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH});
 const context=await browser.newContext();const errors=[],unexpected=[],calls=[];let blankStatus=200,prefillStatus=502,prefillError='Unable to prepare Smartwaiver right now. [prefill-create; HTTP 400]';
 await context.addInitScript(()=>{window.setInterval=()=>1;window.EventSource=class{addEventListener(){}close(){}};});
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.hostname==='cdn.tailwindcss.com')return route.continue();
  const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(req.url()===destination&&req.method()==='GET')return route.fulfill({contentType:'text/html',body:'<h1>Mock blank unsigned form</h1><input id="name" value=""><input id="din" value="">'});
  if(url.hostname!=='liability-recovery.test'){unexpected.push(url.hostname);return route.abort();}
  if(url.pathname==='/staff-session.js')return route.fulfill({contentType:'application/javascript',body:'window.StaffSession={ready:async()=>{},isReady:()=>true,fetch:(...args)=>fetch(...args)};'});
  if(files.includes(url.pathname))return route.fulfill({path:path.join(root,url.pathname)});
  if(url.pathname==='/api/hidden')return json({keys:[]});
  if(['/api/open-intakes','/api/open-liabilities'].includes(url.pathname))return json({rows:[]});
  if(url.pathname==='/favicon.ico')return route.fulfill({status:204});
  if(url.pathname==='/api/liability-template'){calls.push('blank');assert.equal(req.method(),'POST');assert.equal(req.postData(),null);return json(blankStatus===200?{blank:true,url:destination}:{error:'Staff access denied'},blankStatus);}
  if(url.pathname==='/api/waiver-prefill'){calls.push('prefill');assert.equal(req.postDataJSON().waiverId,'synthetic_only');return json({error:prefillError},prefillStatus);}
  unexpected.push(url.pathname);return route.abort();
 });
 try{
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:375,height:844});await page.goto('https://liability-recovery.test/tech.html');
  assert.match(await page.locator('body').innerText(),/no customer details, intake link, or DIN settings are transferred/i);
  const direct=page.waitForEvent('popup');await page.locator('#openBlankLiability').click();let popup=await direct;await popup.waitForURL(destination);
  assert.equal(await popup.locator('#name').inputValue(),'');assert.equal(await popup.locator('#din').inputValue(),'');assert.equal(await popup.evaluate(()=>opener),null);await popup.close();assert.deepEqual(calls,['blank']);
  const failed=page.waitForEvent('popup');await page.evaluate(()=>openLiabilityDraft({waiverId:'synthetic_only',participantIndex:0},null));popup=await failed;
  await popup.getByRole('button',{name:'Open blank liability waiver'}).waitFor();assert.match(await popup.locator('body').innerText(),/No customer details, intake link, or DIN settings/);
  await popup.getByRole('button',{name:'Open blank liability waiver'}).click();await popup.waitForURL(destination);assert.equal(await popup.locator('#din').inputValue(),'');await popup.close();assert.deepEqual(calls,['blank','prefill','blank']);
  // A revoked session blocks the manual endpoint; provider errors do not bypass it.
  blankStatus=403;const denied=page.waitForEvent('popup');await page.locator('#openBlankLiability').click();popup=await denied;await popup.getByText('Staff access denied').waitFor();assert.equal(popup.url(),'about:blank');await popup.close();
  // Auth errors never offer automatic recovery from the row's error tab.
  prefillStatus=403;prefillError='Staff access denied';const auth=page.waitForEvent('popup');await page.evaluate(()=>openLiabilityDraft({waiverId:'synthetic_only',participantIndex:0},null));popup=await auth;await popup.getByText('Staff access denied').waitFor();assert.equal(await popup.locator('button').count(),0);await popup.close();
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  console.log(JSON.stringify({passed:true,manualBlank:true,provider400Recovery:true,revokedStaffBlocked:true,noDINDefaults:true,productionRequests:0}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

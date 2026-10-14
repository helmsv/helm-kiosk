// Isolated actual-page QA. All data/provider endpoints are mocked; no signed records or live drafts.
const assert=require('node:assert/strict'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {normalizeIntake}=require('../lib/intake-normalize');
const fixture=structuredClone(require('./fixtures/intake.json'));
const details=normalizeIntake(fixture,new Date('2026-10-14T00:00:00Z'));
const root=path.resolve(__dirname,'..');
const files=['/tech.html','/nav.js','/nav.css','/rental-mobile.css','/rental-data.js','/rental-dialog.js'];
const destination='https://waiver.smartwaiver.com/p/synthetic_opening/';
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH});
 const context=await browser.newContext();context.setDefaultTimeout(10000);const errors=[],unexpected=[],posts=[];let release, missing=false, fail=false;
 await context.addInitScript(()=>{window.setInterval=()=>1;window.EventSource=class{addEventListener(){}close(){}};});
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.hostname==='cdn.tailwindcss.com')return route.continue();
  const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(req.url()===destination)return route.fulfill({contentType:'text/html',body:'<h1>Synthetic unsigned waiver</h1><p>No live waiver created</p>'});
  if(url.hostname!=='opening.test'){unexpected.push(url.hostname);return route.abort();}
  if(url.pathname==='/staff-session.js')return route.fulfill({contentType:'application/javascript',body:'window.StaffSession={ready:async()=>{},isReady:()=>true,fetch:(...args)=>fetch(...args)};'});
  if(files.includes(url.pathname))return route.fulfill({path:path.join(root,url.pathname)});
  if(url.pathname==='/api/hidden')return json({keys:[]});
  if(url.pathname==='/api/open-intakes')return json({rows:details.participants.map(p=>({...p,waiver_id:fixture.waiverId,signed_on:new Date().toISOString()}))});
  if(url.pathname==='/api/open-liabilities')return json({rows:[]});
  if(url.pathname==='/api/intake-details'){const value=structuredClone(details);if(missing)value.participants[0].weight_lb=null;return json(value);}
  if(url.pathname==='/favicon.ico')return route.fulfill({status:204});
  if(url.pathname==='/api/waiver-prefill'){
   posts.push(req.postDataJSON());
   await new Promise(resolve=>release=resolve);
   return fail?json({error:'Synthetic upstream failure [prefill-create; HTTP 400]'},502):json({url:destination,expiresInSeconds:3600});
  }
  unexpected.push(url.pathname);return route.abort();
 });
 try{
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:375,height:720});await page.goto('https://opening.test/tech.html');
  await page.locator('button[data-action="liab"]').first().click();
  await page.locator('#dinModal').waitFor({state:'visible'});
  assert.equal(posts.length,0);assert.equal(await page.locator('#inp_bsl').inputValue(),'');assert.equal(await page.locator('#btnOpenLiab').isEnabled(),false);
  assert.match(await page.locator('#liabilityReviewStatus').innerText(),/measured boot sole length/);
  await page.locator('#inp_bsl').fill('315');assert.equal(await page.locator('#btnOpenLiab').isEnabled(),false);
  const finalInputs=['inp_final_left_toe','inp_final_left_heel','inp_final_right_toe','inp_final_right_heel'];
  for(const id of finalInputs)assert.equal(await page.locator('#'+id).inputValue(),'');
  await page.locator('#inp_final_left_toe').fill('5.50');await page.locator('#reviewTechnician').check();
  assert.equal(await page.locator('#btnOpenLiab').isEnabled(),false);
  for(const [index,value] of ['5.50','6.00','5.75','6.25'].entries())await page.locator('#'+finalInputs[index]).fill(value);
  assert.equal(await page.locator('#reviewTechnician').isChecked(),false);
  await page.locator('#reviewTechnician').check();
  const pendingPopup=page.waitForEvent('popup');await page.locator('#btnOpenLiab').click();const popup=await pendingPopup;
  await page.waitForFunction(()=>document.getElementById('btnOpenLiab').getAttribute('aria-busy')==='true');
  await page.locator('#btnOpenLiab').dispatchEvent('click');
  await page.waitForTimeout(100);assert.equal(posts.length,1);
  assert.equal(posts[0].waiverId,fixture.waiverId);assert.equal(posts[0].participantIndex,0);
  assert.equal(posts[0].technicianReview.reviewed,true);assert.equal(posts[0].technicianReview.calculated.bootSoleLengthMm,315);
  assert.equal(posts[0].technicianReview.participant.first_name,'Adult');
  assert.deepEqual(posts[0].technicianReview.finalSettings,{leftToe:'5.50',leftHeel:'6.00',rightToe:'5.75',rightHeel:'6.25'});
  await popup.close();release();await page.getByRole('button',{name:'Reopen prepared waiver'}).last().waitFor();
  const recovered=context.waitForEvent('page');await page.locator('#liabilityReviewStatus').getByRole('button',{name:'Reopen prepared waiver'}).click();const form=await recovered;
  await form.waitForURL(destination);assert.equal(posts.length,1);assert.equal(await form.evaluate(()=>opener),null);await form.close();
  // Opening another participant uses fresh identity/review and cannot reuse the adult's values.
  await page.locator('#dinParticipant').selectOption('1');assert.equal(await page.locator('#inp_bsl').inputValue(),'');assert.equal(await page.locator('#reviewTechnician').isChecked(),false);assert.equal(await page.locator('#btnOpenLiab').isEnabled(),false);
  assert.match(await page.locator('#i_name').innerText(),/Child Example/);
  for(const id of finalInputs)assert.equal(await page.locator('#'+id).inputValue(),'');
  await page.locator('#dinClose').click();
  missing=true;await page.locator('button[data-action="liab"]').first().click();await page.locator('#inp_bsl').fill('315');await page.locator('#reviewTechnician').check();
  assert.equal(await page.locator('#btnOpenLiab').isEnabled(),false);assert.match(await page.locator('#out_summary').innerText(),/weight/);assert.equal(posts.length,1);
  await page.locator('#dinClose').click();missing=false;
  // Explicit retry after a provider error stays with the reviewed selection; no automatic retries.
  await page.locator('button[data-action="liab"]').first().click();await page.locator('#inp_bsl').fill('315');await page.locator('#reviewTechnician').check();
  fail=true;const failed=page.waitForEvent('popup');await page.locator('#btnOpenLiab').click();const errorTab=await failed;
  await page.waitForTimeout(100);release();await errorTab.waitForFunction(()=>document.body.textContent.includes('Synthetic upstream failure [prefill-create; HTTP 400]'));
  assert.match(await page.locator('#liabilityReviewStatus').innerText(),/HTTP 400/);assert.equal(posts.length,2);await errorTab.close();
  fail=false;const retried=page.waitForEvent('popup');await page.locator('#btnOpenLiab').click();const retryTab=await retried;await page.waitForTimeout(100);release();await retryTab.waitForURL(destination);
  assert.equal(posts.length,3);assert.deepEqual(posts[2],posts[1]);await retryTab.close();
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  console.log(JSON.stringify({passed:true,rowReview:true,reviewedSnapshot:true,unequalExplicitFinals:true,partialFinalsBlocked:true,repeatedClickSingleRequest:true,closedPopupSameDraft:true,missingWeightBlocked:true,participantChangeClearsReview:true,explicitRetry:true,productionRequests:0}));
 }finally{if(release)release();await context.unrouteAll({behavior:'ignoreErrors'});await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

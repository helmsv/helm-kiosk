const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../tech.html'), 'utf8');
const source = html.slice(html.indexOf('    const openingDrafts='), html.indexOf('    // ----- participant extraction helpers'));
function harness(fetcher, popup = true) {
  const nodes = new Map(), requests = [], tabs = [], notices = [];
  const node = () => ({ value:'', disabled:false, checked:false, style:{}, textContent:'', children:[],
    replaceChildren(...children){this.children=children; this.textContent=children.filter(c=>typeof c==='string').join('');},
    append(...children){this.children.push(...children);}, addEventListener(type, fn){this[type]=fn;},
    setAttribute(){}, removeAttribute(){} });
  const get = id => { if(!nodes.has(id))nodes.set(id,node());return nodes.get(id); };
  const context = { URL, AbortController, current:null, Date,
    rowKey:(id,index)=>`${id}:${index}`,showToast:text=>notices.push(text),
    setTimeout:fn=>{context.timeout=fn;return 1;},clearTimeout:()=>{},
    document:{getElementById:get,createElement:node,createTextNode:text=>text},
    StaffSession:{isReady:()=>true,fetch:async(...args)=>{requests.push(args);return fetcher(...args);}},
    window:{open:(url)=>{if(!popup)return null;const tab={closed:false,opener:{},url,document:{title:'',body:node(),createElement:node},location:{replace:url=>tab.url=url}};tabs.push(tab);return tab;}}
  };
  vm.createContext(context);vm.runInContext(source,context);
  return {context,get,requests,tabs,notices,open:(review)=>context.openLiabilityDraft({waiverId:'synthetic',participantIndex:0},get('opener'),review)};
}
const success = () => ({ok:true,status:200,json:async()=>({url:'https://waiver.smartwaiver.com/p/fictional/',expiresInSeconds:3600})});
function deferred(){let resolve;return {promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)};}
test('blocked popup never sends a request and gives a persistent recovery instruction',async()=>{
  const h=harness(success,false);await h.open();assert.equal(h.requests.length,0);assert.match(h.get('liabilityOpenStatus').textContent,/No draft was requested/);
});
test('repeated click submits one reviewed snapshot; closing the loading tab recovers that same draft',async()=>{
  const wait=deferred(),h=harness(()=>wait.promise),review={reviewed:true,calculated:{bootSoleLengthMm:315}};
  const first=h.open(review);await h.open(review);assert.equal(h.requests.length,1);assert.equal(h.tabs.length,1);
  h.tabs[0].closed=true;wait.resolve(success());await first;
  assert.equal(JSON.parse(h.requests[0][1].body).technicianReview.calculated.bootSoleLengthMm,315);
  assert.match(h.get('liabilityOpenStatus').textContent,/without creating another draft/);
  h.get('liabilityOpenStatus').children[1].click();assert.equal(h.tabs[1].url,'https://waiver.smartwaiver.com/p/fictional/');assert.equal(h.requests.length,1);
  assert.equal(h.get('opener').disabled,false);
});
test('review invalidated during pending request remains disabled after response',async()=>{
  const wait=deferred(),h=harness(()=>wait.promise);h.context.current={waiver_id:'synthetic',participant_index:0,calculation:{din:6}};
  h.get('reviewTechnician').checked=true;const first=h.open();h.get('reviewTechnician').checked=false;
  wait.resolve(success());await first;assert.equal(h.get('btnOpenLiab').disabled,true);
});
test('session interruption rejects stale response even if a new session becomes ready',async()=>{
  const wait=deferred(),h=harness(()=>wait.promise);const first=h.open();vm.runInContext('liabilitySessionGeneration++',h.context);
  wait.resolve(success());await first;assert.equal(h.tabs[0].url,'about:blank');assert.match(h.get('liabilityOpenStatus').textContent,/session ended/);
});
test('provider errors, non-JSON response and unsafe destination stay visible without navigation',async()=>{
  for(const response of [
    {ok:false,status:502,json:async()=>({error:'Unable to prepare [prefill-create; HTTP 400]'})},
    {ok:false,status:504,json:async()=>{throw new Error('unexpected token');}},
    {ok:true,status:200,json:async()=>({url:'https://attacker.invalid/'})}
  ]) { const h=harness(()=>response);await h.open();assert.equal(h.tabs[0].url,'about:blank');assert.match(h.get('liabilityOpenStatus').textContent,/HTTP 400|HTTP 504|Unexpected waiver/);assert.equal(h.get('opener').disabled,false); }
});
test('slow network times out once without an automatic draft retry',async()=>{
  const h=harness((url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{const err=new Error();err.name='AbortError';reject(err);})));const first=h.open();h.context.timeout();await first;
  assert.equal(h.requests.length,1);assert.match(h.get('liabilityOpenStatus').textContent,/unsigned draft may have been created/);assert.equal(h.get('opener').disabled,false);
});
test('the row action enters participant review instead of silently requesting an unreviewed draft',()=>{
  const rowSource=html.slice(html.indexOf('    function renderTable()'),html.indexOf('    const openingDrafts='));
  assert.match(rowSource,/action === "din" \|\| action === "liab"/);assert.doesNotMatch(rowSource,/openLiabilityDraft\(/);
});
test('prepared-draft recovery expires and cannot cross a staff session change',async()=>{
  for(const expired of [true,false]){
    const wait=deferred(),h=harness(()=>wait.promise);const first=h.open();h.tabs[0].closed=true;wait.resolve(success());await first;
    if(expired)h.context.Date={now:()=>Date.now()+3600001};else vm.runInContext('liabilitySessionGeneration++',h.context);
    h.get('liabilityOpenStatus').children[1].click();assert.equal(h.tabs.length,1);assert.match(h.get('liabilityOpenStatus').textContent,/expired|Sign in again/);
  }
});
test('specific untransferred field labels remain visible as text for staff review',async()=>{
  const h=harness(()=>({ok:true,status:200,json:async()=>({url:'https://waiver.smartwaiver.com/p/fictional/',skippedFields:['Emergency contact','<b>Phone</b>']})}));await h.open();
  assert.match(h.get('liabilityOpenStatus').textContent,/Not copied: Emergency contact; <b>Phone<\/b>/);assert.equal(h.get('liabilityOpenStatus').children.length,1);
});

test('partial prefill retains exact reviewed manual references without claiming dropdown transfer',async()=>{
 const manualFields=[{label:'Skier Code',value:'M'},{label:'Initial Indicator Value',value:'7'},{label:'Boot Sole Length (mm)',value:'315'}];
 const h=harness(()=>({ok:true,status:200,json:async()=>({url:'https://waiver.smartwaiver.com/p/fictional/',manualFields})}));await h.open();
 const text=h.get('liabilityOpenStatus').textContent;assert.match(text,/Complete manually using these reviewed values/);assert.match(text,/Skier Code: M; Initial Indicator Value: 7; Boot Sole Length \(mm\): 315/);assert.match(text,/No waiver has been signed/);
});

test('text prefill without manual references directs staff to review editable values, not reenter transferred fields',async()=>{
 const h=harness(()=>({ok:true,status:200,json:async()=>({url:'https://waiver.smartwaiver.com/p/fictional/',manualFields:[]})}));await h.open();
 const text=h.get('liabilityOpenStatus').textContent;assert.match(text,/editable calculated references/);assert.match(text,/each independent final setting/);assert.doesNotMatch(text,/Dropdowns are unfilled|Complete Skier Code/);
});

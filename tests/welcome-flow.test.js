const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
function setup(fetchImpl) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set(id === 'confirmCard' || id === 'status' ? ['hidden'] : []);
      elements.set(id, { id, value: '', checked: id === 'minorsNo', disabled: false, textContent: '', listeners: {},
        classList: { add(x) { classes.add(x); }, remove(x) { classes.delete(x); }, contains(x) { return classes.has(x); } },
        addEventListener(type, fn) { this.listeners[type] = fn; }, appendChild() {},
        checkValidity() { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.value); },
        querySelectorAll() { return ['email','dobMonth','dobDay','dobYear','minorsYes','minorsNo','continueBtn'].map(element); },
      });
    }
    return elements.get(id);
  }
  const calls = [], destinations = [], windowListeners = {};
  const context = { document: { getElementById: element, createElement: () => ({}) }, window: { location: { assign(url) { destinations.push(url); } }, addEventListener(type, fn) { windowListeners[type] = fn; } }, URL, URLSearchParams, Date, console, fetch: async (url, options) => { const body=JSON.parse(options.body); calls.push({url,body}); return fetchImpl(url, body); } };
  vm.runInNewContext(script, context);
  element('email').value = 'entered@example.com'; element('dobYear').value='1986'; element('dobMonth').value='03'; element('dobDay').value='04';
  return { element, calls, destinations, windowListeners, submit: () => element('startForm').listeners.submit({ preventDefault() {} }), click: id => element(id).listeners.click() };
}
const good = data => ({ok:true, json:async()=>data});
const link = {url:'https://waiver.smartwaiver.com/p/test_draft/'};

test('no-match path preserves welcome email and date in API request', async () => {
  const app=setup(async url=>good(url==='/api/lookup'?{match_quality:'none'}:link));
  await app.submit();
  assert.equal(app.calls.length,2);
  assert.equal(app.calls[1].body.email,'entered@example.com');
  assert.equal(app.calls[1].body.dob,'1986-03-04');
  assert.equal(app.calls[1].body.first_name,'');
  assert.equal(app.destinations.length,1);
  assert.equal(app.element('continueBtn').disabled,true,'stay disabled until navigation');
  app.windowListeners.pageshow();
  assert.equal(app.element('continueBtn').disabled,false,'browser Back restores a usable welcome screen');
});
test('lookup failure still creates editable prefill with welcome details', async () => {
  const app=setup(async url=>{if(url==='/api/lookup')throw new Error('offline');return good(link);});
  await app.submit();assert.equal(app.calls[1].body.email,'entered@example.com');assert.equal(app.calls[1].body.dob,'1986-03-04');
});
test('confirmed match uses entered email and DOB rather than stale Lightspeed values', async () => {
  const app=setup(async url=>good(url==='/api/lookup'?{match_quality:'exact',first_name:'Confirmed',last_name:'Adult',email:'old@example.com',date_of_birth:'1970-01-01',lightspeed_id:'123'}:link));
  await app.submit(); assert.equal(app.calls.length,1); assert.equal(app.element('confirmCard').classList.contains('hidden'),false);
  await app.click('btnYes'); assert.equal(app.calls[1].body.email,'entered@example.com'); assert.equal(app.calls[1].body.dob,'1986-03-04'); assert.equal(app.calls[1].body.first_name,'Confirmed');
});
test('Not me discards record identity and keeps welcome data', async () => {
  const app=setup(async url=>good(url==='/api/lookup'?{match_quality:'partial',first_name:'Wrong',lightspeed_id:'123'}:link));
  await app.submit(); await app.click('btnNotMe'); assert.equal(app.calls[1].body.first_name,'');assert.equal(app.calls[1].body.lightspeed_id,'');assert.equal(app.calls[1].body.dob,'1986-03-04');
});
test('changing welcome input invalidates an old match', async () => {
  const app=setup(async()=>good({match_quality:'exact',first_name:'Old'}));
  await app.submit(); app.element('email').value='new@example.com';app.element('startForm').listeners.input();
  assert.equal(app.element('confirmCard').classList.contains('hidden'),true);
  await app.click('btnYes');assert.equal(app.calls.length,1);
});
test('family request includes adult DOB and minors selection', async () => {
  const app=setup(async url=>good(url==='/api/lookup'?{match_quality:'none'}:link));
  app.element('minorsYes').checked=true;app.element('minorsNo').checked=false;
  await app.submit();assert.equal(app.calls[1].body.minors,true);assert.equal(app.calls[1].body.dob,'1986-03-04');
});
test('prefill failure leaves data visible and buttons usable for retry', async () => {
  const app=setup(async url=>url==='/api/lookup'?good({match_quality:'none'}):({ok:false,json:async()=>({error:'Try again shortly.'})}));
  await app.submit();assert.equal(app.destinations.length,0);assert.equal(app.element('email').value,'entered@example.com');assert.equal(app.element('continueBtn').disabled,false);assert.equal(app.element('status').textContent,'Try again shortly.');
  await app.submit();assert.equal(app.calls.length,4);
});
test('duplicate submissions during lookup do not create duplicate requests', async () => {
  let release;const gate=new Promise(r=>{release=r;});
  const app=setup(async url=>{if(url==='/api/lookup'){await gate;return good({match_quality:'none'});}return good(link);});
  const first=app.submit();await app.submit();assert.equal(app.calls.length,1);release();await first;assert.equal(app.calls.length,2);
});
test('invalid calendar dates and underage signer are blocked before lookup', async () => {
  const app=setup(async()=>good({}));
  app.element('dobMonth').value='02';app.element('dobDay').value='30';await app.submit();assert.equal(app.calls.length,0);
  app.element('dobYear').value='2020';app.element('dobMonth').value='01';app.element('dobDay').value='01';await app.submit();assert.equal(app.calls.length,0);assert.match(app.element('status').textContent,/adult signer/);
});

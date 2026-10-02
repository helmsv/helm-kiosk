const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/intake-details');
const fixture = require('./fixtures/intake.json');
function res() { return { headers:{}, statusCode:200, setHeader(k,v){this.headers[k]=v;}, status(c){this.statusCode=c;return this;}, json(b){this.body=b;return this;} }; }
const req = id => ({method:'GET',headers:{authorization:'Bearer synthetic.staff.jwt'},query:{waiverId:id}});
const authorize = upstream => async(url, options) => url === 'https://helm-snowos.vercel.app/api/rentals/authorize' ? {ok:true,json:async()=>({authorized:true})} : upstream(url,options);
test('intake API requires staff, sends server-only Bearer and verifies exact intake identity', async () => {
  const oldFetch=global.fetch, oldEnv={...process.env};
  process.env.SW_API_KEY='synthetic_key'; process.env.INTAKE_WAIVER_ID=fixture.templateId; process.env.SW_BASE_URL='https://api.smartwaiver.com/v4';
  try {
    global.fetch=async()=>assert.fail('No external calls without staff token');
    const denied=res(); await handler({method:'GET',query:{waiverId:fixture.waiverId}},denied);assert.equal(denied.statusCode,401);
    const calls=[];
    global.fetch=authorize(async (url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({waiver:fixture})};});
    const good=res(); await handler(req(fixture.waiverId), good);
    assert.equal(good.statusCode,200); assert.equal(good.body.participants[0].weight_lb,180);
    assert.equal('date_of_birth' in good.body.participants[0],false);
    assert.equal(calls[0].url,`https://api.smartwaiver.com/v4/waivers/${fixture.waiverId}`);
    assert.equal(calls[0].options.headers.Authorization,'Bearer synthetic_key'); assert.equal(calls[0].options.cache,'no-store');
    assert.equal(good.headers['Cache-Control'],'private, no-store');
    for (const change of [{waiverId:'different_customer'}, {templateId:'liability_template'}]) {
      global.fetch=authorize(async()=>({ok:true,json:async()=>({waiver:{...fixture,...change}})}));
      const bad=res(); await handler(req(fixture.waiverId),bad);assert.equal(bad.statusCode,502);assert.deepEqual(bad.body.participants,[]);
    }
    for (const status of [401,403,404,429,500]) {
      global.fetch=authorize(async()=>({ok:false,status,text:async()=> 'SENSITIVE_UPSTREAM'}));
      const bad=res(); await handler(req(fixture.waiverId),bad);assert.equal(bad.statusCode,status===404?404:status===429?429:502);assert.doesNotMatch(JSON.stringify(bad.body),/SENSITIVE|synthetic_key/);
    }
    global.fetch=authorize(async()=>assert.fail('Invalid IDs must not reach Smartwaiver'));
    for (const id of [undefined, '', ['a','b'], '../not-a-waiver']) {const bad=res();await handler(req(id),bad);assert.equal(bad.statusCode,400);}
  } finally { global.fetch=oldFetch; process.env=oldEnv; }
});

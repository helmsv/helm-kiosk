const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/lookup');

test('lookup accepts only an exact email match across broad Lightspeed results', async () => {
  const oldFetch = global.fetch, oldEnv = {...process.env}, oldLog = console.log;
  process.env.LS_BASE_URL='https://synthetic.example.invalid';process.env.LS_TOKEN='synthetic';
  console.log=()=>{};
  const unrelated={id:'unrelated',email:'someone-else@example.invalid',first_name:'Other'};
  let matching=false;
  const requests=[];
  global.fetch=async (url,options) => {
    requests.push({url,method:options.method || 'GET'});
    const customers=matching?[unrelated,{id:'correct',email:' ENTERED@example.invalid ',first_name:'Correct'}]:[unrelated];
    return {status:200,headers:{get:()=> 'application/json'},json:async()=>({data:customers})};
  };
  async function run() {
    const res={status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handler({method:'POST',body:{email:'entered@example.invalid',first_name:'Entered',last_name:'Signer'}},res);
    return res;
  }
  try {
    let out=await run();assert.equal(out.code,200);assert.equal(out.body.match_quality,'new');assert.equal(out.body.lightspeed_id,'');assert.equal(out.body.first_name,'Entered');assert.equal(out.body.mobile,'');
    matching=true;out=await run();assert.equal(out.body.match_quality,'exact');assert.equal(out.body.lightspeed_id,'correct');assert.equal(out.body.first_name,'Correct');
    assert.ok(requests.every(r=>r.method==='GET'));assert.ok(requests.every(r=>!r.url.includes('first_name')));
  } finally {global.fetch=oldFetch;process.env=oldEnv;console.log=oldLog;}
});

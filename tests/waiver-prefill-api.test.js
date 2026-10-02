const test=require('node:test'),assert=require('node:assert/strict');
require('./fixtures/technician-enum-contract')(['liability_template']);
const {normalizeIntake}=require('../lib/intake-normalize');
const req=body=>({method:'POST',headers:{host:'kiosk.example',origin:'https://kiosk.example','content-type':'application/json',authorization:'Bearer staff.test.jwt'},body});
function res(){return{headers:{},statusCode:200,setHeader(k,v){this.headers[k]=v},status(n){this.statusCode=n;return this},json(body){this.body=body;return this}};}
const person={firstName:'Synthetic',lastName:'Example',dob:'1990-01-01',isMinor:false,customParticipantFields:{w:{displayText:'Weight',value:'180'},h:{displayText:'Height',value:'71'},s:{displayText:'Skier Type: (Check One)',value:'II'}}};
const waiver={waiverId:'synthetic_intake_001',templateId:'intake_template',email:'sample@example.invalid',participants:[person]};
const definitions={intake_template:{templateId:'intake_template',title:'Synthetic intake',customParticipantFields:[]},liability_template:{templateId:'liability_template',publishedVersion:1,title:'Synthetic final',customFields:[{guid:'code_target',label:'Skier Code',fieldType:'textbox',type:'string'},{guid:'din_target',label:'DIN',fieldType:'optionlist',type:'enum'},{guid:'bsl_target',label:'Boot Sole Length (mm)',fieldType:'numerictextbox',type:'number'}]}};
const review=()=>{const p=normalizeIntake(waiver).participants[0];return{reviewed:true,waiverId:waiver.waiverId,participantIndex:0,participant:{first_name:p.first_name,last_name:p.last_name},source:{weight_lb:p.weight_lb,height_in:p.height_in,age:p.age,skier_type:p.skier_type},calculated:{skierCode:'M',din:7,bootSoleLengthMm:315}}};
test('protected prefill/metadata lifecycle and synthetic preview never bypass staff or edit a signed waiver',async()=>{
 const oldFetch=global.fetch,env={...process.env};process.env.SW_API_KEY='server-only-synthetic';process.env.INTAKE_WAIVER_ID='intake_template';process.env.LIABILITY_WAIVER_ID='liability_template';
 delete require.cache[require.resolve('../api/waiver-prefill')];const handler=require('../api/waiver-prefill');
 const calls=[];let authorized=true;let mismatch=false;
 global.fetch=async(url,opts={})=>{calls.push({url,opts});if(url==='https://helm-snowos.vercel.app/api/rentals/authorize')return authorized?{ok:true,json:async()=>({authorized:true})}:{ok:false,status:403};
  assert.equal(opts.headers.Authorization,'Bearer server-only-synthetic');
  const match=url.match(/\/templates\/([^/?]+)(?:\?customFields=true)?$/);
  if(match)return{ok:true,json:async()=>({template:definitions[match[1]]})};
  if(url.endsWith('/waivers/synthetic_intake_001'))return{ok:true,json:async()=>({waiver:mismatch?{...waiver,waiverId:'different_intake'}:waiver})};
  if(url.endsWith('/prefill')){assert.equal(opts.method,'POST');return{ok:true,json:async()=>({prefill:{uuid:'synthetic_token',url:'https://waiver.smartwaiver.com/p/synthetic_token/'}})}};
  assert.fail('Unexpected upstream request '+url);
 };
 try{
  for(const stage of ['liability','template-check','synthetic-preview']){const r=req({stage,waiverId:waiver.waiverId,participantIndex:0});delete r.headers.authorization;const out=res();await handler(r,out);assert.equal(out.statusCode,401);}
  assert.equal(calls.length,0);
  let out=res();await handler(req({stage:'template-check'}),out);assert.equal(out.statusCode,200);assert.equal(out.body.templates.length,2);assert.doesNotMatch(JSON.stringify(out.body),/guid|server-only-synthetic|sample@example/);
  calls.length=0;out=res();await handler(req({stage:'synthetic-preview'}),out);assert.equal(out.statusCode,200);assert.equal(calls.some(c=>c.url.includes('/waivers/')),false);const preview=JSON.parse(calls.find(c=>c.opts.method==='POST'&&c.url.endsWith('/prefill')).opts.body);assert.equal(preview.participants[0].lastName,'Unsigned Test');assert.equal(preview.customWaiverFields.din_target,'7');
  calls.length=0;out=res();await handler(req({stage:'liability',waiverId:waiver.waiverId,participantIndex:0,technicianReview:review()}),out);assert.equal(out.statusCode,200);assert.equal(out.headers['Cache-Control'],'private, no-store');assert.equal(calls.filter(c=>c.url.includes('helm-snowos')).length,2);const posted=JSON.parse(calls.find(c=>c.url.endsWith('/prefill')).opts.body);assert.equal(posted.lockdownPrefill,false);assert.equal(posted.participants[0].firstName,'Synthetic');assert.equal(posted.email,'sample@example.invalid');assert.equal(posted.customWaiverFields.din_target,'7');assert.equal(posted.externalId,'intake_synthetic_intake_001_0');assert.equal(calls.some(c=>c.url.includes('/waivers/')&&c.opts.method!=='GET'),false);
  authorized=false;calls.length=0;out=res();await handler(req({stage:'liability',waiverId:waiver.waiverId}),out);assert.equal(out.statusCode,403);assert.equal(calls.length,1);
  authorized=true;mismatch=true;calls.length=0;out=res();await handler(req({stage:'liability',waiverId:waiver.waiverId}),out);assert.equal(out.statusCode,400);assert.equal(calls.some(c=>c.url.endsWith('/prefill')),false);
  calls.length=0;const foreign=req({stage:'synthetic-preview'});foreign.headers.origin='https://foreign.example';out=res();await handler(foreign,out);assert.equal(out.statusCode,403);assert.equal(calls.length,0);
 }finally{global.fetch=oldFetch;process.env=env;}
});

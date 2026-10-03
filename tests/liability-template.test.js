const test=require('node:test'),assert=require('node:assert/strict');
const handler=require('../api/liability-template');
const request=()=>({method:'POST',headers:{host:'kiosk.example',origin:'https://kiosk.example',authorization:'Bearer synthetic.staff.jwt'},body:{url:'https://attacker.invalid',waiverId:'must-not-read',din:12}});
const response=()=>({headers:{},statusCode:200,setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}});
test('blank fallback authorizes staff, ignores request data and never contacts Smartwaiver',async()=>{
 const oldFetch=global.fetch,env={...process.env};let allowed=true;const calls=[];
 process.env.LIABILITY_WAIVER_ID='a2njtmnzxs7icea9mdxff6';
 global.fetch=async(url)=>{calls.push(url);assert.equal(url,'https://helm-snowos.vercel.app/api/rentals/authorize');return{ok:allowed,status:403,json:async()=>({authorized:allowed})};};
 try{
  let req=request();delete req.headers.authorization;let out=response();await handler(req,out);assert.equal(out.statusCode,401);assert.equal(calls.length,0);
  req=request();req.headers.origin='https://foreign.invalid';out=response();await handler(req,out);assert.equal(out.statusCode,403);assert.equal(calls.length,0);
  req=request();req.method='GET';out=response();await handler(req,out);assert.equal(out.statusCode,405);assert.equal(calls.length,0);
  out=response();await handler(request(),out);assert.equal(out.statusCode,200);assert.equal(out.headers['Cache-Control'],'private, no-store');assert.deepEqual(out.body,{blank:true,url:'https://www.smartwaiver.com/w/a2njtmnzxs7icea9mdxff6/kiosk/'});assert.equal(calls.length,1);
  allowed=false;out=response();await handler(request(),out);assert.equal(out.statusCode,403);assert.equal(out.body.url,undefined);
  allowed=true;process.env.LIABILITY_WAIVER_ID='unverified';out=response();await handler(request(),out);assert.equal(out.statusCode,503);assert.equal(out.body.url,undefined);
  global.fetch=async()=>{throw new Error('private provider error');};out=response();await handler(request(),out);assert.equal(out.statusCode,503);assert.doesNotMatch(JSON.stringify(out.body),/private provider error|https:/);
 }finally{global.fetch=oldFetch;process.env=env;}
});

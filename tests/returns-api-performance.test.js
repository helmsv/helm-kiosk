const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness({ authorize = async () => {}, query = async () => ({ rows: [] }) } = {}) {
  const module = { exports: {} };
  let ticks = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/rentals-outstanding.js'), 'utf8'), {
    module, require(name) {
      if (name === '../lib/staff-auth') return { requireStaff: authorize };
      if (name === './_db') return { getPool: () => ({ query }) };
      if (name === 'node:perf_hooks') return { performance: { now: () => ++ticks } };
      throw Error('Unexpected dependency: ' + name);
    }
  });
  return module.exports;
}
function response() {
  return { headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(v) { this.statusCode=v;return this; }, json(v) { this.body=v;return this; }, end(v) { this.body=JSON.parse(v); } };
}
const input = { method:'GET', query:{ status:'OUT' } };

test('every Returns read authorizes and reads current rows without DDL or caching', async () => {
  let n=0; const calls=[];
  const handler=harness({ authorize: async () => calls.push('auth'), query: async(sql,params) => {
    calls.push('read'); assert.match(sql,/^\s*SELECT/); assert.doesNotMatch(sql,/CREATE|ALTER|INSERT|UPDATE|DELETE/);
    assert.equal(params[0],'OUT'); return { rows:[{ id:++n }] };
  }});
  for (let i=1;i<=2;i++) { const res=response();await handler(input,res);assert.equal(res.statusCode,200);assert.equal(res.body.rentals[0].id,i);assert.equal(res.headers['Cache-Control'],'private, no-store');assert.match(res.headers['Server-Timing'],/^staff;dur=\d+\.\d, database;dur=\d+\.\d$/); }
  assert.deepEqual(calls,['auth','read','auth','read']);
});
test('denied and unavailable staff sessions never touch database or disclose timing', async () => {
  for(const status of [401,403,503]) {
    const handler=harness({authorize:async()=>{throw Object.assign(Error('Staff unavailable'),{status});},query:()=>assert.fail('database called')});
    const res=response();await handler(input,res);assert.equal(res.statusCode,status);assert.equal(res.headers['Server-Timing'],undefined);
  }
});
test('invalid method makes no database read and filters remain parameterized', async () => {
  const handler=harness({query:async(sql,params)=>{assert.ok(params.includes("%synthetic' or 1=1 --%"));assert.doesNotMatch(sql,/synthetic/);return {rows:[]};}});
  const rejected=response();await handler({...input,method:'POST'},rejected);assert.equal(rejected.statusCode,405);
  const allowed=response();await handler({...input,query:{name:"Synthetic' OR 1=1 --",status:'ALL'}},allowed);assert.equal(allowed.statusCode,200);
});
test('missing schema or database outage fails instead of returning a misleading empty result', async () => {
  const handler=harness({query:async()=>{throw Error('Synthetic unavailable schema');}});
  const res=response();await handler(input,res);assert.equal(res.statusCode,500);assert.equal(res.body.rentals,undefined);assert.match(res.headers['Server-Timing'],/database;dur=/);
});

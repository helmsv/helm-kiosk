const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function load(pool){const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../api/_ensureSchema.js'),'utf8'),{module,require(name){assert.equal(name,'./_db');return {getPool:()=>pool};}});return module.exports.ensureSchema;}
test('complete schema uses one metadata read and no DDL or second connection',async()=>{
 let reads=0;const ensure=load({query:async sql=>{reads++;assert.match(sql,/pg_attribute/);assert.doesNotMatch(sql,/CREATE|ALTER/);return {rows:[{ready:true}]};},connect:()=>assert.fail('no connection required')});
 await Promise.all([ensure(),ensure(),ensure()]);await ensure();assert.equal(reads,1);
});
test('older or fresh schema initialization uses one transaction client and joins concurrent callers',async()=>{
 const calls=[];let connections=0;const ensure=load({query:async()=>{calls.push('catalog');return {rows:[{ready:false}]};},connect:async()=>{connections++;return {query:async sql=>calls.push(sql.trim()),release:()=>calls.push('release')};}});
 await Promise.all([ensure(),ensure()]);await ensure();assert.equal(connections,1);assert.equal(calls[0],'catalog');assert.equal(calls[1],'BEGIN');assert.ok(calls.some(x=>x.startsWith('ALTER TABLE')));assert.deepEqual(calls.slice(-2),['COMMIT','release']);
});
test('failed initialization rolls back, releases and remains retryable',async()=>{
 let fail=true,connections=0;const calls=[];const ensure=load({query:async()=>({rows:[{ready:false}]}),connect:async()=>{connections++;return {query:async sql=>{calls.push(sql.trim());if(fail&&sql.includes('CREATE TABLE'))throw Error('Synthetic failed initialization');},release:()=>calls.push('release')};}});
 await assert.rejects(ensure(),/Synthetic/);assert.deepEqual(calls.slice(-2),['ROLLBACK','release']);fail=false;await ensure();assert.equal(connections,2);assert.deepEqual(calls.slice(-2),['COMMIT','release']);
});
test('catalog-read failure does not run DDL or cache readiness',async()=>{
 let fail=true,reads=0;const ensure=load({query:async()=>{reads++;if(fail)throw Error('Synthetic metadata unavailable');return {rows:[{ready:true}]};},connect:()=>assert.fail('not permitted')});await assert.rejects(ensure(),/Synthetic/);fail=false;await ensure();assert.equal(reads,2);
});

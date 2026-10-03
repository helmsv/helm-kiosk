// Explicit local disposable database only. Never accepts deployed credentials.
const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const {Pool}=require(process.env.QA_PG_MODULE||'pg');
const port=Number(process.env.QA_PG_PORT);if(!Number.isInteger(port)||port<1024)throw Error('Set disposable QA_PG_PORT');
const config={host:'127.0.0.1',port,user:'postgres',password:'synthetic-local-only',ssl:false};
const source=fs.readFileSync(path.join(__dirname,'../api/_ensureSchema.js'),'utf8');
function load(pool,counts){const module={exports:{}};vm.runInNewContext(source,{module,require:()=>({getPool:()=>({query:async(...args)=>{counts.reads++;return pool.query(...args);},connect:async()=>{counts.connections++;return pool.connect();}})})});return module.exports.ensureSchema;}
(async()=>{const admin=new Pool({...config,database:'postgres'});try{
 for(const name of ['qa_fresh','qa_legacy']){await admin.query(`CREATE DATABASE ${name}`);const pool=new Pool({...config,database:name});try{
 if(name==='qa_legacy'){await pool.query("CREATE TABLE rental_agreements(id BIGSERIAL PRIMARY KEY,signer_first TEXT NOT NULL,signer_last TEXT NOT NULL,signed_at TIMESTAMPTZ NOT NULL,status TEXT NOT NULL DEFAULT 'OUT',returned_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()); INSERT INTO rental_agreements(signer_first,signer_last,signed_at) VALUES('Synthetic','Fixture',NOW())");}
 const counts={reads:0,connections:0};const ensure=load(pool,counts);await Promise.all([ensure(),ensure()]);assert.equal(counts.connections,1);
 const rows=await pool.query('SELECT note,phone,waiver_id,template_id FROM rental_agreements');assert.equal(rows.rowCount,name==='qa_legacy'?1:0);
 const fast={reads:0,connections:0};await load(pool,fast)();assert.deepEqual(fast,{reads:1,connections:0});
 console.log(JSON.stringify({scenario:name,initialization:'PASS',readyFastPath:'one metadata query; zero DDL connections',preservedRows:rows.rowCount}));
 }finally{await pool.end();}}
}finally{await admin.end();}})().catch(error=>{console.error(error);process.exitCode=1;});

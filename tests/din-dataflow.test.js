const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const RentalData = require('../rental-data');
const { normalizeIntake } = require('../lib/intake-normalize');
const fixture = require('./fixtures/intake.json');
const html = fs.readFileSync(require('node:path').join(__dirname,'../tech.html'),'utf8');
const chart = html.slice(html.indexOf('    const CODE_BY_WEIGHT='),html.indexOf('    const dinModal='));
const context={RentalData, normalizeSkierType:v=>['I','II','III'].includes(v)?v:''};
vm.createContext(context);vm.runInContext(chart,context);
const complete={weight_lb:180,height_in:71,age_years:40,skierType:'III',bsl_mm:315,basis:'weight',ageAdj:'auto'};
test('null, blank and booleans never become a numeric zero',()=>{
  for(const v of [null,undefined,'','  ',false,true]) assert.equal(RentalData.finiteNumber(v),null);
  assert.equal(RentalData.finiteNumber(0),0);
});
test('selected waiver and participant must match exactly without p0 fallback',()=>{
  const data=normalizeIntake(fixture,new Date('2026-10-02T00:00:00Z'));
  assert.equal(RentalData.pickParticipant(data,1,fixture.waiverId).first_name,'Child');
  assert.throws(()=>RentalData.pickParticipant(data,2,fixture.waiverId));
  assert.throws(()=>RentalData.pickParticipant(data,0,'different_waiver'));
  assert.throws(()=>RentalData.pickParticipant({...data,participants:[data.participants[0],data.participants[0]]},0,fixture.waiverId));
});
test('every required measurement, skier selection and measured BSL gates the existing chart',()=>{
  assert.ok(context.computeDIN(complete).din>0);
  for(const field of ['weight_lb','height_in','age_years','skierType','bsl_mm']) for(const value of [null,undefined,'']) {
    assert.equal(context.computeDIN({...complete,[field]:value}).din,null,`${field}: ${value}`);
  }
  for(const value of [0,199,421,300.5]) assert.equal(context.computeDIN({...complete,bsl_mm:value}).din,null);
});
test('DOB/custom-field data reaches existing chart without modifying its table or arithmetic',()=>{
  const p=normalizeIntake(fixture,new Date('2026-10-02T00:00:00Z')).participants[0];
  assert.equal(context.computeDIN({...complete,weight_lb:p.weight_lb,height_in:p.height_in,age_years:p.age,skierType:p.skier_type}).din,8.5);
});
test('dialog no longer defaults missing skier type, prior BSL, or stale async selection',()=>{
  assert.match(html,/inpType\(\)\.value = current\.skier_type \|\| ""/);
  assert.doesNotMatch(html,/inpBSL\(\)\.value = prior\.bsl_mm/);
  assert.match(html,/if \(requestId !== dinRequestId\) return/);
  assert.match(html,/dinClose\.addEventListener\("click", closeDINModal\)/);
  assert.match(html,/function closeDINModal\(\)\{\s*dinRequestId\+\+/);
});

test('skier dropdown order is placeholder, I, II, III',()=>{
  const options=html.match(/<select id="inp_type"[\s\S]*?<\/select>/)[0];
  assert.deepEqual([...options.matchAll(/<option value="([^"]*)"[^>]*>([^<]+)<\/option>/g)].map(m=>[m[1],m[2]]),[['','Select skier type'],['I','Type I'],['II','Type II'],['III','Type III']]);
});
test('check-one intake selection reaches the calculator preselection without a fallback',()=>{
  const data=normalizeIntake({waiverId:'synthetic_choice',email:'example@example.invalid',participants:[{dob:'1990-01-01',customParticipantFields:{a:{displayText:'Skier Type: (Check One)',value:['II']}}}]},new Date('2026-10-02T00:00:00Z'));
  const participant=RentalData.pickParticipant(data,0,'synthetic_choice');
  assert.equal(participant.skier_type,'II');
  assert.match(html,/inpType\(\)\.value = current\.skier_type \|\| ""/);
});

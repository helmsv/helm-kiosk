const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLiabilityPrefill } = require('../lib/waiver-prefill');
const { normalizeIntake } = require('../lib/intake-normalize');
const { TEXT_TEMPLATE_ID, ORIGINAL_TEMPLATE_ID, liabilityHistoryTemplateIds } = require('../lib/rental-templates');
const { dates, finals, dropdowns } = require('./fixtures/rental-technical-fields');
// Independent observed metadata fixture, not generated from the implementation.
const references = [
  ['6PxH3icvZdRpLvuN76oVzZ', 'Calculated Skier Code (reference)'],
  ['fQiBCMVsnR6FKaZ3WwKWRt', 'Calculated Initial Indicator Value (single DIN)'],
  ['soPjWoAx9poFLyTFXDqtDN', 'Measured Boot Sole Length (mm)'],
  ['8TNbfYgNWRxEwm1A8Njkkk', 'Boot Sole Length Range (mm, calculated)'],
].map(([guid, label]) => ({ guid, label, fieldType: 'textbox', type: 'string' }));
const template = () => ({ templateId: TEXT_TEMPLATE_ID, publishedVersion: 1620048, title: 'Helm of Sun Valley - Rental Agreement (Text Based)', participantCustomFields: structuredClone([...references, ...finals]), customFields: structuredClone(dates) });
const person = (firstName = 'SnowOS', minor = false) => ({ firstName, lastName: 'Unsigned Test', dob: minor ? '2015-01-01' : '1990-01-01', isMinor: minor, customParticipantFields: { w: { displayText: 'Weight (lbs)', value: '180' }, h: { displayText: 'Height (in)', value: '71' }, s: { displayText: 'Skier Type', value: 'II' } } });
const waiver = () => ({ waiverId: 'synthetic_text_rental', email: 'snowos-unsigned-test@example.invalid', participants: [person()] });
function review(w, index = 0, withFinals = true) {
  const p = normalizeIntake(w).participants[index];
  return { reviewed: true, waiverId: w.waiverId, participantIndex: index, participant: { first_name: p.first_name, last_name: p.last_name }, source: { weight_lb: p.weight_lb, height_in: p.height_in, age: p.age, skier_type: p.skier_type }, calculated: { skierCode: 'M', din: '7', bootSoleLengthMm: 315 }, ...(withFinals ? { finalSettings: { leftToe: '6.25', leftHeel: '6.50', rightToe: '5.75', rightHeel: '6.00' } } : {}) };
}
const at = { now: new Date('2026-10-14T06:59:59Z') };
test('text agreement copies eight independent reviewed strings, Pacific dates, identity and source linkage', () => {
  const w = waiver(), t = template(), r = review(w), before = JSON.stringify({ w, t, r });
  const out = buildLiabilityPrefill(w, {}, t, 0, r, at);
  const fields = out.payload.participants[0].customFields;
  assert.deepEqual([...references, ...finals].map(f => fields[f.guid]), ['M', '7', '315', '311-330', '6.25', '6.50', '5.75', '6.00']);
  assert.equal(Object.keys(fields).length, 8);
  assert.deepEqual(out.payload.customWaiverFields, { [dates[0].guid]: '2026-10-13', [dates[1].guid]: '2027-05-16' });
  assert.deepEqual(out.manualFields, []);
  assert.equal(out.payload.externalId, 'intake_synthetic_text_rental_0');
  assert.equal(out.payload.participants[0].dob, '1990-01-01');
  assert.equal(out.payload.email, w.email);
  assert.equal(out.payload.lockdownPrefill, false);
  assert.equal(JSON.stringify({ w, t, r }), before);
  for (const f of dropdowns) assert.equal(Object.hasOwn(fields, f.guid), false);
});
test('text BSL bins preserve every inclusive boundary and exact measurement without Unicode', () => {
  for (const [mm, expected] of [[200,'230 or less'],[230,'230 or less'],[231,'231-250'],[250,'231-250'],[251,'251-270'],[270,'251-270'],[271,'271-290'],[290,'271-290'],[291,'291-310'],[310,'291-310'],[311,'311-330'],[330,'311-330'],[331,'331-350'],[350,'331-350'],[351,'351 or more'],[420,'351 or more']]) {
    const w = waiver(), r = review(w, 0, false); r.calculated.bootSoleLengthMm = mm;
    const fields = buildLiabilityPrefill(w, {}, template(), 0, r, at).payload.participants[0].customFields;
    assert.equal(fields[references[2].guid], String(mm));
    assert.equal(fields[references[3].guid], expected);
    for (const f of finals) assert.equal(Object.hasOwn(fields, f.guid), false);
  }
  for (const mm of [199,421,315.5,'bad']) {
    const w = waiver(), r = review(w); r.calculated.bootSoleLengthMm = mm;
    assert.throws(() => buildLiabilityPrefill(w, {}, template(), 0, r, at), { code: 'TECHNICIAN_VALUE_INVALID' });
  }
});
test('text field metadata changes fail closed, including wrong GUID/scope/type or duplicate labels', () => {
  for (const mutate of [
    t => { t.participantCustomFields[0].guid = 'wrong'; },
    t => { t.customFields.push(t.participantCustomFields.shift()); },
    t => { t.participantCustomFields[1].type = 'enum'; t.participantCustomFields[1].fieldType = 'optionlist'; },
    t => { t.participantCustomFields[2].label = 'Different'; },
    t => { t.participantCustomFields.push({ ...t.participantCustomFields[3], guid: 'duplicate' }); },
  ]) {
    const w = waiver(), t = template(); mutate(t);
    assert.throws(() => buildLiabilityPrefill(w, {}, t, 0, review(w), at), e => e.statusCode === 400);
  }
});
test('stale intake reference/final/date values and absent standard fields cannot leak into the new agreement', () => {
  const w = waiver(), t = template();
  const source = { customParticipantFields: structuredClone([...references, ...finals]), customFields: structuredClone(dates) };
  for (const f of [...references, ...finals]) w.participants[0].customParticipantFields[f.guid] = { value: '999', displayText: f.label };
  w.customWaiverFields = Object.fromEntries(dates.map(f => [f.guid, { value: '2020-01-01', displayText: f.label }]));
  w.addressLineOne = 'Must not copy'; w.participants[0].phone = '5551234567';
  const out = buildLiabilityPrefill(w, source, t, 0, undefined, at);
  assert.equal(out.payload.participants[0].customFields, undefined);
  assert.equal(out.payload.participants[0].phone, undefined);
  assert.equal(out.payload.addressLineOne, undefined);
  assert.equal(out.payload.customWaiverFields[dates[0].guid], '2026-10-13');
});
test('only selected family member receives text values, including a participating guardian', () => {
  const w = waiver(); w.participants.push(person('Child', true));
  for (const index of [0, 1]) {
    const payload = buildLiabilityPrefill(w, {}, template(), index, review(w, index), at).payload;
    assert.equal(payload.guardian.participant, true);
    const selected = index === 0 ? payload.guardian : payload.participants[0];
    const other = index === 0 ? payload.participants[0] : payload.guardian;
    assert.equal(selected.customFields[references[1].guid], '7');
    assert.equal(other.customFields, undefined);
  }
});
const response = () => ({ headers: {}, statusCode: 200, setHeader(k,v) { this.headers[k]=v; }, status(s) { this.statusCode=s; return this; }, json(body) { this.body=body; return this; } });
test('configured text synthetic handler reports all eight fields, authenticates twice, never reads signed records', async () => {
  const oldFetch = global.fetch, oldEnv = { ...process.env }; const calls = [], posts = [];
  process.env.LIABILITY_WAIVER_ID = TEXT_TEMPLATE_ID; process.env.INTAKE_WAIVER_ID = 'synthetic_intake'; process.env.SW_API_KEY = 'synthetic_key';
  delete require.cache[require.resolve('../api/waiver-prefill')];
  global.fetch = async (raw, options = {}) => {
    const url = new URL(raw); calls.push(url.pathname);
    if (url.pathname === '/api/rentals/authorize') return { ok: true, json: async () => ({ authorized: true }) };
    if (url.pathname.endsWith('/prefill')) {
      assert.equal(url.pathname, `/v4/templates/${TEXT_TEMPLATE_ID}/prefill`);
      posts.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ prefill: { uuid: 'synthetic_token', url: 'https://waiver.smartwaiver.com/p/synthetic_token/' } }) };
    }
    assert.ok(url.pathname.includes('/templates/'), 'No signed record reads');
    return { ok: true, json: async () => ({ template: url.pathname.endsWith(TEXT_TEMPLATE_ID) ? template() : { templateId: 'synthetic_intake', customParticipantFields: [] } }) };
  };
  try {
    const out = response();
    await require('../api/waiver-prefill')({ method:'POST', headers: { host:'kiosk.example', origin:'https://kiosk.example', authorization:'Bearer synthetic.staff.session', 'content-type':'application/json' }, body:{ stage:'synthetic-preview', templateId:ORIGINAL_TEMPLATE_ID } }, out);
    assert.equal(out.statusCode, 200, out.body.error);
    assert.deepEqual(out.body.technicalFields.map(f => f.value), ['M','7','315','311-330','6.25','6.50','5.75','6.00']);
    assert.deepEqual(out.body.manualFields, []);
    assert.equal(posts.length, 1);
    assert.equal(calls.filter(path => path === '/api/rentals/authorize').length, 2);
  } finally { global.fetch = oldFetch; process.env = oldEnv; }
});
test('historical template set retains original and new agreements across switch/rollback without including unrelated templates', () => {
  assert.deepEqual(liabilityHistoryTemplateIds(TEXT_TEMPLATE_ID), [TEXT_TEMPLATE_ID, ORIGINAL_TEMPLATE_ID]);
  assert.deepEqual(liabilityHistoryTemplateIds(ORIGINAL_TEMPLATE_ID), [ORIGINAL_TEMPLATE_ID, TEXT_TEMPLATE_ID]);
  assert.deepEqual(liabilityHistoryTemplateIds('unrelated'), ['unrelated']);
  assert.deepEqual(liabilityHistoryTemplateIds(''), []);
});
test('signed agreement reads retain original reconciliation tags and select latest across both templates', async () => {
  const oldFetch = global.fetch, oldEnv = { ...process.env }; process.env.LIABILITY_WAIVER_ID = TEXT_TEMPLATE_ID; process.env.SW_API_KEY = 'synthetic_key';
  const calls = []; let allowed = true;
  global.fetch = async raw => {
    const url = new URL(raw);
    if (url.pathname === '/api/rentals/authorize') return { ok:allowed, status:403, json:async () => ({ authorized:allowed }) };
    calls.push(url.searchParams.get('templateId'));
    const id = url.searchParams.get('templateId');
    return { ok:true, json:async () => ({ waivers:[{ waiverId: id === ORIGINAL_TEMPLATE_ID ? 'old_signed' : 'new_signed', templateId:id, createdOn:id === ORIGINAL_TEMPLATE_ID ? '2026-10-13T10:00:00Z' : '2026-10-14T10:00:00Z', autoTag:'intake_synthetic_text_rental_0' }, { waiverId:'unrelated', templateId:'other' }] }) };
  };
  try {
    const req = { headers:{ authorization:'Bearer synthetic.staff.session' }, query:{ email:'snowos-unsigned-test@example.invalid' } };
    let out = response(); await require('../api/open-liabilities')(req,out);
    assert.equal(out.statusCode,200); assert.deepEqual(out.body.rows.map(r => r.waiverId), ['new_signed','old_signed']);
    assert.equal(out.body.rows[1].autoTag,'intake_synthetic_text_rental_0');
    assert.deepEqual(calls,[TEXT_TEMPLATE_ID,ORIGINAL_TEMPLATE_ID]);
    out=response(); await require('../api/liability-latest')(req,out); assert.equal(out.body.row.waiverId,'new_signed');
    allowed=false; calls.length=0;
    for (const route of ['open-liabilities','liability-latest']) { out=response(); await require('../api/'+route)(req,out); assert.equal(out.statusCode,403); }
    assert.deepEqual(calls,[]);
  } finally { global.fetch=oldFetch; process.env=oldEnv; }
});

test('webhook ingestion accepts original and text rentals, rejects unrelated or missing template IDs', async () => {
  const oldEnv={...process.env},oldFetch=global.fetch;
  const dbPath=require.resolve('../api/_db'),schemaPath=require.resolve('../api/_ensureSchema');
  const oldDb=require.cache[dbPath],oldSchema=require.cache[schemaPath];
  const queries=[];
  require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{getPool:()=>({query:async(sql,args)=>{queries.push(args);assert.match(sql,/WHEN rental_agreements.status = \$8 THEN \$8/);return {rows:[{id:1,status:'OUT'}]};}})}};
  require.cache[schemaPath]={id:schemaPath,filename:schemaPath,loaded:true,exports:{ensureSchema:async()=>{}}};
  process.env.LIABILITY_WAIVER_ID=TEXT_TEMPLATE_ID;process.env.SW_API_KEY='synthetic_key';delete process.env.UPSTASH_REDIS_REST_URL;delete process.env.UPSTASH_REDIS_REST_TOKEN;
  let templateId=TEXT_TEMPLATE_ID;
  global.fetch=async raw=>{assert.equal(new URL(raw).pathname,'/v4/waivers/synthetic_signed');return {ok:true,json:async()=>({waiver:{waiverId:'synthetic_signed',templateId,firstName:'Fictional',lastName:'Example',createdOn:'2026-10-14T10:00:00Z'}})};};
  delete require.cache[require.resolve('../api/sw-webhook')];
  try{
    const handler=require('../api/sw-webhook');
    for(const id of [TEXT_TEMPLATE_ID,ORIGINAL_TEMPLATE_ID,'other',undefined]){
      templateId=id;const out=response();out.send=function(body){this.body=body;return this;};
      await handler({method:'POST',body:{unique_id:'synthetic_signed'}},out);assert.equal(out.statusCode,200);
    }
    assert.deepEqual(queries.map(args=>args[1]),[TEXT_TEMPLATE_ID,ORIGINAL_TEMPLATE_ID]);
    for(const args of queries)assert.equal(args[7],'RETURNED');
  }finally{
    global.fetch=oldFetch;process.env=oldEnv;
    if(oldDb)require.cache[dbPath]=oldDb;else delete require.cache[dbPath];
    if(oldSchema)require.cache[schemaPath]=oldSchema;else delete require.cache[schemaPath];
    delete require.cache[require.resolve('../api/sw-webhook')];
  }
});

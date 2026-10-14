const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
require('./fixtures/technician-enum-contract')(['synthetic_final_template']);
const RentalData = require('../rental-data');
const { normalizeIntake } = require('../lib/intake-normalize');
const { buildTechnicianPrefill } = require('../lib/technician-prefill');

const html = fs.readFileSync(path.join(__dirname, '../tech.html'), 'utf8');
const reviewButtonSource = html.slice(html.indexOf('    const FINAL_SETTING_INPUTS='), html.indexOf('    const blankLiabilityWarning'));
const calculatorSource = reviewButtonSource + html.slice(html.indexOf('    const CODE_BY_WEIGHT='), html.indexOf("    document.getElementById('checkWaiverFields')"));
const template = { templateId: 'synthetic_final_template', publishedVersion: 1, customParticipantFields: [
  { guid: 'synthetic_code', label: 'Skier Code', fieldType: 'textbox', type: 'string' },
  { guid: 'synthetic_din', label: 'DIN', fieldType: 'optionlist', type: 'enum' },
  { guid: 'synthetic_bsl', label: 'Boot Sole Length (mm)', fieldType: 'numerictextbox', type: 'number' },
] };

function signedIntake(type = '') {
  return { waiverId: 'synthetic_manual_skier', templateId: 'synthetic_intake_template', email: 'synthetic@example.invalid', participants: [
    { firstName: 'Synthetic', lastName: 'Review', dob: '1990-01-01', isMinor: false, customParticipantFields: {
      weight: { displayText: 'Weight (lbs)', value: '174' },
      height: { displayText: 'Height (in)', value: '71' },
      ...(type ? { type: { displayText: 'Skier Type: (Check One)', value: type } } : {}),
    } },
  ] };
}
function reviewed(w, calculatedType = 'II') {
  const p = normalizeIntake(w).participants[0];
  return { reviewed: true, waiverId: w.waiverId, participantIndex: 0,
    participant: { first_name: p.first_name, last_name: p.last_name },
    source: { weight_lb: p.weight_lb, height_in: p.height_in, age: p.age, skier_type: p.skier_type },
    calculated: { skierCode: 'L', din: 6, bootSoleLengthMm: 315, skierType: calculatedType },
  };
}
function assertRejected(w, review, code = 'TECHNICIAN_VALUE_INVALID') {
  assert.throws(() => buildTechnicianPrefill(w, template, 0, review), error => error.statusCode === 400 && error.code === code);
}

// Execute the actual calculator UI/listeners, with a tiny DOM and no network.
function calculatorHarness(w) {
  const nodes = new Map(), submitted = [], notices = [], clipboard = [];
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, disabled: false, textContent: '', listeners: new Map(), addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(callback);
    } });
    return nodes.get(id);
  }
  const context = {
    navigator:{clipboard:{writeText:async value=>clipboard.push(value)}},
    openingDrafts: new Set(), rowKey: (id, index) => `${id}:${index}`,
    RentalData, document: { getElementById: node },
    RentalDialog: { create: () => ({ show() {}, hide() {} }) },
    normalizeSkierType: value => ['I', 'II', 'III'].includes(value) ? value : '',
    displaySkier: value => value || '—', finNum: RentalData.finiteNumber,
    showToast: value => notices.push(value),
    openLiabilityDraft: async (selection, button, review) => submitted.push(JSON.parse(JSON.stringify({ selection, review }))),
  };
  vm.createContext(context); vm.runInContext(calculatorSource, context);
  const p = normalizeIntake(w).participants[0];
  context.openDINModal({ ...p, waiver_id: w.waiverId }, {});
  async function dispatch(id, type) {
    const target = node(id);
    for (const callback of target.listeners.get(type) || []) await callback({ target, currentTarget: target });
  }
  async function set(id, value) { node(id).value = value; await dispatch(id, 'input'); }
  async function approve() { node('reviewTechnician').checked = true; await dispatch('reviewTechnician', 'change'); }
  return { node, context, submitted, notices, clipboard, dispatch, set, approve };
}

test('manual type selection crosses the actual calculator-to-builder boundary while blank source remains bound', async () => {
  const w = signedIntake(), before = JSON.stringify(w), h = calculatorHarness(w);
  assert.equal(h.node('inp_type').value, '');
  await h.set('inp_bsl', '315');
  assert.equal(h.node('btnOpenLiab').disabled, true, 'measured BSL alone cannot supply a skier type');
  await h.set('inp_type', 'II');
  assert.equal(h.node('out_din').textContent, '6.00');
  assert.equal(h.node('skierTypeReviewNotice').hidden, false);
  assert.match(h.node('skierTypeReviewNotice').textContent, /intake has no mapped skier type/);
  assert.match(h.node('skierTypeReviewNotice').textContent, /including any skier-type answer if present/);
  await h.approve(); await h.dispatch('btnOpenLiab', 'click');
  assert.equal(h.submitted.length, 1);
  const { review } = h.submitted[0];
  assert.equal(review.source.skier_type, '', 'manual correction never rewrites the original source snapshot');
  assert.equal(review.calculated.skierType, 'II');
  assert.equal(review.calculated.skierCode, 'L');
  assert.equal(review.calculated.din, 6);
  const draft = buildTechnicianPrefill(w, template, 0, review);
  assert.deepEqual({ ...draft.participantFields }, { synthetic_code: 'L', synthetic_din: '6', synthetic_bsl: '315' });
  assert.match(draft.skippedFields[0], /confirm classification and review final-waiver details/);
  assert.equal(JSON.stringify(w), before, 'signed intake must not change');
  assert.match(html, /I reviewed this participant, the selected skier type,/);
});

test('changing each calculator input resets explicit review and captures the new selected type', async () => {
  const h = calculatorHarness(signedIntake());
  await h.set('inp_bsl', '315'); await h.set('inp_type', 'II');
  for (const [id, value] of [['inp_type', 'III'], ['inp_bsl', '320'], ['inp_basis', 'height'], ['inp_ageAdj', 'minus1']]) {
    await h.approve(); assert.equal(h.node('btnOpenLiab').disabled, false);
    await h.set(id, value);
    assert.equal(h.node('reviewTechnician').checked, false, `${id} invalidates approval`);
    assert.equal(h.node('btnOpenLiab').disabled, true, `${id} disables transfer`);
    const count = h.submitted.length;
    await h.dispatch('btnOpenLiab', 'click');
    assert.equal(h.submitted.length, count, 'even a programmatic click cannot transfer unreviewed changes');
  }
  await h.approve(); await h.dispatch('btnOpenLiab', 'click');
  assert.equal(h.submitted.at(-1).review.calculated.skierType, 'III');
  assert.equal(h.submitted.at(-1).review.source.skier_type, '');
  await h.set('inp_type', '');
  await h.approve(); await h.dispatch('btnOpenLiab', 'click');
  assert.equal(h.node('btnOpenLiab').disabled, true);
  assert.equal(h.submitted.length, 1, 'blank selection never defaults to II');
  assert.equal(h.node('skierTypeReviewNotice').hidden, true);
});

test('explicit correction of populated type warns to confirm classification and any final type answer if present', async () => {
  const w = signedIntake('I'), h = calculatorHarness(w);
  await h.set('inp_bsl', '315'); await h.set('inp_type', 'II');
  assert.equal(h.node('skierTypeReviewNotice').hidden, false);
  assert.match(h.node('skierTypeReviewNotice').textContent, /selected skier type differs from the intake/);
  assert.match(h.node('skierTypeReviewNotice').textContent, /including any skier-type answer if present/);
  await h.approve(); await h.dispatch('btnOpenLiab', 'click');
  const result = buildTechnicianPrefill(w, template, 0, h.submitted[0].review);
  assert.match(result.skippedFields[0], /confirm classification and review final-waiver details/);
  assert.equal(w.participants[0].customParticipantFields.type.value, 'I');
  assert.equal(Object.keys(result.participantFields).length, 3, 'no new skier-type destination is invented');
  await h.set('inp_type', 'I');
  assert.equal(h.node('skierTypeReviewNotice').hidden, true);
});

test('explicit invalid selections never fall back; older clients require a valid fresh source type', () => {
  for (const sourceType of ['', 'II']) {
    const w = signedIntake(sourceType);
    for (const explicit of ['', ' ', undefined, null, false, true, 'IV', 'ii', 2, ['II'], {}]) {
      const r = reviewed(w); r.calculated.skierType = explicit;
      assertRejected(w, r);
    }
    const legacy = reviewed(w); delete legacy.calculated.skierType;
    if (sourceType) assert.equal(buildTechnicianPrefill(w, template, 0, legacy).participantFields.synthetic_din, '6');
    else assertRejected(w, legacy);
  }
  const w = signedIntake('I'), r = reviewed(w, 'III'), before = JSON.stringify(w);
  assert.equal(buildTechnicianPrefill(w, template, 0, r).participantFields.synthetic_din, '6');
  assert.equal(r.source.skier_type, 'I', 'explicit reviewed correction does not forge its source');
  assert.equal(JSON.stringify(w), before);
});

test('manual skier selection cannot bypass source, review, identity, measurements or measured-BSL checks', () => {
  const w = signedIntake();
  const changedSource = reviewed(w); changedSource.source.skier_type = 'II';
  assertRejected(w, changedSource, 'TECHNICIAN_SOURCE_STALE');
  const stale = reviewed(w), changedWaiver = signedIntake('I');
  assertRejected(changedWaiver, stale, 'TECHNICIAN_SOURCE_STALE');
  const unreviewed = reviewed(w); unreviewed.reviewed = false;
  assertRejected(w, unreviewed, 'TECHNICIAN_REVIEW_REQUIRED');
  const wrongPerson = reviewed(w); wrongPerson.participantIndex = 1;
  assertRejected(w, wrongPerson, 'TECHNICIAN_SELECTION_STALE');
  for (const missing of ['weight', 'height', 'age']) {
    const incomplete = signedIntake();
    if (missing === 'age') delete incomplete.participants[0].dob;
    else delete incomplete.participants[0].customParticipantFields[missing];
    assertRejected(incomplete, reviewed(incomplete));
  }
  for (const bsl of [null, '', 0, 199, 421, 315.5]) {
    const r = reviewed(w); r.calculated.bootSoleLengthMm = bsl; assertRejected(w, r);
  }
});

test('authenticated API accepts the reviewed missing-source correction and rejects bypasses before any prefill POST', async () => {
  const sw = require('../lib/smartwaiver');
  const oldRequest = sw.request, oldFetch = global.fetch;
  const envKeys = ['INTAKE_WAIVER_ID', 'LIABILITY_WAIVER_ID'];
  const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.INTAKE_WAIVER_ID = 'synthetic_intake_template'; process.env.LIABILITY_WAIVER_ID = template.templateId;
  let w = signedIntake(), authChecks = 0;
  const posts = [], requests = [];
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://helm-snowos.vercel.app/api/rentals/authorize');
    assert.equal(options.headers.Authorization, 'Bearer staff.synthetic.jwt');
    authChecks++;
    return { ok: true, json: async () => ({ authorized: true }) };
  };
  sw.request = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === `/waivers/${w.waiverId}`) return { waiver: w };
    if (url === '/templates/synthetic_intake_template?customFields=true') return { template: { templateId: 'synthetic_intake_template', customParticipantFields: [] } };
    if (url === `/templates/${template.templateId}?customFields=true`) return { template };
    if (url === `/templates/${template.templateId}/prefill`) {
      assert.equal(options.method, 'POST'); posts.push(options.body);
      return { prefill: { uuid: 'synthetic_review_draft', url: 'https://waiver.smartwaiver.com/p/synthetic_review_draft/' } };
    }
    assert.fail(`Unexpected mocked request: ${url}`);
  };
  delete require.cache[require.resolve('../api/waiver-prefill')];
  const handler = require('../api/waiver-prefill');
  async function send(review, authorized = true) {
    const req = { method: 'POST', headers: { host: 'kiosk.example', origin: 'https://kiosk.example', 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer staff.synthetic.jwt' } : {}) }, body: { stage: 'liability', waiverId: w.waiverId, participantIndex: 0, technicianReview: review } };
    const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    await handler(req, res); return res;
  }
  try {
    const before = JSON.stringify(w), h = calculatorHarness(w);
    await h.set('inp_bsl', '315'); await h.set('inp_type', 'II'); await h.approve(); await h.dispatch('btnOpenLiab', 'click');
    const good = h.submitted[0].review;
    const success = await send(good);
    assert.equal(success.statusCode, 200);
    assert.equal(authChecks, 2, 'staff is checked before source reads and again before the unsigned draft POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].participants[0].customFields.synthetic_din, '6');
    assert.equal(posts[0].participants[0].customFields.synthetic_code, 'L');
    assert.equal(posts[0].participants[0].customFields.synthetic_bsl, '315');
    assert.equal(posts[0].lockdownPrefill, false);
    assert.equal(JSON.stringify(w), before);
    for (const mutate of [
      r => { delete r.calculated.skierType; },
      r => { r.calculated.skierType = ''; },
      r => { r.calculated.skierType = 'IV'; },
      r => { r.source.skier_type = 'II'; },
      r => { r.calculated.bootSoleLengthMm = 0; },
      r => { r.reviewed = false; },
    ]) {
      const bad = structuredClone(good); mutate(bad);
      const rejected = await send(bad);
      assert.equal(rejected.statusCode, 400);
      assert.equal(posts.length, 1, 'invalid review must not create a draft');
    }
    const count = requests.length;
    assert.equal((await send(good, false)).statusCode, 401);
    assert.equal(requests.length, count, 'no staff session means no signed-waiver or template reads');
    w = signedIntake('II'); const legacy = reviewed(w); delete legacy.calculated.skierType;
    assert.equal((await send(legacy)).statusCode, 200);
    assert.equal(posts.length, 2);
    assert.ok(requests.every(({ url, options }) => !url.startsWith('/waivers/') || !options.method || options.method === 'GET'));
  } finally {
    sw.request = oldRequest; global.fetch = oldFetch;
    for (const key of envKeys) if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key];
    delete require.cache[require.resolve('../api/waiver-prefill')];
  }
});

// Display labels match the eight existing table columns; no table values change.
test('BSL display includes both outer ranges and every interval boundary', () => {
  const h = calculatorHarness(signedIntake('II'));
  for (const [bsl, band] of [[230,'≤230'],[231,'231–250'],[250,'231–250'],[251,'251–270'],[270,'251–270'],[271,'271–290'],[290,'271–290'],[291,'291–310'],[310,'291–310'],[311,'311–330'],[330,'311–330'],[331,'331–350'],[350,'331–350'],[351,'≥351'],[420,'≥351']]) {
    assert.equal(h.context.computeDIN({weight_lb:174,height_in:71,age_years:36,skierType:'II',bsl_mm:bsl}).band, band);
  }
});

const finalInputIds = ['inp_final_left_toe','inp_final_left_heel','inp_final_right_toe','inp_final_right_heel'];
const unequalFinals = { leftToe:'5.50',leftHeel:'6.00',rightToe:'5.75',rightHeel:'6.25' };
const finalTemplate = {...template,customParticipantFields:[...template.customParticipantFields,
  ...Object.entries({leftToe:'Left Toe',leftHeel:'Left Heel',rightToe:'Right Toe',rightHeel:'Right Heel'}).map(([key,label])=>({guid:`synthetic_${key}`,label:`Final Indicator Setting: ${label}`,fieldType:'numerictextbox',type:'number'}))
]};
test('real calculator UI keeps finals blank and omits them until explicitly entered and reviewed',async()=>{
  const h=calculatorHarness(signedIntake('II'));
  await h.set('inp_bsl','315');
  assert.deepEqual(finalInputIds.map(id=>h.node(id).value),['','','','']);
  await h.approve();await h.dispatch('btnCopy','click');await h.dispatch('btnOpenLiab','click');
  assert.equal(h.submitted[0].review.finalSettings,undefined);
  assert.match(h.clipboard[0],/Calculated DIN 6.00/);assert.match(h.clipboard[0],/Final indicator settings not entered/);assert.doesNotMatch(h.clipboard[0],/L Toe/);
  const output=buildTechnicianPrefill(signedIntake('II'),finalTemplate,0,h.submitted[0].review);
  for(const key of Object.keys(unequalFinals))assert.equal(output.participantFields[`synthetic_${key}`],undefined);
});
test('unequal explicit finals survive actual UI review and builder without rounding or DIN defaults',async()=>{
  const w=signedIntake('II'),h=calculatorHarness(w);await h.set('inp_bsl','315');
  for(const [index,value] of Object.values(unequalFinals).entries())await h.set(finalInputIds[index],value);
  assert.equal(h.node('btnOpenLiab').disabled,true);await h.approve();await h.dispatch('btnOpenLiab','click');
  const review=h.submitted[0].review;assert.deepEqual(review.finalSettings,unequalFinals);assert.equal(review.calculated.din,6);
  const output=buildTechnicianPrefill(w,finalTemplate,0,review);
  for(const [key,value] of Object.entries(unequalFinals))assert.equal(output.participantFields[`synthetic_${key}`],value);
  await h.dispatch('btnCopy','click');assert.match(h.clipboard[0],/L Toe 5.50, L Heel 6.00, R Toe 5.75, R Heel 6.25/);
  for(const id of finalInputIds){await h.approve();await h.set(id,'6.10');assert.equal(h.node('reviewTechnician').checked,false);assert.equal(h.node('btnOpenLiab').disabled,true);assert.equal(h.node('btnCopy').disabled,true);}
  const person=normalizeIntake(w).participants[0];h.context.openDINModal({...person,waiver_id:w.waiverId},{});
  assert.deepEqual(finalInputIds.map(id=>h.node(id).value),['','','','']);
});
test('partial or malformed finals block even programmatic submit; clearing all restores optional path',async()=>{
  const h=calculatorHarness(signedIntake('II'));await h.set('inp_bsl','315');
  for(const invalid of ['','5,5','1e2','NaN','6 mm',' 6.00 ','6.','+6']){
    for(const [index,value] of Object.values(unequalFinals).entries())await h.set(finalInputIds[index],value);
    await h.set(finalInputIds[0],invalid);await h.approve();await h.dispatch('btnOpenLiab','click');await h.dispatch('btnCopy','click');
    assert.equal(h.node('btnOpenLiab').disabled,true);assert.equal(h.submitted.length,0);assert.equal(h.clipboard.length,0);
  }
  for(const id of finalInputIds)await h.set(id,'');await h.approve();await h.dispatch('btnOpenLiab','click');
  assert.equal(h.submitted.length,1);assert.equal(h.submitted[0].review.finalSettings,undefined);
});

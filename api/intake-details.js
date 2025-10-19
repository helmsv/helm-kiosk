// api/intake-details.js
// Robust Smartwaiver extraction + back-compat "intake" shape for the DIN page.

const SW_BASE = process.env.SW_BASE || "https://api.smartwaiver.com";
const SW_KEY  = process.env.SW_API_KEY;

function bad(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

async function swGetJson(path) {
  const r = await fetch(`${SW_BASE}${path}`, {
    headers: { accept: "application/json", "x-api-key": SW_KEY },
    cache: "no-store",
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Smartwaiver ${path} failed: ${r.status} ${text || r.statusText}`);
  }
  return r.json();
}

const SKIER_TYPE_MAP = new Map([
  ["i","I"],["type i","I"],["1","I"],["beginner","I"],
  ["ii","II"],["type ii","II"],["2","II"],["intermediate","II"],
  ["iii","III"],["type iii","III"],["3","III"],["advanced","III"],["expert","III"],
]);
const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

function inchesFromHeight(raw) {
  if (raw == null) return null;
  const s = norm(raw).replace(/"/g,"").replace(/inches?/g,"in").replace(/feet?/g,"ft");
  let m;
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*ft(?:\s*(\d+(?:\.\d+)?)\s*in)?/))) {
    const ft = parseFloat(m[1]); const inch = m[2] ? parseFloat(m[2]) : 0;
    return Math.round(ft * 12 + inch);
  }
  if ((m = s.match(/^(\d+(?:\.\d+)?)[^\d]+(\d+(?:\.\d+)?)$/))) {
    return Math.round(parseFloat(m[1]) * 12 + parseFloat(m[2]));
  }
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*in$/))) return Math.round(parseFloat(m[1]));
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*cm$/))) return Math.round(parseFloat(m[1]) / 2.54);
  const n = parseFloat(s);
  if (Number.isFinite(n)) {
    if (n > 100) return Math.round(n / 2.54);
    if (n >= 30 && n <= 96) return Math.round(n);
  }
  return null;
}
function poundsFromWeight(raw) {
  if (raw == null) return null;
  const s = norm(raw).replace(/pounds?/g,"lb").replace(/lbs?/g,"lb").replace(/kilograms?|kgs?/g,"kg");
  let m;
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*lb$/))) return Math.round(parseFloat(m[1]));
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*kg$/))) return Math.round(parseFloat(m[1]) * 2.20462);
  const n = parseFloat(s);
  if (Number.isFinite(n)) return n < 70 ? Math.round(n * 2.20462) : Math.round(n);
  return null;
}
function skierTypeFrom(raw) {
  if (!raw) return "";
  const s = norm(raw);
  if (SKIER_TYPE_MAP.has(s)) return SKIER_TYPE_MAP.get(s);
  const m = s.match(/type\s*(i{1,3}|\d)/i);
  if (m) return skierTypeFrom(m[1]);
  return "";
}
function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob); if (isNaN(+d)) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const hadBd = (now.getMonth() > d.getMonth()) || (now.getMonth() === d.getMonth() && now.getDate() >= d.getDate());
  return hadBd ? age : age - 1;
}

// Build a flat index of all (label,value,participantIndex) pairs to tolerate template variance
function buildFieldIndex(root) {
  const bucket = [];
  const labelKeys = ["label","displayText","question","title","key","name","description","text"];
  const valueKeys = ["value","answer","selected","selection","text","response"];

  const walk = (obj, participantIndex = null) => {
    if (!obj || typeof obj !== "object") return;
    for (const lk of labelKeys) if (lk in obj) {
      for (const vk of valueKeys) if (vk in obj) {
        const v = obj[vk];
        if (v != null && v !== "") bucket.push({ label: norm(obj[lk]), value: String(v), participantIndex });
      }
    }
    const pIdx = Number.isInteger(obj?.participantIndex) ? obj.participantIndex : participantIndex;
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) v.forEach((it) => walk(it, pIdx));
      else if (v && typeof v === "object") walk(v, pIdx);
    }
  };
  walk(root);
  return bucket;
}
function pickForParticipant(bucket, idx, labelRegexes) {
  const byIdx = bucket.filter(b => b.participantIndex == null || b.participantIndex === idx);
  for (const re of labelRegexes) {
    const found = byIdx.find(b => re.test(b.label));
    if (found) return found.value;
  }
  return null;
}
function mapParticipant(p, idx, fieldBucket) {
  let height_in = inchesFromHeight(p.height_in ?? p.height ?? p.heightIn ?? null);
  let weight_lb = poundsFromWeight(p.weight_lb ?? p.weight ?? p.weightLb ?? null);
  let skier_type = skierTypeFrom(p.skier_type ?? p.skierType ?? p.type ?? "");

  if (height_in == null) {
    height_in = inchesFromHeight(pickForParticipant(fieldBucket, idx, [/height.*(ft|in|feet|inches|cm)/i, /^height$/i]));
  }
  if (weight_lb == null) {
    weight_lb = poundsFromWeight(pickForParticipant(fieldBucket, idx, [/weight.*(lb|kg|pounds?|kilograms?)/i, /^weight$/i]));
  }
  if (!skier_type) {
    skier_type = skierTypeFrom(pickForParticipant(fieldBucket, idx, [/skier.*type/i, /ability.*(level|type)/i]));
  }

  const age = p.age ?? ageFromDob(p.dob);

  return {
    participant_index: idx,
    first_name: p.firstName ?? p.first_name ?? "",
    last_name:  p.lastName ?? p.last_name ?? "",
    email:      p.email ?? "",
    dob:        p.dob ?? null,
    age,
    weight_lb:  weight_lb ?? null,
    height_in:  height_in ?? null,
    skier_type: skier_type ?? ""
  };
}

async function handle(req) {
  try {
    const { searchParams } = new URL(req.url);
    const waiverId = searchParams.get("waiverId") || searchParams.get("waiverID");
    if (!waiverId) return bad("Missing waiverId");

    const w = await swGetJson(`/v4/waivers/${encodeURIComponent(waiverId)}`);

    // Build once; tolerate any payload shape
    const fieldBucket = buildFieldIndex(w);

    // Participants array (Smartwaiver usually puts it on root as `participants`)
    const participants = (w?.participants || w?.participantList || []).map((p, i) =>
      mapParticipant(p, i, fieldBucket)
    );

    // Single-participant forms sometimes stash answers at top-level; patch them in
    if (participants.length === 1) {
      const only = participants[0];
      if (only.height_in == null) only.height_in = inchesFromHeight(pickForParticipant(fieldBucket, null, [/height/i]));
      if (only.weight_lb == null) only.weight_lb = poundsFromWeight(pickForParticipant(fieldBucket, null, [/weight/i]));
      if (!only.skier_type) only.skier_type = skierTypeFrom(pickForParticipant(fieldBucket, null, [/skier.*type/i]));
    }

    // Back-compat: the DIN page likely expects an `intake` object + shorthand at the root.
    const selected = participants[0] ?? {};
    const intake = {
      email:      w?.contact?.email || w?.email || selected.email || null,
      age:        selected.age ?? null,
      heightInches: selected.height_in ?? null,
      weightLbs:    selected.weight_lb ?? null,
      skierType:    selected.skier_type ?? "",
      // Common alternates some UIs check:
      height_in: selected.height_in ?? null,
      weight_lb: selected.weight_lb ?? null,
      skier_type: selected.skier_type ?? "",
    };

    const body = {
      waiver_id: waiverId,
      email: intake.email,
      participants,
      intake, // <= back-compat for existing UI
      // Also mirror the common root shorthands:
      heightInches: intake.heightInches,
      weightLbs: intake.weightLbs,
      skierType: intake.skierType,
    };

    return new Response(JSON.stringify(body, null, 2), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  } catch (err) {
    return bad(String(err), 500);
  }
}

export async function GET(req) { return handle(req); }

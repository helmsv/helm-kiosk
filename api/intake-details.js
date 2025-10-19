// api/intake-details.js
// Drop-in replacement: robust extraction of height, weight, skier type (+age & email)
// Works with App Router route handlers (Request) and can be adapted to pages/api easily.

const SW_BASE = process.env.SW_BASE || "https://api.smartwaiver.com";
const SW_KEY  = process.env.SW_API_KEY;

function bad(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function swGetJson(path) {
  const r = await fetch(`${SW_BASE}${path}`, {
    headers: {
      "accept": "application/json",
      "x-api-key": SW_KEY
    },
    cache: "no-store"
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Smartwaiver ${path} failed: ${r.status} ${text || r.statusText}`);
  }
  return r.json();
}

// ---------- helpers: label/answer extraction ----------
const SKIER_TYPE_MAP = new Map([
  ["i", "I"], ["type i", "I"], ["1", "I"], ["beginner", "I"],
  ["ii", "II"], ["type ii", "II"], ["2", "II"], ["intermediate", "II"],
  ["iii", "III"], ["type iii", "III"], ["3", "III"], ["advanced", "III"], ["expert", "III"]
]);

function norm(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}
function inchesFromHeight(raw) {
  if (raw == null) return null;
  const s = norm(raw).replace(/"/g, "").replace(/inches?/g, "in").replace(/feet?/g, "ft");
  // Patterns: "5ft 8in", "5'8", "5-8", "68 in", "172 cm", "5 8"
  let m;
  // X ft Y in
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*ft(?:\s*(\d+(?:\.\d+)?)\s*in)?/))) {
    const ft = parseFloat(m[1]);
    const inch = m[2] ? parseFloat(m[2]) : 0;
    return Math.round(ft * 12 + inch);
  }
  // 5'8 or 5-8 or 5 8
  if ((m = s.match(/^(\d+(?:\.\d+)?)[^\d]+(\d+(?:\.\d+)?)$/))) {
    return Math.round(parseFloat(m[1]) * 12 + parseFloat(m[2]));
  }
  // N in
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*in$/))) {
    return Math.round(parseFloat(m[1]));
  }
  // N cm
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*cm$/))) {
    return Math.round(parseFloat(m[1]) / 2.54);
  }
  // plain number: assume inches if 30–96, else cm if > 100
  const n = parseFloat(s);
  if (Number.isFinite(n)) {
    if (n > 100) return Math.round(n / 2.54);
    if (n >= 30 && n <= 96) return Math.round(n);
  }
  return null;
}
function poundsFromWeight(raw) {
  if (raw == null) return null;
  const s = norm(raw).replace(/pounds?/g, "lb").replace(/lbs?/g, "lb").replace(/kilograms?|kgs?/g, "kg");
  let m;
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*lb$/))) {
    return Math.round(parseFloat(m[1]));
  }
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*kg$/))) {
    return Math.round(parseFloat(m[1]) * 2.20462);
  }
  const n = parseFloat(s);
  if (Number.isFinite(n)) {
    // heuristics: kg if very small, lbs otherwise
    if (n < 70) return Math.round(n * 2.20462);
    return Math.round(n);
  }
  return null;
}
function skierTypeFrom(raw) {
  if (!raw) return "";
  const s = norm(raw);
  if (SKIER_TYPE_MAP.has(s)) return SKIER_TYPE_MAP.get(s);
  // strings like "Type II (Intermediate)"
  const m = s.match(/type\s*(i{1,3}|\d)/i);
  if (m) return skierTypeFrom(m[1]);
  return ""; // unknown
}
function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(+d)) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const hadBd = (now.getMonth() > d.getMonth()) ||
                (now.getMonth() === d.getMonth() && now.getDate() >= d.getDate());
  if (!hadBd) age -= 1;
  return age;
}

// Traverse arbitrary Smartwaiver answers; return best match for a participant.
// We look in per-participant custom fields first, then fallback to top-level (shared) answers.
function buildFieldIndex(waiverJson) {
  // Collect potential answers with label-ish text + participantIndex if present
  const bucket = [];
  function push(label, value, participantIndex = null) {
    if (value == null || value === "") return;
    bucket.push({ label: norm(label), value: String(value), participantIndex });
  }
  function walk(obj, participantIndex = null) {
    if (!obj || typeof obj !== "object") return;
    // Common shapes: { displayText, label, question, key, title } + { value, answer, selected }
    const labelKeys = ["label","displayText","question","title","key","name","description","text"];
    const valueKeys = ["value","answer","selected","selection","text","response"];
    // If object looks like an answer node, capture it
    for (const lk of labelKeys) {
      if (lk in obj) {
        for (const vk of valueKeys) {
          if (vk in obj) push(obj[lk], obj[vk], participantIndex);
        }
      }
    }
    // Participant index hints
    const pIdx = Number.isInteger(obj.participantIndex) ? obj.participantIndex : participantIndex;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (Array.isArray(v)) {
        v.forEach((it) => walk(it, pIdx));
      } else if (v && typeof v === "object") {
        walk(v, pIdx);
      }
    }
  }
  walk(waiverJson);
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
  // Try direct fields first (if Smartwaiver puts raw numbers on participant)
  let height_in = inchesFromHeight(p.height_in ?? p.height ?? p.heightIn ?? null);
  let weight_lb = poundsFromWeight(p.weight_lb ?? p.weight ?? p.weightLb ?? null);
  let skier_type = skierTypeFrom(p.skier_type ?? p.skierType ?? p.type ?? "");

  // Fill via custom fields (labels vary a lot between templates)
  if (height_in == null) {
    const rawH = pickForParticipant(
      fieldBucket,
      idx,
      [
        /height.*(ft|in|feet|inches|cm)/i,
        /^height$/i,
        /participant.*height/i
      ]
    );
    height_in = inchesFromHeight(rawH);
  }
  if (weight_lb == null) {
    const rawW = pickForParticipant(
      fieldBucket,
      idx,
      [
        /weight.*(lb|kg|pounds?|kilograms?)/i,
        /^weight$/i,
        /participant.*weight/i
      ]
    );
    weight_lb = poundsFromWeight(rawW);
  }
  if (!skier_type) {
    const rawT = pickForParticipant(
      fieldBucket,
      idx,
      [
        /skier.*type/i,
        /ability.*(level|type)/i,
        /^type\s*(i{1,3}|\d)$/i
      ]
    );
    skier_type = skierTypeFrom(rawT);
  }

  // Derive age from DOB if missing/needed
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

    // Fetch the waiver JSON
    const w = await swGetJson(`/v4/waivers/${encodeURIComponent(waiverId)}`);

    // Build a loose "field index" from the whole waiver payload once
    const fieldBucket = buildFieldIndex(w);

    // Basic header info
    const email =
      w?.contact?.email ||
      w?.email ||
      null;

    const participants = (w?.participants || w?.participantList || []).map((p, i) =>
      mapParticipant(p, i, fieldBucket)
    );

    // If no per-participant custom fields exist (single participant form),
    // try to apply top-level custom answers to the lone participant.
    if (participants.length === 1) {
      const only = participants[0];
      if (only.height_in == null) {
        only.height_in = inchesFromHeight(pickForParticipant(fieldBucket, null, [/height/i]));
      }
      if (only.weight_lb == null) {
        only.weight_lb = poundsFromWeight(pickForParticipant(fieldBucket, null, [/weight/i]));
      }
      if (!only.skier_type) {
        only.skier_type = skierTypeFrom(pickForParticipant(fieldBucket, null, [/skier.*type/i]));
      }
    }

    return new Response(
      JSON.stringify({ waiver_id: waiverId, email, participants }, null, 2),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  } catch (err) {
    return bad(String(err), 500);
  }
}

// App Router (Next.js 13+)
export async function GET(req) { return handle(req); }

// If you’re on pages/api, replace the two lines above with:
// export default async function handler(req, res) {
//   const r = await handle(new Request(`http://x${req.url}`));
//   const body = await r.text();
//   res.status(r.status).setHeader("content-type", r.headers.get("content-type") || "application/json").send(body);
// }

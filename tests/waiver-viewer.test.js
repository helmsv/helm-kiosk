const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const handler = require("../api/waiver-pdf");

function request(url, method = "GET") {
  const res = {
    headers: {},
    statusCode: 200,
    body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
    end() { this.body = ""; return this; }
  };
  handler({ url, method }, res);
  return res;
}

test("redirects only to the authenticated viewer for the exact signed intake ID", () => {
  const res = request("/api/waiver-pdf?waiverId=synthetic_intake_A");
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, "https://app.smartwaiver.com/console?id=synthetic_intake_A");
  assert.equal(res.body, "");
  assert.equal(res.headers["cache-control"], "private, no-store");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.equal(res.headers["x-robots-tag"], "noindex, nofollow");
});

test("each customer keeps their own ID, including repeated and out-of-order clicks", () => {
  for (const id of ["synthetic_intake_A", "synthetic_intake_B", "synthetic_intake_A"]) {
    const res = request(`/api/waiver-pdf?waiverId=${id}&email=shared%40example.invalid`);
    assert.equal(new URL(res.headers.location).searchParams.get("id"), id);
    assert.equal(new URL(res.headers.location).searchParams.has("email"), false);
  }
});

test("missing, invalid, ambiguous, or non-signed identifiers never redirect", () => {
  for (const query of [
    "", "?waiverId=", "?waiverId=%20", "?waiverId=a&waiverId=b", "?waiverId=a&waiverID=b",
    "?waiverId=../other", "?waiverId=https%3A%2F%2Fevil.example", "?waiverId=a%0D%0Ab",
    `?waiverId=${"a".repeat(129)}`, "?authenticateId=a", "?documentId=a", "?templateId=a"
  ]) {
    const res = request(`/api/waiver-pdf${query}`);
    assert.equal(res.statusCode, 400, query);
    assert.equal(res.headers.location, undefined, query);
    assert.match(res.body, /Return to Pending Liability/);
  }
});

test("the legacy capitalization remains supported without interpreting other fields", () => {
  const res = request("/api/waiver-pdf?waiverID=synthetic-intake-2&redirect=https://evil.example");
  assert.equal(res.headers.location, "https://app.smartwaiver.com/console?id=synthetic-intake-2");
});

test("GET and HEAD work; mutation methods fail without a redirect", () => {
  assert.equal(request("/api/waiver-pdf?waiverId=synthetic_A", "HEAD").statusCode, 302);
  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = request("/api/waiver-pdf?waiverId=synthetic_A", method);
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, "GET, HEAD");
    assert.equal(res.headers.location, undefined);
  }
});

test("the viewer route never fetches or reads API credentials or signed documents", () => {
  const source = fs.readFileSync(path.join(__dirname, "../api/waiver-pdf.js"), "utf8");
  const sandbox = {
    module: { exports: {} }, URL,
    fetch() { assert.fail("The public viewer route must not fetch signed documents"); },
    process: new Proxy({}, { get() { assert.fail("The viewer route must not read credentials"); } })
  };
  vm.runInNewContext(source, sandbox);
  let target;
  sandbox.module.exports({ url: "/api/waiver-pdf?waiverId=synthetic_A", method: "GET" }, {
    setHeader(name, value) { if (name === "Location") target = value; },
    status(code) { assert.equal(code, 302); return this; },
    end() {}
  });
  assert.equal(target, "https://app.smartwaiver.com/console?id=synthetic_A");
});

test("Pending Liability links use each row's signed ID and a direct new-tab anchor", () => {
  const html = fs.readFileSync(path.join(__dirname, "../tech.html"), "utf8");
  // Exercise the actual link-building statements without page APIs, timers,
  // Smartwaiver, customer records, or a browser login.
  const match = html.match(/const pdfHref =[^\n]+\n\s*const pdfCell =[^\n]+/);
  assert.ok(match, "Keep the signed-intake link a synchronous row-specific anchor");
  for (const id of ["synthetic_A", "synthetic_B", "synthetic_A"]) {
    const cell = vm.runInNewContext(`${match[0]}; pdfCell;`, { r: { waiver_id: id }, encodeURIComponent });
    assert.match(cell, new RegExp(`href="/api/waiver-pdf\\?waiverId=${id}"`));
    assert.match(cell, /target="_blank"/);
    assert.match(cell, /rel="[^"]*noopener/);
    assert.match(cell, /rel="[^"]*noreferrer/);
    assert.match(cell, /title="[^"]*Smartwaiver[^"]*login/i);
  }
  const missing = vm.runInNewContext(`${match[0]}; pdfCell;`, { r: {}, encodeURIComponent });
  assert.equal(missing, "—");
});

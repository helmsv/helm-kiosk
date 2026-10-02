// Open the exact signed intake in Smartwaiver's authenticated staff console.
// The historical route name is kept for existing links. Do not proxy signed
// PDFs through this unauthenticated kiosk route or expose a server API key.
// Official viewer: https://api.smartwaiver.com/api/docs#linking-to-console-waivers

module.exports = function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).send("Method not allowed.");
  }

  // Parse the actual URL so duplicate query parameters cannot silently select
  // a different record. Only signed waiver IDs are accepted, never customer,
  // template, authenticator, or arbitrary destination URLs.
  let ids;
  try {
    const params = new URL(req.url, "http://localhost").searchParams;
    ids = [...params.getAll("waiverId"), ...params.getAll("waiverID")];
  } catch {
    return res.status(400).send("Invalid signed waiver link. Return to Pending Liability and try again.");
  }

  if (ids.length === 0 || (ids.length === 1 && !ids[0])) {
    return res.status(400).send("No signed intake waiver was selected. Return to Pending Liability and choose a customer row.");
  }
  if (ids.length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(ids[0])) {
    return res.status(400).send("Invalid signed waiver link. Return to Pending Liability and try again.");
  }

  // This fixed, vendor-documented destination requires the correct Smartwaiver
  // staff login. No lookup/fallback can accidentally choose another customer.
  const viewer = new URL("https://app.smartwaiver.com/console");
  viewer.searchParams.set("id", ids[0]);
  res.setHeader("Location", viewer.toString());
  return res.status(302).end();
};

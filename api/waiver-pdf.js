// api/waiver-pdf.js (CommonJS)
module.exports = async (req, res) => {
  try {
    const { waiverId } = req.query || {};
    if (!waiverId) return res.status(400).send("Missing waiverId");
    const key = process.env.SW_API_KEY;
    if (!key) return res.status(500).send("Server missing SW_API_KEY");

    const url = `https://api.smartwaiver.com/v4/waivers/${encodeURIComponent(waiverId)}/pdf`;
    const r = await fetch(url, {
      headers: { "X-SW-API-KEY": key, "Accept": "application/pdf" }
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(r.status).send(txt || "Failed to fetch PDF");
    }
    const ab = await r.arrayBuffer();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.status(200).send(Buffer.from(ab));
  } catch (e) {
    console.error("waiver-pdf error:", e);
    res.status(500).send("Internal error");
  }
};

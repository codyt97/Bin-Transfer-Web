// api/ordertime/report.js  (CommonJS, no external deps)

// Tiny CSV parser that handles quotes, commas, and newlines in quotes.
function parseCsvToObjects(text) {
  // Normalize line endings
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  function splitCsvLine(line) {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { // escaped quote
            cur += '"';
            i++;
          } else {
            inQ = false;
          }
        } else {
          cur += ch;
        }
      } else {
        if (ch === ',') {
          out.push(cur);
          cur = "";
        } else if (ch === '"') {
          inQ = true;
        } else {
          cur += ch;
        }
      }
    }
    out.push(cur);
    return out;
  }

  // Split into records respecting quoted newlines
  const records = [];
  let buf = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buf += ch;
    if (ch === '"') {
      // toggle when quote not doubled
      if (text[i + 1] === '"') i++; else inQ = !inQ;
    }
    if (ch === '\n' && !inQ) {
      records.push(buf.replace(/\n$/, ""));
      buf = "";
    }
  }
  if (buf) records.push(buf);

  if (records.length === 0) return [];
  const headers = splitCsvLine(records[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < records.length; i++) {
    if (!records[i]) continue;
    const cols = splitCsvLine(records[i]);
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = (cols[c] ?? "").trim();
    }
    rows.push(obj);
  }
  return rows;
}

function toNumber(x) {
  if (x === undefined || x === null || x === "") return 0;
  const n = Number(String(x).replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

module.exports = async (req, res) => {
  try {
    const url = process.env.OT_REPORT_URL;
    if (!url) return res.status(500).json({ error: "OT_REPORT_URL is not set" });

    const headers = {};
    if (process.env.OT_BEARER_TOKEN) {
      headers.Authorization = `Bearer ${process.env.OT_BEARER_TOKEN}`;
    } else if (process.env.OT_BASIC_USER && process.env.OT_BASIC_PASS) {
      const b64 = Buffer.from(
        `${process.env.OT_BASIC_USER}:${process.env.OT_BASIC_PASS}`
      ).toString("base64");
      headers.Authorization = `Basic ${b64}`;
    }

    const r = await fetch(url, { headers, cache: "no-store" });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return res
        .status(502)
        .json({ error: `OrderTime fetch failed: ${r.status}`, body: t.slice(0, 400) });
    }

    const raw = await r.text();
    let rowsRaw;
    // Try JSON first; if it fails, parse as CSV
    try {
      rowsRaw = JSON.parse(raw);
      if (!Array.isArray(rowsRaw)) throw new Error("not array");
    } catch {
      rowsRaw = parseCsvToObjects(raw);
    }

    const normalized = rowsRaw.map((r) => {
      const item = r.Item || r.SKU || r["Item (SKU)"] || r["Item Name"] || r.Product || "";
      const serial = r["Lot/Serial"] || r.LotSerial || r.Serial || r.IMEI || r["Lot / Serial"] || "";
      const expiration = r["Expiration Date"] || r.Expiry || r.Expiration || "";
      const qty = toNumber(r.Qty || r.Quantity || r["On Hand"] || r["Qty On Hand"]);
      const cost = toNumber(r.Cost || r["Avg Cost"] || r["Unit Cost"]);
      const bin = r.Bin || r.Location || r["Bin Location"] || r.Loc || "";

      return { item, serial, expiration, qty, cost, bin };
    });

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=300");
    res.status(200).json({ rows: normalized });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
};

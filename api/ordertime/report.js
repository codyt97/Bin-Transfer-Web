// api/ordertime/report.js
import { parse } from "csv-parse/sync";

export const config = { runtime: "nodejs" };

function toNumber(x) {
  if (x === undefined || x === null || x === "") return 0;
  const n = Number(String(x).replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export default async function handler(req, res) {
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

    // If your report is JSON, skip CSV parsing and just return the JSON payload.
    const rowsRaw = url.toLowerCase().includes("output=csv") || raw.includes(",")
      ? parse(raw, { columns: true, skip_empty_lines: true })
      : JSON.parse(raw);

    // Normalize to the fields your page needs
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
}

// api/ordertime/live.js
// Node (CommonJS) serverless function for Vercel.
// Outputs: { rows: [{ item, serial, expiration, qty, cost, bin }] }

const OT_BASE_URL = process.env.OT_BASE_URL;   // e.g. https://services.ordertime.com/api
const OT_API_KEY  = process.env.OT_API_KEY;
const OT_BASIC_USER = process.env.OT_BASIC_USER;
const OT_BASIC_PASS = process.env.OT_BASIC_PASS;

const TYPES = {
  INVENTORY:  "InventoryBalance", // adjust if tenant differs
  LOT_SERIAL: "LotOrSerialNo",
  BIN:        "Bin",
  ITEM:       "PartItem"
};

const ITEM_COST_FIELDS = ["LastPurchaseCost", "AverageCost", "StandardCost"];

async function otList(type, opts = {}) {
  const url = `${OT_BASE_URL.replace(/\/+$/,'')}/list`;
  const body = {
    Type: type,
    PageNumber: opts.page || 1,
    NumberOfRecords: opts.pageSize || 500,
    Filters: opts.filters || [],
    Sortation: opts.sort || { PropertyName: "Id", Direction: 1 }
  };

  // try several header schemes (Bearer, ApiKey, Basic)
  const tries = [
    { "Authorization": `Bearer ${OT_API_KEY}`, "Content-Type": "application/json" },
    { "ApiKey": OT_API_KEY, "Content-Type": "application/json" },
    { "X-API-KEY": OT_API_KEY, "Content-Type": "application/json" },
    { "x-api-key": OT_API_KEY, "Content-Type": "application/json" }
  ];
  if (OT_BASIC_USER && OT_BASIC_PASS) {
    const b64 = Buffer.from(`${OT_BASIC_USER}:${OT_BASIC_PASS}`).toString("base64");
    tries.push({ "Authorization": `Basic ${b64}`, "Content-Type": "application/json" });
  }

  let lastText = "";
  for (const headers of tries) {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (res.ok) return res.json();
    lastText = await res.text();
    if (!/incorrect api key|unauthorized|forbidden|invalid token/i.test(lastText)) {
      throw new Error(`OT /list ${type} ${res.status}: ${lastText}`);
    }
  }
  throw new Error(`OT /list ${type} auth failed. Last response: ${lastText}`);
}

async function listAll(type, opts = {}) {
  const out = [];
  let page = 1;
  while (true) {
    const data = await otList(type, { ...opts, page });
    const arr = Array.isArray(data?.Records) ? data.Records : (Array.isArray(data) ? data : []);
    out.push(...arr);
    if (arr.length < (opts.pageSize || 500)) break;
    page++;
    if (page > 200) break; // safety cap
  }
  return out;
}

function firstCost(rec) {
  for (const k of ITEM_COST_FIELDS) {
    if (rec && rec[k] != null) return Number(rec[k]);
  }
  return null;
}

// ---- Vercel Node.js handler (CommonJS) ----
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  if (!OT_BASE_URL || !OT_API_KEY) {
    return res.status(500).json({
      error: "Missing envs",
      haveBaseUrl: !!OT_BASE_URL,
      haveKey: !!OT_API_KEY
    });
  }

  try {
    const url = new URL(req.url, "http://localhost"); // base needed for Node
    const location  = url.searchParams.get("location");
    const binPrefix = url.searchParams.get("binPrefix");
    const qtygt     = Number(url.searchParams.get("qtygt") ?? "0");

    // 1) inventory balances (qty + refs)
    const invBalances = await listAll(TYPES.INVENTORY, { pageSize: 500 });

    // 2) pull dictionaries
    const [lots, items, bins] = await Promise.all([
      listAll(TYPES.LOT_SERIAL, { pageSize: 500 }),
      listAll(TYPES.ITEM,       { pageSize: 500 }),
      listAll(TYPES.BIN,        { pageSize: 500 })
    ]);
    const lotById  = new Map(lots.map(l => [l.Id, l]));
    const itemById = new Map(items.map(i => [i.Id, i]));
    const binById  = new Map(bins.map(b => [b.Id, b]));

    // 3) build rows
    const rows = [];
    for (const r of invBalances) {
      const qty   = Number(r.OnHand ?? r.Qty ?? 0);
      if (qty <= qtygt) continue;

      const lotId  = r?.LotOrSerialRef?.Id ?? r?.LotOrSerialId;
      const itemId = r?.ItemRef?.Id       ?? r?.ItemId;
      const binId  = r?.BinRef?.Id        ?? r?.BinId;

      const lot  = lotId  ? lotById.get(lotId)   : null;
      const item = itemId ? itemById.get(itemId) : null;
      const bin  = binId  ? binById.get(binId)   : null;

      const row = {
        item:       item?.Name || item?.ItemName || "",
        serial:     lot?.LotOrSerialNumber || lot?.Serial || lot?.IMEI || "",
        expiration: lot?.ExpirationDate || lot?.Expiry || "",
        qty,
        cost:       firstCost(item),
        bin:        bin?.Name || ""
      };

      if (binPrefix && row.bin && !row.bin.startsWith(binPrefix)) continue;
      if (location && r?.LocationRef?.Name && r.LocationRef.Name !== location) continue;

      rows.push(row);
    }

    return res.status(200).json({ rows });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
};

// Tell Vercel to run on Node
module.exports.config = { runtime: "nodejs" };

// api/ordertime/live.js
// Direct REST pull from OrderTime (no CSV). Produces:
// { rows: [{ item, serial, expiration, qty, cost, bin }] }

export const config = { runtime: "edge" }; // works on Vercel Edge; remove if using Node runtime

const OT_BASE_URL = process.env.OT_BASE_URL;
const OT_API_KEY  = process.env.OT_API_KEY;

// ---- TUNE THESE TO YOUR ACCOUNT IF NEEDED ----
// Common entity logical names used by OrderTime’s /list API.
// If you get a 400 with "unknown type", change these strings to match your tenant.
const TYPES = {
  INVENTORY:      "InventoryBalance", // Holds OnHand + refs to Item, Lot/Serial, Bin, Location
  LOT_SERIAL:     "LotOrSerialNo",    // Holds LotOrSerialNumber + ExpirationDate + ItemRef
  BIN:            "Bin",              // Holds Name
  ITEM:           "PartItem"          // Holds Name + Cost field(s)
};

// Choose the item cost field you want to expose:
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

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OT_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OT /list ${type} ${res.status}: ${text}`);
  }
  return res.json();
}

async function listAll(type, opts = {}) {
  const out = [];
  let page = 1;
  while (true) {
    const data = await otList(type, { ...opts, page });
    const arr = Array.isArray(data?.Records) ? data.Records : (Array.isArray(data) ? data : []);
    out.push(...arr);
    // Heuristic: break when short page or Count/TotalPages not provided
    if (arr.length < (opts.pageSize || 500)) break;
    page++;
    // Safety: cap pages
    if (page > 200) break;
  }
  return out;
}

function firstCost(rec) {
  for (const k of ITEM_COST_FIELDS) {
    if (rec && rec[k] != null) return Number(rec[k]);
  }
  return null;
}

export default async function handler(req) {
  try {
    // Optional filters from query: ?location=PHL&binPrefix=C-05&qtygt=0
    const { searchParams } = new URL(req.url);
    const location = searchParams.get("location");      // Location Name or Id (Id preferred)
    const binPrefix = searchParams.get("binPrefix");    // e.g., "C-05"
    const qtygt = Number(searchParams.get("qtygt") ?? "0");

    // --- Pull core facts ---

    // 1) Inventory balances (OnHand + refs)
    // If you know exact Filter fields in your tenant, add them below for server-side filtering.
    const invBalances = await listAll(TYPES.INVENTORY, {
      // Example Filters array (commented until you confirm your field names):
      // filters: [
      //   { PropertyName: "OnHand", Operator: 3, FilterValueArray: String(qtygt) } // 3 = >
      // ],
      pageSize: 500
    });

    // 2) Index refs we need to resolve
    const lotIds = new Set();
    const itemIds = new Set();
    const binIds  = new Set();

    for (const r of invBalances) {
      // Basic normalization
      const onHand = Number(r.OnHand ?? r.Qty ?? 0);
      if (onHand <= qtygt) continue; // local filter

      const lotId  = r.LotOrSerialRef?.Id ?? r.LotOrSerialId;
      const itemId = r.ItemRef?.Id ?? r.ItemId;
      const binId  = r.BinRef?.Id ?? r.BinId;

      if (lotId) lotIds.add(lotId);
      if (itemId) itemIds.add(itemId);
      if (binId) binIds.add(binId);
    }

    // 3) Pull dictionaries
    const [lots, items, bins] = await Promise.all([
      listAll(TYPES.LOT_SERIAL, { pageSize: 500 }),
      listAll(TYPES.ITEM,       { pageSize: 500 }),
      listAll(TYPES.BIN,        { pageSize: 500 })
    ]);

    const lotById = new Map(lots.map(l => [l.Id, l]));
    const itemById = new Map(items.map(i => [i.Id, i]));
    const binById  = new Map(bins.map(b => [b.Id, b]));

    // 4) Build unified rows
    const rows = [];
    for (const r of invBalances) {
      const qty = Number(r.OnHand ?? r.Qty ?? 0);
      if (qty <= qtygt) continue;

      const lotId  = r.LotOrSerialRef?.Id ?? r.LotOrSerialId;
      const itemId = r.ItemRef?.Id ?? r.ItemId;
      const binId  = r.BinRef?.Id ?? r.BinId;

      const lot  = lotId  ? lotById.get(lotId)  : null;
      const item = itemId ? itemById.get(itemId) : null;
      const bin  = binId  ? binById.get(binId)  : null;

      const row = {
        item:       item?.Name || item?.ItemName || "",
        serial:     lot?.LotOrSerialNumber || lot?.Serial || lot?.IMEI || "",
        expiration: lot?.ExpirationDate || lot?.Expiry || "",
        qty:        qty,
        cost:       firstCost(item),
        bin:        bin?.Name || ""
      };

      // Optional: apply binPrefix filter
      if (binPrefix && row.bin && !row.bin.startsWith(binPrefix)) continue;

      // Optional: apply location filter by name (if InventoryBalance had LocationRef)
      if (location && r.LocationRef?.Name && r.LocationRef.Name !== location) continue;

      rows.push(row);
    }

    return new Response(JSON.stringify({ rows }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
}

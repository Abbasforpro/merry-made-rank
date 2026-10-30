// Rank tracker: finds where each of the shop's active listings sits in Etsy
// search for its focus keywords, and appends one row per listing and keyword
// to data/rank-history.csv. Run by .github/workflows/rank-check.yml once a day,
// or by hand with `node scripts/check-ranks.mjs`.
//
// Positions come from the Etsy Open API's relevance order (sort_on=score),
// read through the Merry Made Rank connector. It's close to Etsy search but
// leaves out ads and personal results, so treat it as a steady yardstick.
//
// Env: SHOP_NAME (default MerryMadePaper), RANK_PROXY (connector URL),
// ETSY_KEY (optional keystring:secret; skips the connector), DEPTH (default 300).

import { readFile, writeFile } from "node:fs/promises";

const SHOP_NAME = process.env.SHOP_NAME || "MerryMadePaper";
const PROXY = (process.env.RANK_PROXY || "https://merry-made-rank.muhammadabbasenv.workers.dev").replace(/\/+$/, "");
const ETSY_KEY = process.env.ETSY_KEY || "";
const DEPTH = Math.min(Number(process.env.DEPTH) || 300, 500);
const PAGE = 100;
const PAUSE_MS = 400; // one call at a time, a little apart, so the shared Etsy quota lasts
const DATA = new URL("../data/", import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function etsy(path) {
  const url = ETSY_KEY ? "https://openapi.etsy.com/v3/application" + path : PROXY + path;
  // The connector's Cloudflare front refuses some default user agents.
  const headers = { "User-Agent": "merry-made-rank-tracker/1.0" };
  if (ETSY_KEY) headers["x-api-key"] = ETSY_KEY;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers });
    if (res.ok) return res.json();
    const retry = res.status === 429 || res.status >= 500;
    if (!retry || attempt >= 4) throw new Error(`Etsy ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
    await sleep(5000 * 2 ** attempt);
  }
}

// Today's date in Pakistan time, so a run late at night UTC lands on the right day.
function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
}

// Etsy sends titles HTML-escaped.
function unescape(s) {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// Start of the title up to the first comma, used when a listing has no keyword set.
function leadPhrase(title) {
  return unescape(title).split(/[,|]/)[0].trim().toLowerCase();
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function main() {
  const shop = (await etsy(`/shops?shop_name=${encodeURIComponent(SHOP_NAME)}`)).results?.[0];
  if (!shop) throw new Error("Shop not found: " + SHOP_NAME);

  const listings = [];
  for (let offset = 0; ; offset += PAGE) {
    const d = await etsy(`/shops/${shop.shop_id}/listings/active?limit=${PAGE}&offset=${offset}`);
    listings.push(...(d.results || []));
    if (listings.length >= (d.count || 0) || !(d.results || []).length) break;
    await sleep(PAUSE_MS);
  }
  console.log(`${SHOP_NAME}: ${listings.length} active listings`);

  const config = JSON.parse(await readFile(new URL("rank-keywords.json", DATA), "utf8"));
  const set = new Map(config.listings.map((l) => [String(l.listing_id), l.keywords.filter(Boolean)]));

  // keyword -> listing ids tracked on it, so a keyword shared by two listings is searched once.
  const byKeyword = new Map();
  for (const l of listings) {
    const kws = set.get(String(l.listing_id))?.length ? set.get(String(l.listing_id)) : [leadPhrase(l.title)];
    for (const kw of kws) {
      const k = kw.trim().toLowerCase();
      if (!byKeyword.has(k)) byKeyword.set(k, []);
      byKeyword.get(k).push(String(l.listing_id));
    }
  }

  const date = today();
  const rows = [];
  let n = 0;
  for (const [kw, ids] of byKeyword) {
    n++;
    const found = new Map();
    let count = 0;
    for (let offset = 0; offset < DEPTH; offset += PAGE) {
      await sleep(PAUSE_MS);
      const d = await etsy(`/listings/active?limit=${PAGE}&offset=${offset}&sort_on=score&keywords=${encodeURIComponent(kw)}`);
      if (offset === 0) count = d.count || 0;
      (d.results || []).forEach((r, i) => {
        const id = String(r.listing_id);
        if (ids.includes(id) && !found.has(id)) found.set(id, offset + i + 1);
      });
      if (found.size === ids.length || offset + PAGE >= count) break;
    }
    for (const id of ids) rows.push([date, id, kw, found.get(id) ?? "", count]);
    console.log(`${n}/${byKeyword.size} ${kw}: ${ids.map((id) => found.get(id) ?? "-").join(", ")} of ${count}`);
  }

  // Replace today's rows if the check already ran today, keep every other day.
  const histUrl = new URL("rank-history.csv", DATA);
  const header = "date,listing_id,keyword,position,competition";
  let old = [];
  try { old = (await readFile(histUrl, "utf8")).split("\n").slice(1).filter((l) => l && !l.startsWith(date + ",")); } catch (e) { /* first run */ }
  await writeFile(histUrl, [header, ...old, ...rows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n");

  await writeFile(new URL("rank-listings.json", DATA), JSON.stringify({
    updated: new Date().toISOString(), shop: SHOP_NAME, shop_id: shop.shop_id, depth: DEPTH,
    listings: listings.map((l) => ({ id: String(l.listing_id), title: unescape(l.title), url: `https://www.etsy.com/listing/${l.listing_id}` })),
  }, null, 1) + "\n");

  const pos = rows.map((r) => r[3]).filter((p) => p !== "");
  console.log(`Done: ${rows.length} checks, ${pos.filter((p) => p <= 48).length} on page 1, ${pos.filter((p) => p <= 100).length} in top 100, ${pos.length} in top ${DEPTH}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });

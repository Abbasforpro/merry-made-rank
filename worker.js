// Merry Made Rank connector: a free Cloudflare Worker that passes the page's
// requests on to Etsy's Open API (Etsy doesn't allow browsers to call it
// directly), and, once set up, reads Google search volume from the free
// Google Ads API.
//
// Secrets (Settings > Variables and Secrets, type Secret):
//   ETSY_KEY             keystring:shared_secret
//   GADS_DEV_TOKEN       optional: old-style developer token (Google now grants access per Cloud project)
//   GADS_CLIENT_ID       Google Cloud OAuth client ID
//   GADS_CLIENT_SECRET   Google Cloud OAuth client secret
//   GADS_REFRESH_TOKEN   refresh token for the adwords scope
//   GADS_CUSTOMER_ID     your Google Ads account ID, digits only
//   GADS_LOGIN_ID        your manager account ID, digits only
// Optional plain variable: GADS_API_VERSION (default v23)

const ETSY = "https://openapi.etsy.com/v3/application";
const ALLOWED_ORIGINS = ["https://abbasforpro.github.io"];
// Only the read-only lookups the page uses, so the worker isn't an open proxy.
const ETSY_PATHS = [/^\/listings\/active$/, /^\/listings\/batch$/, /^\/shops\/\d+$/];

// Countries checked for "most searched in". Google geo target IDs.
const COUNTRIES = [
  ["US", "United States", 2840], ["GB", "United Kingdom", 2826], ["CA", "Canada", 2124],
  ["AU", "Australia", 2036], ["DE", "Germany", 2276], ["FR", "France", 2250],
  ["IN", "India", 2356], ["IT", "Italy", 2380], ["ES", "Spain", 2724], ["NL", "Netherlands", 2528],
];
const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    const cors = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "x-api-key",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return new Response("Only GET is allowed", { status: 405, headers: cors });
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return new Response("Origin not allowed", { status: 403, headers: cors });

    const url = new URL(request.url);

    if (url.pathname === "/version") return json({ version: 2, google: !!env.GADS_REFRESH_TOKEN });

    if (url.pathname === "/google") {
      const kw = (url.searchParams.get("kw") || "").trim().toLowerCase().slice(0, 80);
      if (!kw) return json({ error: "Missing keyword" }, 400);
      if (!env.GADS_REFRESH_TOKEN) return json({ error: "NOT_SET_UP" }, 503);
      // Cache each keyword for 7 days so Google quota lasts.
      const cacheKey = new Request("https://cache.merry-made-rank/google?kw=" + encodeURIComponent(kw));
      const cached = await caches.default.match(cacheKey);
      if (cached) return json(await cached.json());
      try {
        const data = await googleVolume(env, kw);
        ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(data), { headers: { "Cache-Control": "max-age=604800" } })));
        return json(data);
      } catch (e) {
        return json({ error: String(e.message || e).slice(0, 300) }, 502);
      }
    }

    if (!ETSY_PATHS.some((re) => re.test(url.pathname))) {
      return new Response("Path not allowed", { status: 404, headers: cors });
    }
    const key = env.ETSY_KEY || request.headers.get("x-api-key");
    if (!key) return new Response("No Etsy key: add ETSY_KEY to the worker or paste it in the page", { status: 401, headers: cors });
    const res = await fetch(ETSY + url.pathname + url.search, { headers: { "x-api-key": key } });
    return new Response(await res.text(), {
      status: res.status,
      headers: { ...cors, "Content-Type": res.headers.get("Content-Type") || "application/json" },
    });
  },
};

async function googleToken(env) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GADS_CLIENT_ID, client_secret: env.GADS_CLIENT_SECRET,
      refresh_token: env.GADS_REFRESH_TOKEN, grant_type: "refresh_token",
    }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error("Google login failed: " + (j.error_description || j.error || res.status));
  return j.access_token;
}

async function historical(env, token, kw, geoIds) {
  const v = env.GADS_API_VERSION || "v23";
  const cid = String(env.GADS_CUSTOMER_ID).replace(/\D/g, "");
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  if (env.GADS_DEV_TOKEN) headers["developer-token"] = env.GADS_DEV_TOKEN;
  if (env.GADS_LOGIN_ID) headers["login-customer-id"] = String(env.GADS_LOGIN_ID).replace(/\D/g, "");
  const body = { keywords: [kw], keywordPlanNetwork: "GOOGLE_SEARCH", language: "languageConstants/1000" };
  if (geoIds) body.geoTargetConstants = geoIds.map((g) => "geoTargetConstants/" + g);
  const res = await fetch(`https://googleads.googleapis.com/${v}/customers/${cid}:generateKeywordHistoricalMetrics`, { method: "POST", headers, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) {
    const err = j && (j.error?.details?.[0]?.errors?.[0]?.message || j.error?.message);
    throw new Error("Google Ads: " + (err || res.status));
  }
  return (j.results && j.results[0] && j.results[0].keywordMetrics) || {};
}

async function googleVolume(env, kw) {
  const token = await googleToken(env);
  // Worldwide: average monthly searches and the last 12 months.
  const world = await historical(env, token, kw, null);
  const months = (world.monthlySearchVolumes || []).map((m) => ({
    y: Number(m.year), m: typeof m.month === "number" ? m.month - 1 : MONTHS.indexOf(m.month), v: Number(m.monthlySearches || 0),
  })).sort((a, b) => a.y - b.y || a.m - b.m).slice(-12);
  // Per country, one call each, a little apart to respect Google's rate limit.
  const countries = [];
  for (const [code, name, id] of COUNTRIES) {
    try {
      const m = await historical(env, token, kw, [id]);
      countries.push({ code, name, v: Number(m.avgMonthlySearches || 0) });
    } catch (e) { /* skip a country that fails */ }
    await new Promise((r) => setTimeout(r, 1100));
  }
  countries.sort((a, b) => b.v - a.v);
  return { kw, volume: Number(world.avgMonthlySearches || 0), competition: world.competition || null, months, countries: countries.slice(0, 4) };
}

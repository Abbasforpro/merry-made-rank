// Merry Made Rank connector: a free Cloudflare Worker that passes the page's
// requests on to Etsy's Open API, because Etsy doesn't allow browsers to call
// it directly from a website.
//
// Optional secret: ETSY_KEY = "keystring:shared_secret". When set, the page
// doesn't need to send a key at all.

const ETSY = "https://openapi.etsy.com/v3/application";
const ALLOWED_ORIGINS = ["https://abbasforpro.github.io"];
// Only the read-only lookups the page uses, so the worker isn't an open proxy.
const ALLOWED_PATHS = [/^\/listings\/active$/, /^\/shops\/\d+$/];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    const cors = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "x-api-key",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return new Response("Only GET is allowed", { status: 405, headers: cors });
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return new Response("Origin not allowed", { status: 403, headers: cors });

    const url = new URL(request.url);
    if (!ALLOWED_PATHS.some((re) => re.test(url.pathname))) {
      return new Response("Path not allowed", { status: 404, headers: cors });
    }

    const key = env.ETSY_KEY || request.headers.get("x-api-key");
    if (!key) return new Response("No Etsy key: add ETSY_KEY to the worker or paste it in the page", { status: 401, headers: cors });

    const res = await fetch(ETSY + url.pathname + url.search, { headers: { "x-api-key": key } });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { ...cors, "Content-Type": res.headers.get("Content-Type") || "application/json" },
    });
  },
};

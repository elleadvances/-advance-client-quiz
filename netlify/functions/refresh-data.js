const { getStore } = require("@netlify/blobs");

// GET  /api/refresh-data  -> reports current refresh status (idle/running/
//                            done/error) plus stats from the last completed
//                            run, without touching ClickUp, Google, or
//                            Anthropic. The site polls this.
// POST /api/refresh-data  -> kicks off refresh-data-background.js (which
//                            does the actual slow work) and returns
//                            immediately. Doesn't wait for it to finish.

exports.handler = async (event) => {
  const store = getStore({
    name: "quiz-cache",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_AUTH_TOKEN,
  });

  try {
    if (event.httpMethod === "POST") {
      const baseUrl = process.env.URL || `https://${event.headers.host}`;
      // Fire-and-forget: this call to the background function returns a
      // fast 202 once Netlify has queued it, well before the actual work
      // (which can take a couple of minutes) finishes.
      await fetch(`${baseUrl}/.netlify/functions/refresh-data-background`, { method: "POST" });
      return respond(200, { triggered: true });
    }

    const status = await store.get("refresh-status", { type: "json" }).catch(() => null);
    return respond(200, status || { status: "idle", lastRefreshedAt: null });
  } catch (err) {
    return respond(500, { error: err.message || "Something went wrong." });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

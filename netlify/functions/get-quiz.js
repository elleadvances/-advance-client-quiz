const { getStore } = require("@netlify/blobs");
const { fetchAllTasksFromView, getActiveClientsWithDocs, fieldConfigFromEnv, CACHE_TTL_MS } = require("./lib/clickup");
const { resolveDocFileId, fetchDocText } = require("./lib/drive");
const { generateQuiz, shuffle } = require("./lib/quiz");

exports.handler = async (event) => {
  try {
    const pm = (event.queryStringParameters && event.queryStringParameters.pm) || "ALL";

    const { CLICKUP_API_TOKEN, CLICKUP_VIEW_ID, GOOGLE_API_KEY, ANTHROPIC_API_KEY } = process.env;

    const missing = ["CLICKUP_API_TOKEN", "CLICKUP_VIEW_ID", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY"]
      .filter((key) => !process.env[key]);
    if (missing.length) {
      return respond(500, { error: `Missing environment variables: ${missing.join(", ")}. See README.md.` });
    }

    const store = getStore({
      name: "quiz-cache",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_AUTH_TOKEN,
    });

    // Fast path: "Refresh data" pre-builds a quiz for every PM. If one's
    // ready and still fresh, serve it instantly -- no ClickUp, Drive, or
    // even Anthropic call needed.
    const quizCacheKey = `quiz:${pm}`;
    const cachedQuiz = await store.get(quizCacheKey, { type: "json" }).catch(() => null);
    if (cachedQuiz && Date.now() - cachedQuiz.fetchedAt < CACHE_TTL_MS) {
      return respond(200, { questions: cachedQuiz.questions, clients: cachedQuiz.clients });
    }

    // Slow path: nothing pre-built (or it expired) -- generate live, same
    // as always, using whatever's cached for tasks/docs already.
    const fieldConfig = fieldConfigFromEnv(process.env);
    const tasks = await getCachedTasks(CLICKUP_VIEW_ID, CLICKUP_API_TOKEN, store);
    const allActive = getActiveClientsWithDocs(tasks, fieldConfig);
    const candidates = allActive.filter((c) => pm === "ALL" || (c.pm || "").toLowerCase() === pm.toLowerCase());

    if (candidates.length === 0) {
      return respond(200, {
        questions: [],
        clients: [],
        message: "No active clients with a WIP Master Doc link were found for this selection.",
      });
    }

    const clients = [];
    const results = await Promise.allSettled(
      candidates.map(async (c) => {
        const text = await getCachedDocText(c.docUrl, GOOGLE_API_KEY, store, c.name);
        if (!text || text.trim().length === 0) {
          throw new Error(`Empty or unreadable doc for ${c.name}`);
        }
        return { name: c.name, docText: text };
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        clients.push(r.value);
      } else {
        console.warn(r.reason && r.reason.message ? r.reason.message : r.reason);
      }
    }

    if (clients.length === 0) {
      return respond(200, {
        questions: [],
        clients: [],
        message: "Found clients with a doc link for this selection, but none of the docs could be read. Check that they're still shared as \"anyone with the link.\"",
      });
    }

    const MAX_CLIENTS = 20;
    const cappedClients = clients.length > MAX_CLIENTS ? shuffle(clients).slice(0, MAX_CLIENTS) : clients;

    const questions = await generateQuiz(cappedClients, ANTHROPIC_API_KEY);
    const clientNames = cappedClients.map((c) => c.name);

    // Cache this generated quiz too, so the next person to click the same
    // PM before the next refresh also gets the fast path.
    await store.setJSON(quizCacheKey, { questions, clients: clientNames, fetchedAt: Date.now() });

    return respond(200, { questions, clients: clientNames });
  } catch (err) {
    console.error(err);
    return respond(500, { error: err.message || "Something went wrong generating the quiz." });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function getCachedTasks(viewId, token, store) {
  const cacheKey = `tasks:${viewId}`;
  const cached = await store.get(cacheKey, { type: "json" }).catch(() => null);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.tasks;
  }
  const tasks = await fetchAllTasksFromView(viewId, token);
  await store.setJSON(cacheKey, { tasks, fetchedAt: Date.now() });
  return tasks;
}

async function getCachedDocText(docUrl, apiKey, store, clientName) {
  const cacheKey = `doc:${docUrl}`;
  const cached = await store.get(cacheKey, { type: "json" }).catch(() => null);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.text;
  }

  const fileId = await resolveDocFileId(docUrl, apiKey);
  if (!fileId) {
    throw new Error(`Could not find a Google Doc for ${clientName}: ${docUrl}`);
  }
  const text = await fetchDocText(fileId, apiKey);

  await store.setJSON(cacheKey, { text, fetchedAt: Date.now() });
  return text;
}

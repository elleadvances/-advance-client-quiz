const { getStore } = require("@netlify/blobs");
const { fetchAllTasksFromView, getActiveClientsWithDocs, fieldConfigFromEnv, KNOWN_PMS } = require("./lib/clickup");
const { resolveDocFileId, fetchDocText } = require("./lib/drive");
const { generateQuiz, shuffle } = require("./lib/quiz");

// GET  /api/refresh-data  -> reports when the cache was last refreshed,
//                            without touching ClickUp, Google, or Anthropic.
// POST /api/refresh-data  -> forces a full live refresh right now:
//                              1. re-pulls the ClickUp task list
//                              2. re-reads every active client's doc content
//                              3. pre-builds and caches a quiz for every PM
//                                 (and "All Clients"), so clicking any PM
//                                 button afterward is instant.

const MAX_CLIENTS_PER_QUIZ = 20;

exports.handler = async (event) => {
  const { CLICKUP_API_TOKEN, CLICKUP_VIEW_ID, GOOGLE_API_KEY, ANTHROPIC_API_KEY } = process.env;

  if (!CLICKUP_API_TOKEN || !CLICKUP_VIEW_ID) {
    return respond(500, { error: "Missing CLICKUP_API_TOKEN or CLICKUP_VIEW_ID." });
  }

  const store = getStore("quiz-cache");
  const tasksCacheKey = `tasks:${CLICKUP_VIEW_ID}`;

  try {
    if (event.httpMethod === "POST") {
      if (!GOOGLE_API_KEY || !ANTHROPIC_API_KEY) {
        return respond(500, { error: "Missing GOOGLE_API_KEY or ANTHROPIC_API_KEY." });
      }

      const fetchedAt = Date.now();

      // 1. Refresh the task list.
      const tasks = await fetchAllTasksFromView(CLICKUP_VIEW_ID, CLICKUP_API_TOKEN);
      await store.setJSON(tasksCacheKey, { tasks, fetchedAt });

      const fieldConfig = fieldConfigFromEnv(process.env);
      const allActive = getActiveClientsWithDocs(tasks, fieldConfig);

      // 2. Refresh every active client's doc content, in parallel, and keep
      // a name -> docText map in memory so we can reuse it for quiz-building
      // below without reading anything back from the cache.
      const docTextByName = {};
      let docsRefreshed = 0;
      let docsFailed = 0;

      const docResults = await Promise.allSettled(
        allActive.map(async (c) => {
          const fileId = await resolveDocFileId(c.docUrl, GOOGLE_API_KEY);
          if (!fileId) throw new Error(`No doc found for ${c.name}`);
          const text = await fetchDocText(fileId, GOOGLE_API_KEY);
          await store.setJSON(`doc:${c.docUrl}`, { text, fetchedAt });
          return { name: c.name, docText: text };
        })
      );
      for (const r of docResults) {
        if (r.status === "fulfilled") {
          docTextByName[r.value.name] = r.value.docText;
          docsRefreshed += 1;
        } else {
          docsFailed += 1;
          console.warn(r.reason && r.reason.message ? r.reason.message : r.reason);
        }
      }

      // 3. Pre-build and cache a quiz for every PM option, in parallel.
      let quizzesBuilt = 0;
      let quizzesFailed = 0;

      await Promise.allSettled(
        KNOWN_PMS.map(async (pm) => {
          const candidates = allActive.filter(
            (c) => pm === "ALL" || (c.pm || "").toLowerCase() === pm.toLowerCase()
          );
          const clients = candidates
            .filter((c) => docTextByName[c.name] && docTextByName[c.name].trim().length > 0)
            .map((c) => ({ name: c.name, docText: docTextByName[c.name] }));

          if (clients.length === 0) {
            await store.setJSON(`quiz:${pm}`, { questions: [], clients: [], fetchedAt });
            return;
          }

          const capped = clients.length > MAX_CLIENTS_PER_QUIZ ? shuffle(clients).slice(0, MAX_CLIENTS_PER_QUIZ) : clients;
          const questions = await generateQuiz(capped, ANTHROPIC_API_KEY);
          await store.setJSON(`quiz:${pm}`, { questions, clients: capped.map((c) => c.name), fetchedAt });
          quizzesBuilt += 1;
        })
      ).then((results) => {
        quizzesFailed = results.filter((r) => r.status === "rejected").length;
      });

      return respond(200, {
        lastRefreshedAt: fetchedAt,
        taskCount: tasks.length,
        docsRefreshed,
        docsFailed,
        quizzesBuilt,
        quizzesFailed,
      });
    }

    const cached = await store.get(tasksCacheKey, { type: "json" }).catch(() => null);
    return respond(200, {
      lastRefreshedAt: cached ? cached.fetchedAt : null,
      taskCount: cached ? cached.tasks.length : null,
    });
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

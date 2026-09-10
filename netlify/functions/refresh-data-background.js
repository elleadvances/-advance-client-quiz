// Netlify treats any function file ending in "-background" specially: it
// gets up to 15 minutes to run (instead of a normal function's ~10 second
// limit) and the caller gets an immediate 202 without waiting for it to
// finish. This does the actual heavy lifting -- pulling ClickUp, re-reading
// every doc, and generating 5 quizzes -- which was blowing past a normal
// function's time limit.
//
// Progress/results are written to the "refresh-status" cache key as it
// goes, so refresh-data.js (a normal, fast function) can report status by
// just reading that key -- the site polls it after triggering this.

const { getStore } = require("@netlify/blobs");
const { fetchAllTasksFromView, getActiveClientsWithDocs, fieldConfigFromEnv, KNOWN_PMS } = require("./lib/clickup");
const { resolveDocFileId, fetchDocText } = require("./lib/drive");
const { generateQuiz, shuffle } = require("./lib/quiz");

// This runs as a background job with a much longer time budget than a
// normal function, so there's no need to cap how many clients go into one
// quiz here -- "All Clients" should mean genuinely all of them. (The
// generateQuiz prompt already scales questions-per-client down as the
// client count grows, to keep the Anthropic response a manageable size.)
const MAX_CLIENTS_PER_QUIZ = Infinity;

exports.handler = async () => {
  const { CLICKUP_API_TOKEN, CLICKUP_VIEW_ID, GOOGLE_API_KEY, ANTHROPIC_API_KEY } = process.env;

  const store = getStore({
    name: "quiz-cache",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_AUTH_TOKEN,
  });

  const startedAt = Date.now();
  await store.setJSON("refresh-status", { status: "running", startedAt });

  try {
    if (!CLICKUP_API_TOKEN || !CLICKUP_VIEW_ID || !GOOGLE_API_KEY || !ANTHROPIC_API_KEY) {
      throw new Error("Missing one or more required environment variables.");
    }

    const fetchedAt = Date.now();

    // 1. Refresh the task list.
    const tasks = await fetchAllTasksFromView(CLICKUP_VIEW_ID, CLICKUP_API_TOKEN);
    await store.setJSON(`tasks:${CLICKUP_VIEW_ID}`, { tasks, fetchedAt });

    const fieldConfig = fieldConfigFromEnv(process.env);
    const allActive = getActiveClientsWithDocs(tasks, fieldConfig);

    // 2. Refresh every active client's doc content, in parallel.
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

    const quizResults = await Promise.allSettled(
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
      })
    );
    quizzesBuilt = quizResults.filter((r) => r.status === "fulfilled").length;
    quizzesFailed = quizResults.filter((r) => r.status === "rejected").length;

    await store.setJSON("refresh-status", {
      status: "done",
      lastRefreshedAt: fetchedAt,
      taskCount: tasks.length,
      docsRefreshed,
      docsFailed,
      quizzesBuilt,
      quizzesFailed,
    });
  } catch (err) {
    console.error(err);
    await store.setJSON("refresh-status", {
      status: "error",
      error: err.message || "Something went wrong during refresh.",
      lastRefreshedAt: null,
    });
  }
};

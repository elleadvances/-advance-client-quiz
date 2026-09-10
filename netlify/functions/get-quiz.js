exports.handler = async (event) => {
  try {
    const pm = (event.queryStringParameters && event.queryStringParameters.pm) || "ALL";

    const {
      CLICKUP_API_TOKEN,
      CLICKUP_VIEW_ID,
      CLICKUP_PM_FIELD_NAME,
      CLICKUP_DOC_FIELD_NAME,
      CLICKUP_STATUS_FIELD_NAME,
      CLICKUP_ACTIVE_STATUSES,
      GOOGLE_API_KEY,
      ANTHROPIC_API_KEY,
    } = process.env;

    const missing = ["CLICKUP_API_TOKEN", "CLICKUP_VIEW_ID", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY"]
      .filter((key) => !process.env[key]);
    if (missing.length) {
      return respond(500, { error: `Missing environment variables: ${missing.join(", ")}. See README.md.` });
    }

    const pmFieldName = CLICKUP_PM_FIELD_NAME || "PM Assigned";
    const docFieldName = CLICKUP_DOC_FIELD_NAME || "WIP Master Doc";
    const statusFieldName = CLICKUP_STATUS_FIELD_NAME || "Client Status";

    const activeStatuses = (CLICKUP_ACTIVE_STATUSES || "active client")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const tasks = await fetchAllTasksFromView(CLICKUP_VIEW_ID, CLICKUP_API_TOKEN);

    // "Active" is tracked via the custom "Client Status" field (e.g. "Active
    // Client" / "Completed"), NOT ClickUp's built-in task status (Open/In
    // Progress/Closed) -- those are two different things on this list.
    // Fields are matched by NAME (not id), since the same task can live
    // across lists/spaces where field ids differ but names stay consistent.
    const candidates = tasks
      .filter((t) => activeStatuses.includes(getFieldValueByName(t, statusFieldName).toLowerCase()))
      .map((t) => ({
        name: t.name,
        pm: getFieldValueByName(t, pmFieldName),
        docUrl: getFieldValueByName(t, docFieldName),
      }))
      .filter((c) => c.docUrl && c.docUrl.trim().length > 0)
      .filter((c) => pm === "ALL" || (c.pm || "").toLowerCase() === pm.toLowerCase());

    if (candidates.length === 0) {
      return respond(200, {
        questions: [],
        clients: [],
        message: "No active clients with a WIP Master Doc link were found for this selection.",
      });
    }

    // Pull each client's doc content. Skip (don't fail the whole quiz) any
    // doc that can't be fetched (bad link, sharing changed, etc.).
    const clients = [];
    // Fetch every client's doc in parallel rather than one at a time --
    // with more than a handful of clients (e.g. a busy PM, or "ALL"),
    // sequential fetches can add up and exceed the function's time limit.
    const results = await Promise.allSettled(
      candidates.map(async (c) => {
        const fileId = await resolveDocFileId(c.docUrl, GOOGLE_API_KEY);
        if (!fileId) {
          throw new Error(`Could not find a Google Doc for ${c.name}: ${c.docUrl}`);
        }
        const text = await fetchDocText(fileId, GOOGLE_API_KEY);
        if (!text || text.trim().length === 0) {
          throw new Error(`Empty doc for ${c.name}`);
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

    // Cap how many clients go into one quiz -- keeps the Anthropic call (and
    // overall function runtime) bounded for busy PMs or "All Clients".
    const MAX_CLIENTS = 20;
    const cappedClients = clients.length > MAX_CLIENTS ? shuffle(clients).slice(0, MAX_CLIENTS) : clients;

    const questions = await generateQuiz(cappedClients, ANTHROPIC_API_KEY);

    return respond(200, { questions, clients: cappedClients.map((c) => c.name) });
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

// Pulls tasks the same way a ClickUp VIEW shows them, regardless of how many
// underlying Lists/Spaces those tasks actually live in. This matters here
// because client tasks can be cross-listed across multiple Lists (e.g. a
// "Client Won List" in one Space plus an ops list in another), and the
// per-PM tabs in ClickUp are views, not single Lists.
async function fetchAllTasksFromView(viewId, token) {
  let tasks = [];
  let page = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = `https://api.clickup.com/api/v2/view/${viewId}/task?page=${page}`;
    const res = await fetch(url, { headers: { Authorization: token } });
    if (!res.ok) {
      throw new Error(`ClickUp API error (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    tasks = tasks.concat(data.tasks || []);
    if (data.last_page || !data.tasks || data.tasks.length === 0) break;
    page += 1;
  }
  return tasks;
}

function getFieldValueByName(task, fieldName) {
  const field = (task.custom_fields || []).find(
    (f) => f.name && f.name.toLowerCase() === fieldName.toLowerCase()
  );
  if (!field || field.value === undefined || field.value === null || field.value === "") return "";

  if (field.type === "drop_down" && field.type_config && Array.isArray(field.type_config.options)) {
    const opt = field.type_config.options.find((o) => o.orderindex === field.value);
    return opt ? opt.name : "";
  }
  if (field.type === "labels" && Array.isArray(field.value)) {
    const options = (field.type_config && field.type_config.options) || [];
    return field.value
      .map((v) => (options.find((o) => o.id === v) || {}).label)
      .filter(Boolean)
      .join(", ");
  }
  if (typeof field.value === "object") {
    return JSON.stringify(field.value);
  }
  return String(field.value);
}

// Pulls the Drive file ID out of a Google Doc URL, e.g.
// https://docs.google.com/document/d/1QbJCjPo866s.../edit?tab=t.xxx#heading=...
function extractDriveFileId(url) {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// Pulls the folder ID out of a Google Drive folder URL, e.g.
// https://drive.google.com/drive/folders/1s3cO5ux4FT3ef3pgQetVrFYPpve7MfdS
function extractDriveFolderId(url) {
  const match = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// The WIP Master Doc field sometimes holds a direct Google Doc link, and
// sometimes holds a link to the client's whole Drive FOLDER (with the
// actual doc sitting inside it). This resolves either case down to a single
// Google Doc file id we can export text from.
async function resolveDocFileId(url, apiKey) {
  const directId = extractDriveFileId(url);
  if (directId) return directId;

  const folderId = extractDriveFolderId(url);
  if (!folderId) return null;

  const q = encodeURIComponent(`'${folderId}' in parents and mimeType = 'application/vnd.google-apps.document' and trashed = false`);
  const listUrl = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&key=${apiKey}`;
  const res = await fetch(listUrl);
  if (!res.ok) {
    throw new Error(`Drive folder listing error (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  const files = data.files || [];
  if (files.length === 0) return null;

  // Prefer a file that looks like the actual master doc if there's more
  // than one Google Doc sitting in the folder.
  const masterDoc = files.find((f) => f.name && f.name.toLowerCase().includes("master doc"));
  return (masterDoc || files[0]).id;
}

const MAX_DOC_CHARS = 15000;

// Exports a public ("anyone with the link") Google Doc as plain text using
// just an API key -- no OAuth/service account needed since the doc is
// link-shared. Returns the whole doc's text (all tabs run together).
async function fetchDocText(fileId, apiKey) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Drive export error (${res.status}): ${await res.text()}`);
  }
  const text = await res.text();
  return text.length > MAX_DOC_CHARS ? text.slice(0, MAX_DOC_CHARS) : text;
}

async function generateQuiz(clients, apiKey) {
  const perClient = clients.length > 6 ? 2 : 3;
  const clientBlock = clients
    .map((c) => `=== Client: ${c.name} ===\n${c.docText}`)
    .join("\n\n---\n\n");

  const prompt = `You are building a multiple-choice quiz for an ad agency team to test how well they know their clients.

Below is each client's full "WIP Master Doc" -- a working document that mixes several things together: production notes, scripts, timelines, and (somewhere in it) the client's own answers from their onboarding/intake questionnaire (a GHL form). The questionnaire section is usually a clearly labeled set of questions and the client's own answers about their business, goals, audience, budget, brand voice, etc.

For EACH client, first find that questionnaire/intake-answers content within their doc and ignore everything else (production notes, scripts, internal comments, timelines). Then write ${perClient} multiple-choice questions that test a specific, memorable detail from the client's actual questionnaire answers. Rephrase and summarize in your own words rather than quoting verbatim. If you genuinely can't find any client-provided questionnaire answers in a client's doc, skip that client entirely rather than inventing questions from unrelated content.

Rules:
- Each question has exactly 4 options, only one correct.
- Wrong options should be plausible -- pull them from other clients' real answers when you can, so the quiz tests actual client knowledge rather than obvious guessing.
- Never invent a fact that isn't supported by the client's own questionnaire answers.
- Return ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:
[{"client":"<client name>","question":"<question text>","options":["A","B","C","D"],"correctIndex":0}]

Client docs:

${clientBlock}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const cleaned = text.replace(/```json|```/g, "").trim();

  let questions;
  try {
    questions = JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Couldn't parse quiz JSON from Claude's response.");
  }

  return shuffle(questions);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

exports.handler = async (event) => {
  try {
    const pm = (event.queryStringParameters && event.queryStringParameters.pm) || "ALL";

    const {
      CLICKUP_API_TOKEN,
      CLICKUP_LIST_ID,
      CLICKUP_PM_FIELD_ID,
      CLICKUP_DOC_FIELD_ID,
      CLICKUP_STATUS_FIELD_ID,
      CLICKUP_ACTIVE_STATUSES,
      GOOGLE_API_KEY,
      ANTHROPIC_API_KEY,
    } = process.env;

    const missing = ["CLICKUP_API_TOKEN", "CLICKUP_LIST_ID", "CLICKUP_PM_FIELD_ID", "CLICKUP_DOC_FIELD_ID", "CLICKUP_STATUS_FIELD_ID", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY"]
      .filter((key) => !process.env[key]);
    if (missing.length) {
      return respond(500, { error: `Missing environment variables: ${missing.join(", ")}. See README.md.` });
    }

    const activeStatuses = (CLICKUP_ACTIVE_STATUSES || "active client")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const tasks = await fetchAllTasks(CLICKUP_LIST_ID, CLICKUP_API_TOKEN);

    // "Active" is tracked via the custom "Client Status" field (e.g. "Active
    // Client" / "Completed"), NOT ClickUp's built-in task status (Open/In
    // Progress/Closed) \u2014 those are two different things on this list.
    const candidates = tasks
      .filter((t) => activeStatuses.includes(getFieldValue(t, CLICKUP_STATUS_FIELD_ID).toLowerCase()))
      .map((t) => ({
        name: t.name,
        pm: getFieldValue(t, CLICKUP_PM_FIELD_ID),
        docUrl: getFieldValue(t, CLICKUP_DOC_FIELD_ID),
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
    for (const c of candidates) {
      const fileId = extractDriveFileId(c.docUrl);
      if (!fileId) {
        console.warn(`Could not find a Google Doc ID in the link for ${c.name}: ${c.docUrl}`);
        continue;
      }
      try {
        const text = await fetchDocText(fileId, GOOGLE_API_KEY);
        if (text && text.trim().length > 0) {
          clients.push({ name: c.name, docText: text });
        }
      } catch (e) {
        console.warn(`Could not fetch doc for ${c.name}: ${e.message}`);
      }
    }

    if (clients.length === 0) {
      return respond(200, {
        questions: [],
        clients: [],
        message: "Found clients with a doc link for this selection, but none of the docs could be read. Check that they're still shared as \"anyone with the link.\"",
      });
    }

    const questions = await generateQuiz(clients, ANTHROPIC_API_KEY);

    return respond(200, { questions, clients: clients.map((c) => c.name) });
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

async function fetchAllTasks(listId, token) {
  let tasks = [];
  let page = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = `https://api.clickup.com/api/v2/list/${listId}/task?archived=false&include_closed=true&subtasks=false&page=${page}`;
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

function getFieldValue(task, fieldId) {
  const field = (task.custom_fields || []).find((f) => f.id === fieldId);
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
    // e.g. rich text / short text stored as object in some field types
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

const MAX_DOC_CHARS = 15000;

// Exports a public ("anyone with the link") Google Doc as plain text using
// just an API key \u2014 no OAuth/service account needed since the doc is
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

Below is each client's full "WIP Master Doc" \u2014 a working document that mixes several things together: production notes, scripts, timelines, and (somewhere in it) the client's own answers from their onboarding/intake questionnaire (a GHL form). The questionnaire section is usually a clearly labeled set of questions and the client's own answers about their business, goals, audience, budget, brand voice, etc.

For EACH client, first find that questionnaire/intake-answers content within their doc and ignore everything else (production notes, scripts, internal comments, timelines). Then write ${perClient} multiple-choice questions that test a specific, memorable detail from the client's actual questionnaire answers. Rephrase and summarize in your own words rather than quoting verbatim. If you genuinely can't find any client-provided questionnaire answers in a client's doc, skip that client entirely rather than inventing questions from unrelated content.

Rules:
- Each question has exactly 4 options, only one correct.
- Wrong options should be plausible \u2014 pull them from other clients' real answers when you can, so the quiz tests actual client knowledge rather than obvious guessing.
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

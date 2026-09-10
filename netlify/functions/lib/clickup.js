// Pulls tasks the same way a ClickUp VIEW shows them, regardless of how many
// underlying Lists/Spaces those tasks actually live in. This matters because
// client tasks can be cross-listed across multiple Lists (e.g. a "Client Won
// List" in one Space plus an ops list in another), and the per-PM tabs in
// ClickUp are views, not single Lists.
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

// Fields are matched by NAME (not id), since the same task can live across
// lists/spaces where field ids differ but names stay consistent.
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

// Given the full task list and env-configured field names/active statuses,
// returns { name, pm, docUrl } for every active client that has a doc link,
// regardless of which PM. Callers filter down to a specific PM themselves.
function getActiveClientsWithDocs(tasks, { pmFieldName, docFieldName, statusFieldName, activeStatuses }) {
  return tasks
    .filter((t) => activeStatuses.includes(getFieldValueByName(t, statusFieldName).toLowerCase()))
    .map((t) => ({
      name: t.name,
      pm: getFieldValueByName(t, pmFieldName),
      docUrl: getFieldValueByName(t, docFieldName),
    }))
    .filter((c) => c.docUrl && c.docUrl.trim().length > 0);
}

function fieldConfigFromEnv(env) {
  return {
    pmFieldName: env.CLICKUP_PM_FIELD_NAME || "PM Assigned",
    docFieldName: env.CLICKUP_DOC_FIELD_NAME || "WIP Master Doc",
    statusFieldName: env.CLICKUP_STATUS_FIELD_NAME || "Client Status",
    activeStatuses: (env.CLICKUP_ACTIVE_STATUSES || "active client")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}

// The fixed set of PM options the site offers (matches the buttons in
// index.html). "ALL" isn't a real PM -- it means every active client.
const KNOWN_PMS = ["Aldrin", "Alexis", "Ann", "Liz", "ALL"];

// How long cached data (tasks, docs, and pre-built quizzes) is considered
// fresh. Questionnaire content is essentially static once a client's set
// up, so this is long on purpose. The "Refresh data" button forces a live
// re-fetch of everything ahead of this expiring naturally.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

module.exports = { fetchAllTasksFromView, getFieldValueByName, getActiveClientsWithDocs, fieldConfigFromEnv, KNOWN_PMS, CACHE_TTL_MS };

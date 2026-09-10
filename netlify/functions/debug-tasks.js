// TEMPORARY DEBUG TOOL. Visit:
//   https://<your-site>.netlify.app/api/debug-tasks
//   https://<your-site>.netlify.app/api/debug-tasks?name=Casey Woodard
// Now pulls from the ClickUp VIEW (CLICKUP_VIEW_ID) instead of a single
// list, matching whatever the Main List / per-PM tabs show on screen.
// With no ?name=, shows the raw name/status/PM/doc/client-status values for
// the first several tasks. With ?name=, searches ALL tasks for one matching
// that name and dumps its FULL raw custom_fields array.
// Delete this file once things work.

exports.handler = async (event) => {
  const { CLICKUP_API_TOKEN, CLICKUP_VIEW_ID, CLICKUP_PM_FIELD_NAME, CLICKUP_DOC_FIELD_NAME, CLICKUP_STATUS_FIELD_NAME } = process.env;

  if (!CLICKUP_API_TOKEN || !CLICKUP_VIEW_ID) {
    return respond(500, { error: "Missing CLICKUP_API_TOKEN or CLICKUP_VIEW_ID." });
  }

  const pmFieldName = CLICKUP_PM_FIELD_NAME || "PM Assigned";
  const docFieldName = CLICKUP_DOC_FIELD_NAME || "WIP Master Doc";
  const statusFieldName = CLICKUP_STATUS_FIELD_NAME || "Client Status";
  const nameQuery = event.queryStringParameters && event.queryStringParameters.name;

  try {
    if (nameQuery) {
      const tasks = await fetchAllTasksFromView(CLICKUP_VIEW_ID, CLICKUP_API_TOKEN);
      const match = tasks.find((t) => t.name && t.name.toLowerCase().includes(nameQuery.toLowerCase()));
      if (!match) {
        return respond(404, { error: `No task found with a name containing "${nameQuery}".`, totalTasksScanned: tasks.length });
      }
      return respond(200, {
        name: match.name,
        builtInStatus: match.status && match.status.status,
        allCustomFields: (match.custom_fields || []).map((f) => ({
          id: f.id,
          name: f.name,
          type: f.type,
          value: f.value,
        })),
        decoded: {
          pmFieldValue: getFieldValueByName(match, pmFieldName),
          docFieldValue: getFieldValueByName(match, docFieldName),
          statusFieldValue: getFieldValueByName(match, statusFieldName),
        },
      });
    }

    const tasks = await fetchAllTasksFromView(CLICKUP_VIEW_ID, CLICKUP_API_TOKEN);
    const rows = tasks.slice(0, 40).map((t) => ({
      name: t.name,
      builtInStatus: t.status && t.status.status,
      pmFieldValue: getFieldValueByName(t, pmFieldName),
      docFieldValue: getFieldValueByName(t, docFieldName),
      statusFieldValue: getFieldValueByName(t, statusFieldName),
    }));

    return respond(200, { totalTasks: tasks.length, sample: rows });
  } catch (err) {
    return respond(500, { error: err.message });
  }
};

async function fetchAllTasksFromView(viewId, token) {
  let tasks = [];
  let page = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = `https://api.clickup.com/api/v2/view/${viewId}/task?page=${page}`;
    const res = await fetch(url, { headers: { Authorization: token } });
    if (!res.ok) throw new Error(`ClickUp API error (${res.status}): ${await res.text()}`);
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
  if (typeof field.value === "object") return JSON.stringify(field.value);
  return String(field.value);
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body, null, 2),
  };
}

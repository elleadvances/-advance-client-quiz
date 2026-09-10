// TEMPORARY DEBUG TOOL. Visit:
//   https://<your-site>.netlify.app/api/debug-tasks
//   https://<your-site>.netlify.app/api/debug-tasks?name=Casey Woodard
// With no ?name=, shows the raw name/status/PM/doc/client-status values for
// the first several tasks. With ?name=, searches ALL tasks for one matching
// that name and dumps its FULL raw custom_fields array so we can see
// exactly how a specific field (like Client Status) is structured.
// Delete this file once things work.

exports.handler = async (event) => {
  const { CLICKUP_API_TOKEN, CLICKUP_LIST_ID, CLICKUP_PM_FIELD_ID, CLICKUP_DOC_FIELD_ID, CLICKUP_STATUS_FIELD_ID } = process.env;

  if (!CLICKUP_API_TOKEN || !CLICKUP_LIST_ID) {
    return respond(500, { error: "Missing CLICKUP_API_TOKEN or CLICKUP_LIST_ID." });
  }

  const nameQuery = event.queryStringParameters && event.queryStringParameters.name;

  try {
    if (nameQuery) {
      const tasks = await fetchAllTasks(CLICKUP_LIST_ID, CLICKUP_API_TOKEN);
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
          options: f.type_config && f.type_config.options
            ? f.type_config.options.map((o) => ({ name: o.name || o.label, orderindex: o.orderindex, id: o.id }))
            : undefined,
        })),
        decoded: {
          pmFieldValue: CLICKUP_PM_FIELD_ID ? getFieldValue(match, CLICKUP_PM_FIELD_ID) : "(CLICKUP_PM_FIELD_ID not set)",
          docFieldValue: CLICKUP_DOC_FIELD_ID ? getFieldValue(match, CLICKUP_DOC_FIELD_ID) : "(CLICKUP_DOC_FIELD_ID not set)",
          statusFieldValue: CLICKUP_STATUS_FIELD_ID ? getFieldValue(match, CLICKUP_STATUS_FIELD_ID) : "(CLICKUP_STATUS_FIELD_ID not set)",
        },
      });
    }

    const url = `https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task?archived=false&include_closed=true&subtasks=false&page=0`;
    const res = await fetch(url, { headers: { Authorization: CLICKUP_API_TOKEN } });
    if (!res.ok) {
      return respond(res.status, { error: await res.text() });
    }
    const data = await res.json();

    const rows = (data.tasks || []).slice(0, 40).map((t) => ({
      name: t.name,
      builtInStatus: t.status && t.status.status,
      pmFieldValue: CLICKUP_PM_FIELD_ID ? getFieldValue(t, CLICKUP_PM_FIELD_ID) : "(CLICKUP_PM_FIELD_ID not set)",
      docFieldValue: CLICKUP_DOC_FIELD_ID ? getFieldValue(t, CLICKUP_DOC_FIELD_ID) : "(CLICKUP_DOC_FIELD_ID not set)",
      statusFieldValue: CLICKUP_STATUS_FIELD_ID ? getFieldValue(t, CLICKUP_STATUS_FIELD_ID) : "(CLICKUP_STATUS_FIELD_ID not set)",
    }));

    return respond(200, { totalTasksOnPage0: (data.tasks || []).length, sample: rows });
  } catch (err) {
    return respond(500, { error: err.message });
  }
};

async function fetchAllTasks(listId, token) {
  let tasks = [];
  let page = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = `https://api.clickup.com/api/v2/list/${listId}/task?archived=false&include_closed=true&subtasks=false&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: token } });
    if (!res.ok) throw new Error(`ClickUp API error (${res.status}): ${await res.text()}`);
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

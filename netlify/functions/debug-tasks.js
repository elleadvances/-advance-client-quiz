// TEMPORARY DEBUG TOOL. Visit:
//   https://<your-site>.netlify.app/api/debug-tasks
// Shows the raw name/status/PM/doc values ClickUp is actually returning,
// so mismatches (wrong status text, wrong field id, etc.) are visible
// directly instead of being guessed at. Delete this file once things work.

exports.handler = async (event) => {
  const { CLICKUP_API_TOKEN, CLICKUP_LIST_ID, CLICKUP_PM_FIELD_ID, CLICKUP_DOC_FIELD_ID } = process.env;

  if (!CLICKUP_API_TOKEN || !CLICKUP_LIST_ID) {
    return respond(500, { error: "Missing CLICKUP_API_TOKEN or CLICKUP_LIST_ID." });
  }

  try {
    const url = `https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task?archived=false&include_closed=true&subtasks=false&page=0`;
    const res = await fetch(url, { headers: { Authorization: CLICKUP_API_TOKEN } });
    if (!res.ok) {
      return respond(res.status, { error: await res.text() });
    }
    const data = await res.json();

    const rows = (data.tasks || []).slice(0, 40).map((t) => ({
      name: t.name,
      status: t.status && t.status.status,
      pmFieldValue: CLICKUP_PM_FIELD_ID ? getFieldValue(t, CLICKUP_PM_FIELD_ID) : "(CLICKUP_PM_FIELD_ID not set)",
      docFieldValue: CLICKUP_DOC_FIELD_ID ? getFieldValue(t, CLICKUP_DOC_FIELD_ID) : "(CLICKUP_DOC_FIELD_ID not set)",
    }));

    return respond(200, { totalTasksOnPage0: (data.tasks || []).length, sample: rows });
  } catch (err) {
    return respond(500, { error: err.message });
  }
};

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

// One-time setup helper. Visit:
//   https://<your-site>.netlify.app/api/list-fields?listId=YOUR_LIST_ID
// It returns every custom field on that list with its id, name, and type,
// so you can copy the right IDs into your Netlify env vars
// (CLICKUP_PM_FIELD_ID and CLICKUP_QUESTIONNAIRE_FIELD_ID).
// Safe to delete this file once setup is done.

exports.handler = async (event) => {
  const { CLICKUP_API_TOKEN, CLICKUP_LIST_ID } = process.env;
  const listId = (event.queryStringParameters && event.queryStringParameters.listId) || CLICKUP_LIST_ID;

  if (!CLICKUP_API_TOKEN) {
    return respond(500, { error: "Missing CLICKUP_API_TOKEN environment variable." });
  }
  if (!listId) {
    return respond(400, { error: "Pass ?listId=YOUR_LIST_ID or set CLICKUP_LIST_ID." });
  }

  try {
    const res = await fetch(`https://api.clickup.com/api/v2/list/${listId}/field`, {
      headers: { Authorization: CLICKUP_API_TOKEN },
    });
    if (!res.ok) {
      return respond(res.status, { error: await res.text() });
    }
    const data = await res.json();
    const fields = (data.fields || []).map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      options: f.type_config && f.type_config.options
        ? f.type_config.options.map((o) => o.name || o.label)
        : undefined,
    }));
    return respond(200, { fields });
  } catch (err) {
    return respond(500, { error: err.message });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body, null, 2),
  };
}

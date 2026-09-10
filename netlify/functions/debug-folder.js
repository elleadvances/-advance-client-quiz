// TEMPORARY DEBUG TOOL. Visit:
//   https://<your-site>.netlify.app/api/debug-folder?folderUrl=<drive folder link>
// Checks whether a plain Google API key can list a public Drive folder's
// contents (as opposed to exporting one already-known file, which is a
// different, more permissive operation). This settles whether our
// folder-lookup approach is technically possible with just an API key.
// Delete this file once things work.

exports.handler = async (event) => {
  const { GOOGLE_API_KEY } = process.env;
  const folderUrl = event.queryStringParameters && event.queryStringParameters.folderUrl;

  if (!GOOGLE_API_KEY) return respond(500, { error: "Missing GOOGLE_API_KEY." });
  if (!folderUrl) return respond(400, { error: "Pass ?folderUrl=<drive folder link>" });

  const match = folderUrl.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (!match) return respond(400, { error: "That doesn't look like a Drive folder link." });
  const folderId = match[1];

  const q = encodeURIComponent(`'${folderId}' in parents and mimeType = 'application/vnd.google-apps.document' and trashed = false`);
  const listUrl = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&key=${GOOGLE_API_KEY}`;

  try {
    const res = await fetch(listUrl);
    const bodyText = await res.text();
    return respond(200, { folderId, httpStatus: res.status, ok: res.ok, rawResponse: bodyText });
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

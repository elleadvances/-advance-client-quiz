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
// Google Doc file id we can export text from. Note: listing a folder's
// contents only works with an API key for folders we have broader access
// to -- a plain API key generally can't enumerate an arbitrary public
// folder's contents, only export an already-known file by id.
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

module.exports = { extractDriveFileId, extractDriveFolderId, resolveDocFileId, fetchDocText };

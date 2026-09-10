# AdVance Client Questionnaire Quiz

A quiz site for the team: pick a PM (or "All Clients") and get a multiple-choice
quiz built live from that PM's active clients' onboarding questionnaire answers.

## How it works

1. You pick a PM (or All Clients) on the site.
2. A Netlify function pulls every task from your clients list in ClickUp,
   keeps only the ones marked active with a "WIP Master Doc" link filled in,
   and (if you picked a specific PM) filters to that PM's clients.
3. For each client, it opens their WIP Master Doc (a Google Doc, publicly
   viewable via link) and pulls the text.
4. It sends those docs to Claude, which finds the client's actual
   questionnaire/GHL-form answers inside the doc (ignoring production notes,
   scripts, etc. mixed into the same doc) and rephrases them into
   multiple-choice questions with plausible wrong answers.
5. The site shows the quiz one question at a time, then a score + per-client
   breakdown.

Nothing is stored — every quiz is generated fresh from live ClickUp + Google
Docs data.

**Note on accuracy:** because the questionnaire isn't in its own field or
tab consistently, Claude is doing the work of finding the right section
inside each doc. This works well when the questionnaire answers read
distinctly from internal notes (which they usually do), but it's not a hard
guarantee the way a dedicated field would be. If quiz quality is ever off,
say so and we can look at tightening this up.

## One-time setup

### 1. Get a ClickUp API token
ClickUp → your avatar (bottom left) → **Settings** → **Apps** → **API Token**.
Copy it — it starts with `pk_`.

### 2. Find your client list ID
Open the ClickUp list where your clients live as tasks. The list ID is the
number in the URL: `https://app.clickup.com/12345/v/li/900100200300` → the ID
is `900100200300`.

### 3. Get a Google API key (for reading the WIP Master Docs)
Since the docs are shared as "anyone with the link," you only need a plain
API key — no Google login/OAuth setup required.
- Go to [console.cloud.google.com](https://console.cloud.google.com), create
  a project (or use an existing one).
- **APIs & Services → Library** → search "Google Drive API" → **Enable**.
- **APIs & Services → Credentials** → **Create Credentials → API key**.
- Optional but recommended: click the new key → restrict it to the "Google
  Drive API" only, so it can't be used for anything else if it ever leaks.

### 4. Get an Anthropic API key
Go to [console.anthropic.com](https://console.anthropic.com), sign in, and
generate an API key.

### 5. Deploy to Netlify
- Push this folder to a GitHub repo (or drag-and-drop the folder into
  Netlify's "Deploy manually" upload).
- In Netlify: **Site settings → Environment variables**, add:

  | Variable | Value |
  |---|---|
  | `CLICKUP_API_TOKEN` | your token from step 1 |
  | `CLICKUP_LIST_ID` | your list ID from step 2 |
  | `CLICKUP_PM_FIELD_ID` | see step 6 |
  | `CLICKUP_DOC_FIELD_ID` | see step 6 (the "WIP Master Doc" field) |
  | `CLICKUP_ACTIVE_STATUSES` | comma-separated ClickUp status names that count as "active" (default: `active`) |
  | `GOOGLE_API_KEY` | your key from step 3 |
  | `ANTHROPIC_API_KEY` | your key from step 4 |

- Deploy the site.

### 6. Find your two ClickUp field IDs
Once deployed with just `CLICKUP_API_TOKEN` and `CLICKUP_LIST_ID` set, visit:

```
https://<your-site>.netlify.app/api/list-fields
```

This lists every custom field on your list with its ID, name, and type.
Find the PM field and the "WIP Master Doc" field, copy their `id` values
into `CLICKUP_PM_FIELD_ID` and `CLICKUP_DOC_FIELD_ID` in Netlify's
environment variables, then redeploy.

Once that's done you can delete `netlify/functions/list-fields.js` — it's
only needed for this lookup.

### 7. Match the PM values exactly
The PM picker on the site sends "Aldrin", "Alexis", "Ann", or "Liz" — make
sure those match how the PM field is actually filled in on your ClickUp
tasks (e.g. if the field stores "Aldrin R." instead of "Aldrin", either
update the field values in ClickUp or edit the `data-pm` attributes in
`index.html` to match).

## Notes / things worth knowing

- **"Active" clients**: this checks the ClickUp task **status** name against
  `CLICKUP_ACTIVE_STATUSES`. If your active clients use a status other than
  literally "Active" (e.g. "Onboarding", "In Progress"), set that env var to
  a comma-separated list, e.g. `active,onboarding`.
- **Doc sharing**: if a client's WIP Master Doc sharing ever gets changed
  from "anyone with the link" to restricted, that client's doc will silently
  fail to load and just be skipped from the quiz rather than breaking it.
- **Doc length**: very long docs are truncated at ~15,000 characters before
  being sent to Claude, to keep things fast and affordable. If a client's
  questionnaire tab happens to sit past that point in a very long doc, it
  might get missed — flag it if you notice a client never shows up in quizzes.
- **Cost**: each quiz load makes one Anthropic API call sized to the number
  of clients being quizzed — trivial cost for occasional team use.
- **No caching**: every click on a PM re-fetches ClickUp + Google Docs and
  regenerates the quiz, so it's always current, but also always takes a few
  seconds to load. If that gets annoying, this would be the first thing to add.

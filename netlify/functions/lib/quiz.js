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

module.exports = { generateQuiz, shuffle };

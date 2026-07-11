const SUPABASE_URL = "https://ayrwgcunucjncahxiklt.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function verifyToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization;
  if (!auth || !auth.startsWith("Bearer ")) return false;

  const token = auth.slice(7);
  const response = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + token,
    },
  });

  return response.ok;
}

export default async function handler(req, res) {
  if (!(await verifyToken(req))) {
    return res.status(401).send("Unauthorized");
  }

  // Read-only: fetch the whole portfolio. No writes anywhere in this teller.
  const loansResponse = await fetch(SUPABASE_URL + "/rest/v1/Loan?select=*", {
    method: "GET",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + SUPABASE_KEY,
    },
  });

  if (!loansResponse.ok) {
    const errorBody = await loansResponse.text();
    console.error("Supabase loan fetch failed", {
      status: loansResponse.status,
      error: errorBody,
    });
    return res.status(500).send("Loan lookup failed");
  }

  const loans = await loansResponse.json();

  // Late loans only. Filtering here means a current loan can never reach the
  // model, so the call-list is structurally guaranteed to hold zero current
  // loans. Rank by balance (highest exposure first) — there is no days-late
  // column, so balance is our proxy for urgency.
  const lateLoans = (Array.isArray(loans) ? loans : [])
    .filter((loan) => loan.status === "late")
    .sort((a, b) => b.balance - a.balance);

  // Nothing to call — return an empty list without spending a model call.
  if (lateLoans.length === 0) {
    return res.status(200).json({ triage: [] });
  }

  const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system:
        "You are a loan-servicing manager triaging past-due mortgages into a prioritized call list for your team. " +
        "You will be given the portfolio's late loans, already ordered from highest balance to lowest. " +
        "Rank them from highest balance to lowest balance: with no days-past-due field available, the outstanding balance is our proxy for exposure and the order in which we should place calls. " +
        "For each loan, write one short reason for the call in the voice of a real servicer — compliant, kind but firm. " +
        "Never threaten the borrower, never manufacture urgency, and never invent any amount, date, days-late count, fee, or consequence. " +
        "Respond with JSON only. No prose, no explanation, no markdown, and no code fences. " +
        "The JSON must be an array, already sorted highest balance first, where each element is an object with exactly these keys: " +
        "rank (a number starting at 1), id (the loan's ID), borrower (the borrower's name), balance (the numeric balance), and reason (your one-sentence call reason). " +
        "Include every late loan I give you exactly once, and never include any loan that is not in the list I provide.",
      messages: [
        {
          role: "user",
          content:
            "Here are the late loans to triage, ordered highest balance first:\n" +
            JSON.stringify(lateLoans, null, 2),
        },
      ],
    }),
  });

  if (!aiResponse.ok) {
    const errorBody = await aiResponse.text();
    console.error("Anthropic request failed", {
      status: aiResponse.status,
      error: errorBody,
    });
    return res.status(500).send("Triage request failed");
  }

  const data = await aiResponse.json();
  const text = data.content[0].text;

  // The model is told to return JSON only; strip any stray code fences just in
  // case, then parse. If it isn't valid JSON, surface a 500 rather than hand
  // the browser something it can't draw.
  let triage;
  try {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    triage = JSON.parse(cleaned);
  } catch (err) {
    console.error("Triage response was not valid JSON", { text });
    return res.status(500).send("Triage response was not valid JSON");
  }

  return res.status(200).json({ triage });
}

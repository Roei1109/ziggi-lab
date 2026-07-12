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

// Whole days from a loan's due date to the portfolio's as-of date. Computed in
// code so the model never has to do date math. Returns null if either date is
// missing or unparseable — we never guess a number.
function computeDaysLate(asOfDate, dueDate) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const asOf = Date.parse(asOfDate);
  const due = Date.parse(dueDate);
  if (Number.isNaN(asOf) || Number.isNaN(due)) return null;
  return Math.round((asOf - due) / MS_PER_DAY);
}

export default async function handler(req, res) {
  if (!(await verifyToken(req))) {
    return res.status(401).send("Unauthorized");
  }

  // Read-only: the portfolio carries a single as-of date that anchors every
  // lateness calculation. Without it we cannot compute days late, so bail.
  const portfolioResponse = await fetch(
    SUPABASE_URL + "/rest/v1/Portfolio?select=as_of_date&limit=1",
    {
      method: "GET",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + SUPABASE_KEY,
      },
    }
  );

  if (!portfolioResponse.ok) {
    const errorBody = await portfolioResponse.text();
    console.error("Supabase portfolio fetch failed", {
      status: portfolioResponse.status,
      error: errorBody,
    });
    return res.status(500).send("Portfolio lookup failed");
  }

  const portfolioRows = await portfolioResponse.json();
  const asOfDate = Array.isArray(portfolioRows) ? portfolioRows[0]?.as_of_date : null;
  if (!asOfDate) {
    console.error("Portfolio as_of_date missing");
    return res.status(500).send("Portfolio as-of date missing");
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
  // loans. Days late is computed in code from the portfolio's as-of date, then
  // used to rank: most days late first, with balance breaking ties.
  const sortKey = (loan) => (loan.days_late === null ? -Infinity : loan.days_late);
  const lateLoans = (Array.isArray(loans) ? loans : [])
    .filter((loan) => loan.status === "late")
    .map((loan) => ({
      ...loan,
      days_late: computeDaysLate(asOfDate, loan.due_date),
    }))
    .sort((a, b) => sortKey(b) - sortKey(a) || b.balance - a.balance);

  // Nothing to call — return an empty list without spending a model call.
  if (lateLoans.length === 0) {
    return res.status(200).json({ triage: [] });
  }

  // Hand the model finished numbers only. A NULL overdue amount is sent as the
  // string "unknown" so it can never be read — or printed — as 0.
  const loansForModel = lateLoans.map((loan, index) => ({
    order: index + 1,
    id: loan.id,
    borrower: loan.borrower,
    balance: loan.balance,
    days_late: loan.days_late,
    overdue_amount:
      loan.overdue_amount === null || loan.overdue_amount === undefined
        ? "unknown"
        : loan.overdue_amount,
  }));

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
        "You will be given the portfolio's late loans in the final call order — most days past due first, with the outstanding balance breaking ties. " +
        "The days_late value on each loan is already computed for you; treat it as final truth. " +
        "Keep the loans in exactly the order given and number them from 1. Do not re-sort them and do not recompute anything. " +
        "For each loan, write one short reason for the call in the voice of a real servicer — compliant, kind but firm. " +
        "You may refer to how many days past due the loan is using its days_late value. " +
        "If overdue_amount is the string \"unknown\", do not state any dollar figure for that loan; never write it as 0 or guess it. " +
        "Never threaten the borrower, never manufacture urgency, and never invent any amount, date, days-late count, fee, or consequence. " +
        "Respond with JSON only. No prose, no explanation, no markdown, and no code fences. " +
        "The JSON must be an array, in the same order I gave you, where each element is an object with exactly these keys: " +
        "rank (a number starting at 1), id (the loan's ID), borrower (the borrower's name), balance (the numeric balance), and reason (your one-sentence call reason). " +
        "Include every late loan I give you exactly once, and never include any loan that is not in the list I provide.",
      messages: [
        {
          role: "user",
          content:
            "Here are the late loans to triage, already in final call order (most days past due first):\n" +
            JSON.stringify(loansForModel, null, 2),
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

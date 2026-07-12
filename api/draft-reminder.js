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

  const { id } = req.body || {};
  if (id === undefined || id === null || String(id).trim() === "") {
    return res.status(400).send("Missing loan id");
  }

  // Read-only: fetch the one loan. No writes anywhere in this teller.
  const loanResponse = await fetch(
    SUPABASE_URL +
      "/rest/v1/Loan?select=*&id=eq." +
      encodeURIComponent(String(id).trim()),
    {
      method: "GET",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + SUPABASE_KEY,
      },
    }
  );

  if (!loanResponse.ok) {
    const errorBody = await loanResponse.text();
    console.error("Supabase loan lookup failed", {
      status: loanResponse.status,
      error: errorBody,
    });
    return res.status(500).send("Loan lookup failed");
  }

  const loans = await loanResponse.json();
  const loan = Array.isArray(loans) ? loans[0] : null;

  if (!loan) {
    return res.status(404).send("loan not found");
  }

  if (loan.status !== "late") {
    return res.status(400).send("loan is current");
  }

  // Read-only: the portfolio's single as-of date anchors the lateness math.
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

  // Finished numbers, computed here. Days late always comes from code. A NULL
  // overdue amount keeps its bracket placeholder — it must never print as 0.
  const daysLate = computeDaysLate(asOfDate, loan.due_date);
  const daysLateText = daysLate === null ? "[DAYS LATE]" : String(daysLate);
  const hasOverdue =
    loan.overdue_amount !== null && loan.overdue_amount !== undefined;
  const overdueText = hasOverdue
    ? "$" + Number(loan.overdue_amount).toLocaleString()
    : "[OVERDUE AMOUNT]";

  const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system:
        "You are a loan-servicing manager writing a personal payment-reminder letter to one borrower whose mortgage is past due. " +
        "Write it the way a real manager would: professional, empathetic, and clear, in flowing paragraphs of plain, simple language — no manufactured urgency, options rather than ultimatums. " +
        "Do not use a bulleted or labeled list of loan details; instead work every detail naturally into your sentences, " +
        "the way you would if you were explaining the borrower's situation to them out loud. " +
        "Your single most important goal is that the borrower quickly understands where their loan stands and exactly how to bring it up to date. " +
        "Every letter must, in the course of the prose, name the borrower, refer to their loan by its ID, state the overdue amount, " +
        "say how many days the payment is past due, and offer three ways to get in touch or resolve it: by phone, by email, or by mail. " +
        "I am giving you the exact overdue amount and the exact number of days past due; use those values verbatim in your sentences and never change, round, or recompute them. " +
        "If either value is given to you as bracketed text such as [OVERDUE AMOUNT] or [DAYS LATE], reproduce that bracket text exactly and never replace, fill in, estimate, or guess it. " +
        "Never invent any other numbers, amounts, dates, or counts of any kind. " +
        "You may include the sentence 'Late fees may apply per your loan terms' — but never state a specific fee amount, penalty figure, or consequence, and never threaten the borrower. " +
        "Keep the tone professional and considerate throughout. " +
        "Write only the letter itself, as plain readable text with no markdown, asterisks, headings, or other formatting symbols.",
      messages: [
        {
          role: "user",
          content:
            "Please write the payment-reminder letter for this borrower. " +
            "The borrower's name is " +
            loan.borrower +
            " and their loan is identified as " +
            loan.id +
            ". " +
            "The overdue amount is " +
            overdueText +
            " and the payment is " +
            daysLateText +
            " days past due. " +
            "Use those two values exactly as written where they belong in your sentences.",
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
    return res.status(500).send("Draft request failed");
  }

  const data = await aiResponse.json();
  const draft = data.content[0].text;

  return res.status(200).json({ draft });
}

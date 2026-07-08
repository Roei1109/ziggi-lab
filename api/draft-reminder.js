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
        "You draft a payment-reminder email for a single late mortgage loan on behalf of a loan servicer. " +
        "The draft MUST include all of the following: the borrower's name, the loan ID, the overdue amount, " +
        "how many days the loan is late, and a clear next step for the borrower (how to contact the servicer or make a payment). " +
        "You are given the borrower's name and loan ID, but you are NOT given the overdue amount or the number of days late. " +
        "For those two values, insert the literal placeholders [OVERDUE AMOUNT] and [DAYS LATE] exactly so a servicer can fill them in. " +
        "Never invent, estimate, or guess any numbers, amounts, dates, or counts. " +
        "Do NOT mention fees, penalties, or consequences, and do not make any threats. " +
        "Keep the tone professional and courteous. Output only the email text.",
      messages: [
        {
          role: "user",
          content:
            "Draft the payment-reminder email for this late loan:\n" +
            "Borrower: " +
            loan.borrower +
            "\nLoan ID: " +
            loan.id +
            "\nStatus: " +
            loan.status,
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

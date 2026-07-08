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
        "You are a loan-servicing manager writing a personal payment-reminder letter to one borrower whose mortgage is past due. " +
        "Write it the way a real manager would: warm, direct, and human, in flowing paragraphs of ordinary prose. " +
        "Do not use a bulleted or labeled list of loan details; instead work every detail naturally into your sentences, " +
        "the way you would if you were explaining the borrower's situation to them out loud. " +
        "Your single most important goal is that the borrower quickly understands where their loan stands and exactly how to bring it up to date. " +
        "Every letter must, in the course of the prose, name the borrower, refer to their loan by its ID, state the overdue amount, " +
        "say how many days the payment is past due, and give one clear next step for making the payment or reaching your office. " +
        "You know the borrower's name and their loan ID, but you do NOT know the overdue amount or the number of days past due. " +
        "Wherever those two values belong in your sentences, write the literal text [OVERDUE AMOUNT] and [DAYS LATE] exactly as shown, " +
        "and never replace, fill in, estimate, or guess them. " +
        "Never invent any numbers, amounts, dates, or counts of any kind. " +
        "Do not mention fees, penalties, or consequences, and never threaten the borrower. " +
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
            "Remember that you do not know the overdue amount or the number of days past due, " +
            "so use the placeholders [OVERDUE AMOUNT] and [DAYS LATE] verbatim where those belong.",
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

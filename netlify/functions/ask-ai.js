const SUPABASE_URL = "https://ayrwgcunucjncahxiklt.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function verifyToken(event) {
  const auth = event.headers.authorization || event.headers.Authorization;
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

exports.handler = async (event) => {
  if (!(await verifyToken(event))) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  const { question } = JSON.parse(event.body);
  if (!question || question.trim() === "") {
    return { statusCode: 400, body: "Missing question" };
  }

  const loansResponse = await fetch(SUPABASE_URL + "/rest/v1/Loan?select=*", {
    method: "GET",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + SUPABASE_KEY,
    },
  });

  const loans = await loansResponse.json();

  const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system:
        "You answer questions about a mortgage loan servicing portfolio. Use only the loan data provided. Be concise and accurate.",
      messages: [
        {
          role: "user",
          content:
            "Loan data:\n" +
            JSON.stringify(loans, null, 2) +
            "\n\nQuestion: " +
            question.trim(),
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
    return { statusCode: 500, body: "AI request failed" };
  }

  const data = await aiResponse.json();
  const answer = data.content[0].text;

  return { statusCode: 200, body: JSON.stringify({ answer }) };
};

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

// ---- The tool menu. Both tools are read-only; nothing here writes. ----

const TOOLS = [
  {
    name: "get_loans",
    description:
      "Return every loan row in the servicing portfolio as JSON. Use this " +
      "for anything about individual loans — borrowers, balances, statuses, " +
      "due dates, overdue amounts, counts.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_portfolio_date",
    description:
      "Return the portfolio's as_of_date — the single date the whole " +
      "portfolio is measured against. Use this when the question depends on " +
      "what 'today' or 'now' means for the portfolio.",
    input_schema: { type: "object", properties: {} },
  },
];

// Read-only: fetch every loan row.
async function getLoans() {
  const response = await fetch(SUPABASE_URL + "/rest/v1/Loan?select=*", {
    method: "GET",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + SUPABASE_KEY,
    },
  });
  if (!response.ok) {
    throw new Error("Loan lookup failed (" + response.status + ")");
  }
  return await response.json();
}

// Read-only: fetch the single Portfolio row's as-of date.
async function getPortfolioDate() {
  const response = await fetch(
    SUPABASE_URL + "/rest/v1/Portfolio?select=as_of_date&limit=1",
    {
      method: "GET",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + SUPABASE_KEY,
      },
    }
  );
  if (!response.ok) {
    throw new Error("Portfolio lookup failed (" + response.status + ")");
  }
  const rows = await response.json();
  const asOfDate = Array.isArray(rows) ? rows[0]?.as_of_date ?? null : null;
  return { as_of_date: asOfDate };
}

const TOOL_IMPL = {
  get_loans: getLoans,
  get_portfolio_date: getPortfolioDate,
};

// The model may only ask for these — its tool requests are untrusted input.
const TOOL_MENU = new Set(Object.keys(TOOL_IMPL));

// Hard ceiling on model calls for a single question.
const MAX_LAPS = 5;

const SYSTEM_PROMPT =
  "You answer questions about a mortgage loan servicing portfolio. " +
  "You may not use any prior knowledge or assumptions — answer ONLY from what the tools return. " +
  "You have two tools: get_loans (returns all loan rows) and get_portfolio_date (returns the portfolio's as_of_date). " +
  "Call the tools you need, then answer in plain language. " +
  "Always name which source your answer came from (the loan rows, the portfolio as-of date, or both). " +
  "If the tools cannot answer the question, say so plainly — do not guess or invent an answer.";

export default async function handler(req, res) {
  if (!(await verifyToken(req))) {
    return res.status(401).send("Unauthorized");
  }

  const { question } = req.body || {};
  if (!question || question.trim() === "") {
    return res.status(400).send("Missing question");
  }

  // The running conversation. The model drives; the harness executes tools.
  const messages = [{ role: "user", content: question.trim() }];

  for (let lap = 1; lap <= MAX_LAPS; lap++) {
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
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      }),
    });

    if (!aiResponse.ok) {
      const errorBody = await aiResponse.text();
      console.error("Anthropic request failed", {
        status: aiResponse.status,
        error: errorBody,
      });
      return res.status(500).send("AI request failed");
    }

    const data = await aiResponse.json();
    const toolUses = (data.content || []).filter(
      (block) => block.type === "tool_use"
    );

    // Log every lap: which lap, and what tools the model asked for this lap.
    console.log("ask-ai lap", {
      lap,
      tools: toolUses.map((t) => t.name),
    });

    // No tool requested — the model has its answer.
    if (data.stop_reason !== "tool_use") {
      const textBlock = (data.content || []).find(
        (block) => block.type === "text"
      );
      const answer = textBlock ? textBlock.text : "";
      return res.status(200).json({ answer });
    }

    // The model wants tools. Validate every requested name against the menu
    // BEFORE executing anything — an unknown name is a hard failure.
    for (const toolUse of toolUses) {
      if (!TOOL_MENU.has(toolUse.name)) {
        console.error("ask-ai unknown tool requested", { name: toolUse.name });
        return res.status(500).send("Unknown tool requested");
      }
    }

    // Execute the (now-validated) tools and collect their results.
    const toolResults = [];
    for (const toolUse of toolUses) {
      let result;
      try {
        result = await TOOL_IMPL[toolUse.name]();
      } catch (err) {
        console.error("ask-ai tool execution failed", {
          name: toolUse.name,
          error: err.message,
        });
        return res.status(500).send("Tool execution failed");
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      });
    }

    // Accumulate the assistant's turn (including its tool_use blocks) and our
    // tool_result turn, then loop for the next model call.
    messages.push({ role: "assistant", content: data.content });
    messages.push({ role: "user", content: toolResults });
  }

  // Ran out of laps without the model settling on an answer.
  console.error("ask-ai agent exceeded lap limit", { laps: MAX_LAPS });
  return res.status(500).send("agent exceeded lap limit");
}

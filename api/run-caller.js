const SUPABASE_URL = "https://ayrwgcunucjncahxiklt.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Every write in this file carries this fixed author. The agent never chooses
// it — the drafter is always the caller agent, never the human's token.
const DRAFTED_BY = "caller-agent";

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
// missing or unparseable — we never guess a number. (Same rule as the other
// tellers: a bracket placeholder stands in, never a fabricated 0.)
function computeDaysLate(asOfDate, dueDate) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const asOf = Date.parse(asOfDate);
  const due = Date.parse(dueDate);
  if (Number.isNaN(asOf) || Number.isNaN(due)) return null;
  return Math.round((asOf - due) / MS_PER_DAY);
}

// ---- The tool menu the model may order from. ----
//
// get_queued_loans is the ONLY path to a loan: it reads the queue flag, so a
// loan the human never approved is structurally unreachable. draft_outreach
// and record_contact both re-check that flag before touching anything, so even
// a misfired order can never reach an unqueued loan.
const TOOLS = [
  {
    name: "get_queued_loans",
    description:
      "Return every loan currently queued for contact (queued_for_contact = " +
      "true) as JSON. This is the only way to see which loans to act on — a " +
      "loan that is not queued is not yours to touch.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "draft_outreach",
    description:
      "Produce the outreach text (a short reminder email and a matching phone " +
      "call script) for ONE queued loan. Pass the loan_id. Returns the drafted " +
      "text; it does not save anything.",
    input_schema: {
      type: "object",
      properties: {
        loan_id: {
          type: "string",
          description: "The id of the queued loan to draft outreach for.",
        },
      },
      required: ["loan_id"],
    },
  },
  {
    name: "record_contact",
    description:
      "Save the outreach draft against ONE queued loan and dequeue it: inserts " +
      "one contact row and sets that loan's queued_for_contact flag back to " +
      "false. You must call draft_outreach for the loan first; then call this " +
      "with the loan_id only — the draft is held for you and looked up by id. " +
      "Each loan may be recorded at most once per run.",
    input_schema: {
      type: "object",
      properties: {
        loan_id: {
          type: "string",
          description: "The id of the queued loan to record contact for.",
        },
      },
      required: ["loan_id"],
    },
  },
];

// Read-only: fetch the loans whose queue flag is set. The filter lives in the
// query, so unqueued loans never leave the database.
async function getQueuedLoans() {
  const response = await fetch(
    SUPABASE_URL + "/rest/v1/Loan?select=*&queued_for_contact=is.true",
    {
      method: "GET",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + SUPABASE_KEY,
      },
    }
  );
  if (!response.ok) {
    throw new Error("Queued-loan lookup failed (" + response.status + ")");
  }
  return await response.json();
}

// Read-only: fetch one loan by id, but only if it is still queued. Returns null
// when the loan is missing or not queued — the caller turns that into a plain
// message back to the model rather than a crash.
async function fetchQueuedLoan(loanId) {
  const response = await fetch(
    SUPABASE_URL +
      "/rest/v1/Loan?select=*&queued_for_contact=is.true&id=eq." +
      encodeURIComponent(String(loanId).trim()),
    {
      method: "GET",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + SUPABASE_KEY,
      },
    }
  );
  if (!response.ok) {
    throw new Error("Loan lookup failed (" + response.status + ")");
  }
  const rows = await response.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

// Read-only: the portfolio's single as-of date anchors the lateness math, just
// like triage and draft-reminder. Returns null if it cannot be read.
async function fetchAsOfDate() {
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
  return Array.isArray(rows) ? rows[0]?.as_of_date ?? null : null;
}

// Tool: draft outreach for one queued loan. Grounds the model with finished
// numbers (days late computed here, overdue amount passed verbatim or bracketed)
// exactly as draft-reminder does, then returns the drafted text. No writes.
async function draftOutreach(input, ctx) {
  const loanId = input && input.loan_id;
  if (loanId === undefined || loanId === null || String(loanId).trim() === "") {
    return { error: "draft_outreach requires a loan_id." };
  }

  const loan = await fetchQueuedLoan(loanId);
  if (!loan) {
    // Either the loan does not exist or it is not queued — the gate is closed.
    return {
      error:
        "Loan " +
        loanId +
        " is not queued for contact; there is nothing to draft.",
    };
  }

  const asOfDate = await fetchAsOfDate();
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
        "You are a loan-servicing manager preparing outreach to one borrower whose mortgage is past due. " +
        "Produce two things in plain text: first a short, warm, professional reminder email, then a brief phone call script the servicer can read aloud. " +
        "Label them exactly 'EMAIL:' and 'CALL SCRIPT:' on their own lines, with nothing else before the first label. " +
        "Write in flowing, simple language — no manufactured urgency, options rather than ultimatums, no threats. " +
        "Both pieces must name the borrower, refer to the loan by its ID, state the overdue amount, say how many days past due the payment is, and offer to resolve it by phone, email, or mail. " +
        "I am giving you the exact overdue amount and the exact number of days past due; use those values verbatim and never change, round, or recompute them. " +
        "If either value is given as bracketed text such as [OVERDUE AMOUNT] or [DAYS LATE], reproduce that bracket text exactly and never fill it in, estimate, or guess it. " +
        "Never invent any other numbers, amounts, dates, or counts. You may say 'Late fees may apply per your loan terms' but never state a specific fee, penalty, or consequence. " +
        "Write only the email and the call script as plain readable text with no markdown, asterisks, or headings beyond the two labels.",
      messages: [
        {
          role: "user",
          content:
            "Please write the outreach for this borrower. " +
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
            "Use those two values exactly as written where they belong.",
        },
      ],
    }),
  });

  if (!aiResponse.ok) {
    const errorBody = await aiResponse.text();
    console.error("Anthropic draft_outreach failed", {
      status: aiResponse.status,
      error: errorBody,
    });
    throw new Error("draft_outreach model call failed");
  }

  const data = await aiResponse.json();
  const textBlock = (data.content || []).find((block) => block.type === "text");
  const draft_text = textBlock ? textBlock.text : "";

  // The draft lives in the harness, never in the model's mouth. We store it
  // keyed by loan id and hand the model only a receipt — so record_contact can
  // recover the exact text without the model re-typing (or altering) it.
  ctx.drafts.set(String(loan.id), draft_text);

  return { loan_id: loan.id, borrower: loan.borrower, drafted: true };
}

// Tool: record contact for one queued loan. This is the ONLY write in the run.
// It is idempotent two ways — the harness refuses a second record_contact for
// the same loan within this run (via ctx.recorded), and the loan must still be
// queued in the database, which the insert-then-dequeue makes false. So a
// repeat order finds the gate already closed.
async function recordContact(input, ctx) {
  const loanId = input && input.loan_id;

  if (loanId === undefined || loanId === null || String(loanId).trim() === "") {
    return { error: "record_contact requires a loan_id." };
  }

  const key = String(loanId).trim();

  // Within-run idempotency: one record_contact per loan per run.
  if (ctx.recorded.has(key)) {
    return {
      error:
        "Loan " + loanId + " was already contacted in this run — skipping.",
    };
  }

  // The draft is held by the harness, keyed by loan id. The model never carries
  // the text; if it never drafted this loan, there is nothing to record.
  const draftText = ctx.drafts.get(key);
  if (!draftText || String(draftText).trim() === "") {
    return {
      error: "No draft exists for loan " + loanId + " — call draft_outreach first.",
    };
  }

  // Database gate: the loan must still be queued. record_contact dequeues, so
  // this is false on any repeat, and it can never reach an unapproved loan.
  const loan = await fetchQueuedLoan(loanId);
  if (!loan) {
    return {
      error:
        "Loan " +
        loanId +
        " is not queued for contact; there is nothing to record.",
    };
  }

  // Insert exactly one contact row. drafted_by is fixed, never model-supplied.
  const insertResponse = await fetch(SUPABASE_URL + "/rest/v1/Contact", {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      loan_id: loan.id,
      draft_text: String(draftText),
      drafted_by: DRAFTED_BY,
    }),
  });

  if (!insertResponse.ok) {
    const errorBody = await insertResponse.text();
    console.error("Supabase contact insert failed", {
      status: insertResponse.status,
      error: errorBody,
    });
    throw new Error("record_contact insert failed");
  }

  // Mark this loan recorded BEFORE the dequeue so a failure below still blocks
  // a duplicate insert within the run.
  ctx.recorded.add(key);

  // Set the queue flag back to false for this loan only — "contacted, dequeued".
  // A plain set to false, never a toggle, and scoped to this single id.
  const dequeueResponse = await fetch(
    SUPABASE_URL +
      "/rest/v1/Loan?id=eq." +
      encodeURIComponent(String(loan.id)),
    {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ queued_for_contact: false }),
    }
  );

  if (!dequeueResponse.ok) {
    const errorBody = await dequeueResponse.text();
    console.error("Supabase dequeue update failed", {
      status: dequeueResponse.status,
      error: errorBody,
    });
    throw new Error("record_contact dequeue failed");
  }

  const rows = await insertResponse.json();
  const row = Array.isArray(rows) ? rows[0] : rows;
  return {
    recorded: true,
    loan_id: loan.id,
    contact_id: row ? row.id : null,
    dequeued: true,
  };
}

const TOOL_IMPL = {
  get_queued_loans: (_input, _ctx) => getQueuedLoans(),
  draft_outreach: (input, ctx) => draftOutreach(input, ctx),
  record_contact: (input, ctx) => recordContact(input, ctx),
};

// The model may only ask for these — its tool requests are untrusted input.
const TOOL_MENU = new Set(Object.keys(TOOL_IMPL));

// Hard ceiling on model calls for a single run. Higher than ask-ai's 5 because
// one run may work through several queued loans (read, draft, record each).
const MAX_LAPS = 15;

const SYSTEM_PROMPT =
  "You are the caller agent for a mortgage loan servicing team. Your job in one run is to produce outreach for every loan that has been approved and queued for contact. " +
  "Work like this: first call get_queued_loans to see the queue. Then, for each queued loan, call draft_outreach to write its email and call script, and then call record_contact with that loan_id only — the draft is held for you and saved by id — to record it and dequeue the loan. " +
  "Contact each queued loan exactly once. If get_queued_loans returns an empty list, there is nothing to do — say so and stop. " +
  "You may only act through these tools; you cannot read or change anything else. When every queued loan has been recorded, stop and give a short plain-language summary of how many loans you contacted.";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Invariant 3: verify the token before anything else.
  if (!(await verifyToken(req))) {
    return res.status(401).send("Unauthorized");
  }

  // Per-run context. recorded enforces one record_contact per loan per run;
  // drafts holds each loan's outreach text (keyed by id) so record_contact can
  // recover it without the model ever re-typing the draft.
  const ctx = { recorded: new Set(), drafts: new Map() };

  // The running conversation. The model drives; the harness executes tools.
  const messages = [
    {
      role: "user",
      content:
        "Run the caller: contact every loan currently queued for contact.",
    },
  ];

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
        max_tokens: 4096,
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
    console.log("run-caller lap", {
      lap,
      tools: toolUses.map((t) => t.name),
    });

    // Truncated reply — the model ran into its token ceiling mid-thought. Do
    // not treat a cut-off turn as a finished answer; fail honestly.
    if (data.stop_reason === "max_tokens") {
      console.error("run-caller reply truncated", { lap });
      return res.status(500).send("Model reply truncated");
    }

    // No tool requested — the model is done; return its closing summary.
    if (data.stop_reason !== "tool_use") {
      const textBlock = (data.content || []).find(
        (block) => block.type === "text"
      );
      const summary = textBlock ? textBlock.text : "";
      return res.status(200).json({
        summary,
        contacted: ctx.recorded.size,
      });
    }

    // The model wants tools. Validate every requested name against the menu
    // BEFORE executing anything — an unknown name is a hard failure.
    for (const toolUse of toolUses) {
      if (!TOOL_MENU.has(toolUse.name)) {
        console.error("run-caller unknown tool requested", {
          name: toolUse.name,
        });
        return res.status(500).send("Unknown tool requested");
      }
    }

    // Execute the (now-validated) tools and collect their results. A tool that
    // returns an {error:...} object is a soft failure — it goes back to the
    // model as a tool_result so it can adapt. Only infrastructure failures throw.
    const toolResults = [];
    for (const toolUse of toolUses) {
      let result;
      try {
        result = await TOOL_IMPL[toolUse.name](toolUse.input || {}, ctx);
      } catch (err) {
        console.error("run-caller tool execution failed", {
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

    // Accumulate the assistant's turn (with its tool_use blocks) and our
    // tool_result turn, then loop for the next model call.
    messages.push({ role: "assistant", content: data.content });
    messages.push({ role: "user", content: toolResults });
  }

  // Ran out of laps without the model settling. Whatever was recorded stands
  // (each write is committed as it happens); report how far it got.
  console.error("run-caller agent exceeded lap limit", {
    laps: MAX_LAPS,
    contacted: ctx.recorded.size,
  });
  return res.status(500).send("agent exceeded lap limit");
}

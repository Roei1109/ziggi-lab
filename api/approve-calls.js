const SUPABASE_URL = "https://ayrwgcunucjncahxiklt.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function verifyToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization;
  if (!auth || !auth.startsWith("Bearer ")) return null;

  const token = auth.slice(7);
  const response = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + token,
    },
  });

  if (!response.ok) return null;

  const user = await response.json();
  return user.email;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const approved_by = await verifyToken(req);
  if (!approved_by) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { call_list } = req.body || {};

  if (!Array.isArray(call_list) || call_list.length === 0) {
    return res.status(400).json({ error: "call_list must be a non-empty array" });
  }

  // Dedup the call list by loan id before recording — the same loan must never
  // be approved twice in one list. First occurrence wins; order is preserved.
  // Entries with no usable id fall through untouched.
  const seenIds = new Set();
  const deduped = [];
  for (const entry of call_list) {
    const rawId = entry && entry.id;
    const id =
      rawId === undefined || rawId === null ? "" : String(rawId).trim();
    if (id !== "") {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }
    deduped.push(entry);
  }

  const response = await fetch(SUPABASE_URL + "/rest/v1/Approval", {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ approved_by, call_list: deduped }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Supabase approval insert failed", {
      status: response.status,
      error: errorBody,
    });
    return res.status(500).json({ error: "Failed to record approval" });
  }

  // The approval is recorded. Now mark every loan on the approved call list as
  // queued for contact. Runs only after the insert above succeeded.
  const ids = deduped
    .map((entry) => entry && entry.id)
    .filter((id) => id !== undefined && id !== null && String(id).trim() !== "");

  if (ids.length > 0) {
    const idFilter = ids.map((id) => encodeURIComponent(String(id))).join(",");
    // PATCH sets queued_for_contact to true (never toggles, never increments)
    // and only on loans whose id is in the approved list — no other loan.
    const queueResponse = await fetch(
      SUPABASE_URL + "/rest/v1/Loan?id=in.(" + idFilter + ")",
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: "Bearer " + SUPABASE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ queued_for_contact: true }),
      }
    );

    if (!queueResponse.ok) {
      const errorBody = await queueResponse.text();
      console.error("Supabase queue-mark update failed", {
        status: queueResponse.status,
        error: errorBody,
      });
      return res.status(500).json({ error: "Failed to mark loans for contact" });
    }
  }

  const rows = await response.json();
  const row = Array.isArray(rows) ? rows[0] : rows;

  return res.status(200).json(row);
}

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

  const response = await fetch(SUPABASE_URL + "/rest/v1/Approval", {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ approved_by, call_list }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Supabase approval insert failed", {
      status: response.status,
      error: errorBody,
    });
    return res.status(500).json({ error: "Failed to record approval" });
  }

  const rows = await response.json();
  const row = Array.isArray(rows) ? rows[0] : rows;

  return res.status(200).json(row);
}

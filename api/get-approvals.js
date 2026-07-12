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

  // Read-only: fetch every approval, oldest first. Ordering happens in the
  // query itself so the browser can render straight down the list.
  const response = await fetch(
    SUPABASE_URL + "/rest/v1/Approval?select=*&order=created_at.asc",
    {
      method: "GET",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + SUPABASE_KEY,
      },
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Supabase approval fetch failed", {
      status: response.status,
      error: errorBody,
    });
    return res.status(500).send("Approval lookup failed");
  }

  const approvals = await response.json();
  return res.status(200).json(approvals);
}

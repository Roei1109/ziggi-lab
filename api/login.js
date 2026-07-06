const SUPABASE_URL = "https://ayrwgcunucjncahxiklt.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY;

export default async function handler(req, res) {
  const { email, password } = req.body;

  const response = await fetch(
    SUPABASE_URL + "/auth/v1/token?grant_type=password",
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    }
  );

  if (!response.ok) {
    return res.status(401).send("Invalid credentials");
  }

  const session = await response.json();
  return res.status(200).json({ access_token: session.access_token });
}

const SUPABASE_URL = "https://ayrwgcunucjncahxiklt.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY;

exports.handler = async (event) => {
  const { email, password } = JSON.parse(event.body);

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
    return { statusCode: 401, body: "Invalid credentials" };
  }

  const session = await response.json();
  return {
    statusCode: 200,
    body: JSON.stringify({ access_token: session.access_token }),
  };
};

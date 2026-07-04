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

  const response = await fetch(SUPABASE_URL + "/rest/v1/Loan?select=*", {
    method: "GET",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + SUPABASE_KEY,
    },
  });

  const loans = await response.json();
  return { statusCode: 200, body: JSON.stringify(loans) };
};

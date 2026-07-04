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

  const loan = JSON.parse(event.body);

  if (loan.id === "" || loan.borrower === "" || loan.balance <= 0 || Number.isNaN(loan.balance)) {
    return { statusCode: 400, body: "invalid loan" };
  }

  const response = await fetch(SUPABASE_URL + "/rest/v1/Loan", {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(loan),
  });

  return { statusCode: 200, body: "loan saved" };
};

const SUPABASE_URL = "https://ayrwgcunucjncahxiklt.supabase.co";
const SUPABASE_KEY = "sb_publishable_h_ZpRvOi8D9VQwpji3OzyA_H8kK9-JR";

exports.handler = async (event) => {
    const loan = JSON.parse(event.body);
  
    if (loan.id === "" || loan.borrower === "" || loan.balance <= 0 || Number.isNaN(loan.balance)) {
      return { statusCode: 400, body: "invalid loan" };
    }
    const response = await fetch(SUPABASE_URL + "/rest/v1/Loan", {
        method: "POST",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": "Bearer " + SUPABASE_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(loan)
      });
  
    return { statusCode: 200, body: "hello from the server" };
  }
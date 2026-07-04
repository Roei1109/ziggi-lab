const SUPABASE_URL = "https://ayrwgcunucjncahxiklt.supabase.co";
const SUPABASE_KEY = "sb_publishable_h_ZpRvOi8D9VQwpji3OzyA_H8kK9-JR";

exports.handler =  async (event) => {
    const response = await fetch(SUPABASE_URL + "/rest/v1/Loan?select=*", {
        method: "GET",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": "Bearer " + SUPABASE_KEY
        }
    });


  const loans = await response.json();
  return { statusCode: 200, body: JSON.stringify(loans) };   
 };
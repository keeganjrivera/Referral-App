import db from "../db.server";

export const action = async ({ request }) => {
  // This endpoint doesn't require Shopify admin authentication
  // It's called from the storefront by logged-in customers
  
  const formData = await request.formData();
  const customerEmail = formData.get("customerEmail");
  const friendEmails = formData.get("friendEmails"); // Comma-separated
  const referralCode = formData.get("referralCode");

  if (!customerEmail || !friendEmails || !referralCode) {
    return new Response(
      JSON.stringify({ success: false, message: "Missing required fields" }),
      { 
        status: 400,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  // Split and clean friend emails
  const emails = friendEmails
    .split(",")
    .map(email => email.trim())
    .filter(email => email && email.includes("@"));

  if (emails.length === 0) {
    return new Response(
      JSON.stringify({ success: false, message: "No valid email addresses provided" }),
      { 
        status: 400,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  // Send Klaviyo emails to each friend
  let successCount = 0;
  
  for (const friendEmail of emails) {
    try {
      const klaviyoResponse = await fetch('https://a.klaviyo.com/api/events/', {
        method: 'POST',
        headers: {
          'Authorization': `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
          'Content-Type': 'application/json',
          'revision': '2024-10-15'
        },
        body: JSON.stringify({
          data: {
            type: 'event',
            attributes: {
              profile: {
                email: friendEmail
              },
              metric: {
                name: 'Referral Invitation'
              },
              properties: {
                referral_code: referralCode,
                referrer_email: customerEmail,
                discount_percent: 10
              },
              time: new Date().toISOString()
            }
          }
        })
      });

      if (klaviyoResponse.ok) {
        successCount++;
        console.log(`Referral invitation sent to ${friendEmail} from ${customerEmail}`);
      } else {
        const errorText = await klaviyoResponse.text();
        console.error(`Failed to send invitation to ${friendEmail}: ${errorText}`);
      }
    } catch (error) {
      console.error(`Error sending invitation to ${friendEmail}:`, error);
    }
  }

  return new Response(
    JSON.stringify({ 
      success: true, 
      message: `Invitations sent to ${successCount} of ${emails.length} friends!` 
    }),
    { 
      status: 200,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*" // Allow from Shopify storefront
      }
    }
  );
};

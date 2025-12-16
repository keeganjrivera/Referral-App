import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { topic, shop, session, admin, payload } = await authenticate.webhook(request);

  if (!admin) {
    throw new Response();
  }

  const customer = payload;

  console.log(`[Customer Update] Webhook received for customer: ${customer.email || customer.id}`);

  // Get customer's referral code metafield
  const customerResponse = await admin.graphql(
    `#graphql
      query getCustomer($id: ID!) {
        customer(id: $id) {
          id
          email
          firstName
          lastName
          metafield(namespace: "custom", key: "referral_code") {
            value
          }
        }
      }`,
    {
      variables: {
        id: customer.admin_graphql_api_id
      }
    }
  );

  const customerJson = await customerResponse.json();
  const customerData = customerJson.data?.customer;
  const referralCode = customerData?.metafield?.value;

  // Only sync to Klaviyo if there's a referral code
  if (!referralCode) {
    console.log(`[Customer Update] No referral code found for customer: ${customer.email || customer.id}`);
    return new Response();
  }

  console.log(`[Customer Update] Syncing referral code "${referralCode}" to Klaviyo for ${customerData.email}`);

  // Send referral code to Klaviyo (create or update profile)
  try {
    const klaviyoResponse = await fetch('https://a.klaviyo.com/api/profile-import/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
        'Content-Type': 'application/json',
        'revision': '2025-10-15'
      },
      body: JSON.stringify({
        data: {
          type: 'profile',
          attributes: {
            email: customerData.email,
            first_name: customerData.firstName,
            last_name: customerData.lastName,
            properties: {
              referral_code: referralCode
            }
          }
        }
      })
    });

    if (klaviyoResponse.ok) {
      const klaviyoData = await klaviyoResponse.json();
      console.log(`[Customer Update] Successfully synced referral code to Klaviyo for ${customerData.email}`);
    } else {
      const errorText = await klaviyoResponse.text();
      console.error(`[Customer Update] Failed to sync to Klaviyo: ${klaviyoResponse.status} - ${errorText}`);
    }
  } catch (error) {
    console.error(`[Customer Update] Error syncing to Klaviyo:`, error);
  }

  return new Response();
};

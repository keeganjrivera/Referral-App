import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { topic, shop, session, admin, payload } = await authenticate.webhook(request);

  if (!admin) {
    throw new Response();
  }

  // Payload contains the subscription contract that was cancelled
  const subscription = payload;

  console.log("Subscription cancellation webhook:", JSON.stringify(subscription, null, 2));

  try {
    // Get the customer ID from the subscription
    const customerId = subscription.customer?.admin_graphql_api_id;

    if (!customerId) {
      console.log("No customer ID found in subscription payload");
      return new Response();
    }

    // Get the customer's referral code
    const customerResponse = await admin.graphql(
      `#graphql
        query getCustomer($id: ID!) {
          customer(id: $id) {
            id
            email
            metafield(namespace: "custom", key: "referral_code") {
              value
            }
          }
        }`,
      {
        variables: {
          id: customerId
        }
      }
    );

    const customerJson = await customerResponse.json();
    const customer = customerJson.data?.customer;
    const referralCode = customer?.metafield?.value;

    if (!referralCode) {
      console.log(`Customer ${customer?.email} has no referral code to deactivate`);
      return new Response();
    }

    console.log(`Subscription cancelled for ${customer.email}, deactivating referral code: ${referralCode}`);

    // Search for the discount code
    const discountSearchResponse = await admin.graphql(
      `#graphql
        query {
          codeDiscountNodes(first: 1, query: "title:'Referral - ${referralCode}'") {
            edges {
              node {
                id
                codeDiscount {
                  ... on DiscountCodeBasic {
                    title
                    codes(first: 1) {
                      edges {
                        node {
                          code
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }`
    );

    const discountJson = await discountSearchResponse.json();
    const discountNode = discountJson.data?.codeDiscountNodes?.edges?.[0]?.node;

    if (!discountNode) {
      console.log(`Discount code for ${referralCode} not found`);
      return new Response();
    }

    // Deactivate the discount code (set end date to now)
    const deactivateResponse = await admin.graphql(
      `#graphql
        mutation discountCodeBasicUpdate($id: ID!, $basicCodeDiscount: DiscountCodeBasicInput!) {
          discountCodeBasicUpdate(id: $id, basicCodeDiscount: $basicCodeDiscount) {
            codeDiscountNode {
              id
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          id: discountNode.id,
          basicCodeDiscount: {
            endsAt: new Date().toISOString() // End it immediately
          }
        }
      }
    );

    const deactivateJson = await deactivateResponse.json();

    if (deactivateJson.data?.discountCodeBasicUpdate?.userErrors?.length > 0) {
      console.error("Error deactivating discount:", deactivateJson.data.discountCodeBasicUpdate.userErrors);
    } else {
      console.log(`Successfully deactivated referral code ${referralCode} for cancelled subscription`);
    }

    // Optional: Update Klaviyo to mark them as inactive subscriber
    try {
      await fetch('https://a.klaviyo.com/api/profiles/', {
        method: 'POST',
        headers: {
          'Authorization': `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
          'Content-Type': 'application/json',
          'revision': '2025-02-05'
        },
        body: JSON.stringify({
          data: {
            type: 'profile',
            attributes: {
              email: customer.email,
              properties: {
                subscription_status: 'cancelled',
                referral_code_active: false
              }
            }
          }
        })
      });
      console.log(`Updated Klaviyo profile for ${customer.email} - marked as cancelled`);
    } catch (error) {
      console.error('Error updating Klaviyo:', error);
    }

  } catch (error) {
    console.error("Error processing subscription cancellation:", error);
  }

  return new Response();
};

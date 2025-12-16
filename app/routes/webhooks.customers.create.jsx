import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { topic, shop, session, admin, payload } = await authenticate.webhook(request);

  if (!admin) {
    throw new Response();
  }

  const customer = payload;

  console.log("Customer webhook payload:", JSON.stringify(customer, null, 2));

  // Check if customer already has a referral code
  const existingCustomer = await admin.graphql(
    `#graphql
      query getCustomer($id: ID!) {
        customer(id: $id) {
          id
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

  const existingJson = await existingCustomer.json();
  if (existingJson.data?.customer?.metafield?.value) {
    console.log(`Customer already has referral code: ${existingJson.data.customer.metafield.value}`);
    return new Response();
  }

  // Generate unique code
  const baseName = (customer.first_name || customer.email.split('@')[0]).toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 8);
  const randomSuffix = Math.random().toString(36).substring(2, 5).toUpperCase();
  const code = `${baseName}${randomSuffix}`;

  console.log(`New customer webhook: ${customer.email}, generating code: ${code}`);
  console.log(`Customer ID: ${customer.id}`);
  console.log(`Customer admin_graphql_api_id: ${customer.admin_graphql_api_id}`);
  console.log(`Shop: ${shop}`);

  // Get or create shop settings to configure discount properly
  let settings = await db.settings.findUnique({
    where: { shop: shop }
  });

  if (!settings) {
    console.log(`No settings found for shop ${shop}, creating defaults...`);
    settings = await db.settings.create({
      data: {
        shop: shop,
        purchaseType: "Subscription",
        discountPercentage: 10,
        refundAmount: "50.00",
        allowShippingCombos: true
      }
    });
    console.log(`Created default settings for shop ${shop}`);
  }

  console.log(`Settings loaded:`, JSON.stringify(settings, null, 2));

  const discountPercentage = (settings?.discountPercentage || 10) / 100; // Convert to decimal

  // Build discount configuration based on settings
  const discountConfig = {
    title: `Referral - ${code}`,
    code: code,
    startsAt: new Date().toISOString(),
    customerSelection: {
      all: true
    },
    customerGets: {
      value: {
        percentage: discountPercentage
      },
      items: {
        all: true
      },
      // Set purchase type based on settings
      appliesOnSubscription: settings?.purchaseType === "Subscription" || settings?.purchaseType === "Any",
      appliesOnOneTimePurchase: settings?.purchaseType === "One-time" || settings?.purchaseType === "Any"
    },
    appliesOncePerCustomer: true,
    combinesWith: {
      productDiscounts: false,
      orderDiscounts: false,
      shippingDiscounts: settings?.allowShippingCombos ?? true
    }
  };

  console.log(`Discount config:`, JSON.stringify(discountConfig, null, 2));

  // Save code to customer metafield
  const metafieldResponse = await admin.graphql(
    `#graphql
      mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer {
            id
            metafield(namespace: "custom", key: "referral_code") {
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        input: {
          id: customer.admin_graphql_api_id,
          metafields: [
            {
              namespace: "custom",
              key: "referral_code",
              value: code,
              type: "single_line_text_field"
            }
          ]
        }
      }
    }
  );

  const metafieldJson = await metafieldResponse.json();
  console.log("Metafield update response:", JSON.stringify(metafieldJson, null, 2));

  // Create discount code
  const discountResponse = await admin.graphql(
    `#graphql
      mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
        discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
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
        basicCodeDiscount: discountConfig
      }
    }
  );

  const discountJson = await discountResponse.json();
  console.log("Discount creation response:", JSON.stringify(discountJson, null, 2));

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
            email: customer.email,
            first_name: customer.first_name,
            last_name: customer.last_name,
            properties: {
              referral_code: code
            }
          }
        }
      })
    });

    if (klaviyoResponse.ok) {
      const klaviyoData = await klaviyoResponse.json();
      console.log(`Successfully sent referral code to Klaviyo for ${customer.email}:`, klaviyoData);
    } else {
      const errorText = await klaviyoResponse.text();
      console.error(`Failed to send referral code to Klaviyo: ${klaviyoResponse.status} - ${errorText}`);
    }
  } catch (error) {
    console.error('Error sending to Klaviyo:', error);
  }

  console.log(`Successfully created referral code ${code} for ${customer.email}`);

  return new Response();
};

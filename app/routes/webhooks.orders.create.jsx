import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { topic, shop, session, admin, payload } = await authenticate.webhook(request);

  if (!admin) {
    throw new Response();
  }

  const order = payload;

  console.log("Order created webhook:", JSON.stringify(order, null, 2));

  // Check if order has a discount code
  const discountCodes = order.discount_codes || [];
  if (discountCodes.length === 0) {
    console.log("No discount codes used");
    return new Response();
  }

  // Check if any discount code is a referral code (matches pattern)
  const referralCode = discountCodes.find(dc => dc.code.match(/^[A-Z0-9]+$/));
  if (!referralCode) {
    console.log("No referral codes found");
    return new Response();
  }

  console.log(`Referral code used: ${referralCode.code}`);

  // Find the referrer (customer who owns this code)
  const referrerResponse = await admin.graphql(
    `#graphql
      query findReferrer($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node {
              id
              firstName
              lastName
              email
              metafield(namespace: "custom", key: "referral_code") {
                value
              }
              addresses {
                address1
                address2
                city
                province
                zip
                country
              }
            }
          }
        }
      }`,
    {
      variables: {
        query: `metafield.custom.referral_code:${referralCode.code}`
      }
    }
  );

  const referrerJson = await referrerResponse.json();
  const referrer = referrerJson.data?.customers?.edges[0]?.node;

  if (!referrer) {
    console.log(`No referrer found for code: ${referralCode.code}`);
    return new Response();
  }

  console.log(`Referrer found: ${referrer.email}`);

  // Get referee customer details
  const customerId = order.customer?.admin_graphql_api_id || `gid://shopify/Customer/${order.customer?.id}`;
  if (!customerId) {
    console.log("No customer on order");
    return new Response();
  }

  const customerResponse = await admin.graphql(
    `#graphql
      query getCustomer($id: ID!) {
        customer(id: $id) {
          id
          email
          firstName
          lastName
          numberOfOrders
          addresses {
            address1
            address2
            city
            province
            zip
            country
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
  const referee = customerJson.data?.customer;

  if (!referee) {
    console.log("Could not fetch referee details");
    return new Response();
  }

  // Initialize fraud flags
  const fraudFlags = [];

  // FRAUD CHECK 1: Prevent self-referrals (same email)
  if (referrer.email.toLowerCase() === referee.email.toLowerCase()) {
    console.log("⚠️ FRAUD FLAG: Self-referral detected - same email");
    fraudFlags.push("SAME_EMAIL");
  }

  // FRAUD CHECK 2: Prevent self-referrals (same name)
  const referrerName = `${referrer.firstName} ${referrer.lastName}`.toLowerCase().trim();
  const refereeName = `${referee.firstName} ${referee.lastName}`.toLowerCase().trim();
  if (referrerName === refereeName) {
    console.log("⚠️ FRAUD FLAG: Self-referral detected - same name");
    fraudFlags.push("SAME_NAME");
  }

  // FRAUD CHECK 3: Check for matching addresses
  const orderShippingAddress = order.shipping_address;
  const referrerAddresses = referrer.addresses || [];

  if (orderShippingAddress && referrerAddresses.length > 0) {
    const addressMatch = referrerAddresses.some(addr =>
      addr.address1?.toLowerCase() === orderShippingAddress.address1?.toLowerCase() &&
      addr.zip === orderShippingAddress.zip
    );

    if (addressMatch) {
      console.log("⚠️ FRAUD FLAG: Shipping address matches referrer's address");
      fraudFlags.push("SAME_ADDRESS");
    }
  }

  // FRAUD CHECK 4: Minimum order value ($100)
  const orderTotal = parseFloat(order.total_price);
  if (orderTotal < 100) {
    console.log(`⚠️ FRAUD FLAG: Order value too low: $${orderTotal} (minimum $100)`);
    fraudFlags.push("LOW_ORDER_VALUE");
  }

  // Check if this is the referee's first order
  if (referee.numberOfOrders > 1) {
    console.log(`Not first order for customer. Order count: ${referee.numberOfOrders}`);
    return new Response();
  }

  // Check if order contains subscription items
  const hasSubscription = order.line_items?.some(item =>
    item.title?.toLowerCase().includes('subscription') ||
    item.title?.toLowerCase().includes('kit') ||
    item.title?.toLowerCase().includes('annual')
  );

  if (!hasSubscription) {
    console.log("No subscription items in order");
    return new Response();
  }

  console.log("✅ QUALIFIED REFERRAL!");
  console.log(`Referrer: ${referrer.email}`);
  console.log(`Referee: ${referee.email}`);
  console.log(`Order: ${order.name}`);
  console.log(`Amount: $${order.total_price}`);

  if (fraudFlags.length > 0) {
    console.log(`🚩 FRAUD FLAGS: ${fraudFlags.join(", ")}`);
  }

  // Determine referral source based on order tags or attributes
  let referralSource = "unknown";
  
  // Check order note attributes for referral source
  if (order.note_attributes) {
    const sourceAttr = order.note_attributes.find(attr => 
      attr.name === 'referral_source' || attr.name === '_referral_source'
    );
    if (sourceAttr) {
      referralSource = sourceAttr.value;
    }
  }
  
  // If no source found, default to "manual" (customer entered code manually)
  if (referralSource === "unknown") {
    referralSource = "manual";
  }

  // Calculate referee revenue (total order amount)
  const refereeRevenue = order.total_price;

  console.log(`Referral Source: ${referralSource}`);
  console.log(`Referee Revenue: $${refereeRevenue}`);

  // Load settings to get current reward amount
  let settings = await db.settings.findUnique({
    where: { shop: shop }
  });

  // Create default settings if none exist
  if (!settings) {
    settings = await db.settings.create({
      data: {
        shop: shop,
        purchaseType: "Subscription",
        discountPercentage: 10,
        refundAmount: "50.00",
        allowShippingCombos: true
      }
    });
  }

  const rewardAmount = parseFloat(settings.refundAmount || "50.00");

  // Store referral in database
  try {
    await db.referral.create({
      data: {
        referrerId: referrer.id,
        referrerEmail: referrer.email,
        referrerName: `${referrer.firstName} ${referrer.lastName}`,
        refereeId: referee.id,
        refereeEmail: referee.email,
        refereeName: `${referee.firstName} ${referee.lastName}`,
        orderId: `gid://shopify/Order/${order.id}`,
        orderNumber: order.name,
        orderTotal: order.total_price,
        referralCode: referralCode.code,
        fraudFlags: JSON.stringify(fraudFlags),
        status: fraudFlags.length > 0 ? "pending" : "pending",
        refundAmount: settings.refundAmount,
        rewardAmount: rewardAmount, // Lock in reward at creation time
        // NEW FIELDS
        referralSource: referralSource,
        refereeRevenue: refereeRevenue,
        rejectionReason: null
      }
    });
    console.log("✅ Referral saved to database");
  } catch (error) {
    console.error("Error saving referral:", error);
  }

  return new Response();
};

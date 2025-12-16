import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import db from "../db.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Get or create settings for this shop
  let settings = await db.settings.findUnique({
    where: { shop: session.shop }
  });

  if (!settings) {
    settings = await db.settings.create({
      data: {
        shop: session.shop,
        purchaseType: "Subscription",
        discountPercentage: 10,
        refundAmount: "50.00",
        allowShippingCombos: true
      }
    });
  }

  // Run queries in parallel for better performance
  const [customersResponse, pendingReferrals, recentReferrals, statusCounts, totalReferrals] = await Promise.all([
    // Get customers
    admin.graphql(
      `#graphql
        query {
          customers(first: 250) {
            edges {
              node {
                id
                firstName
                lastName
                email
                numberOfOrders
                metafield(namespace: "custom", key: "referral_code") {
                  value
                }
              }
            }
          }
        }`
    ),

    // Get pending referrals (sorted by oldest first)
    db.referral.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" }
    }),

    // Get recent referrals for history (limit to 500 most recent instead of ALL)
    db.referral.findMany({
      orderBy: { updatedAt: "desc" },
      take: 500
    }),

    // Get counts by status using aggregation
    db.referral.groupBy({
      by: ['status'],
      _count: { status: true }
    }),

    // Get total count
    db.referral.count()
  ]);

  const customersJson = await customersResponse.json();
  const customers = customersJson.data.customers.edges.map(edge => ({
    id: edge.node.id,
    name: `${edge.node.firstName || ''} ${edge.node.lastName || ''}`.trim() || 'N/A',
    email: edge.node.email,
    orders: edge.node.numberOfOrders,
    referralCode: edge.node.metafield?.value || ''
  }));

  // Calculate analytics efficiently
  const statusMap = Object.fromEntries(statusCounts.map(s => [s.status, s._count.status]));
  const referralsByStatus = {
    pending: statusMap.pending || 0,
    refunded: statusMap.refunded || 0,
    rejected: statusMap.rejected || 0,
  };

  // Calculate totals from recent referrals only (approximate analytics)
  const refundedReferrals = recentReferrals.filter(r => r.status === 'refunded');
  const totalRefunds = refundedReferrals.length;
  const totalRefundAmount = refundedReferrals.reduce((sum, r) => {
    const amount = r.rewardAmount ? parseFloat(r.rewardAmount) : parseFloat(r.refundAmount || 0);
    return sum + amount;
  }, 0);

  // Calculate total revenue from referrals
  const totalReferralRevenue = refundedReferrals
    .filter(r => r.refereeRevenue)
    .reduce((sum, r) => sum + parseFloat(r.refereeRevenue), 0);

  // Calculate ROI
  const referralCost = totalRefundAmount;
  const referralROI = referralCost > 0
    ? (((totalReferralRevenue - referralCost) / referralCost) * 100).toFixed(1)
    : 0;

  // Referral source breakdown
  const referralsBySource = {};
  recentReferrals.forEach(r => {
    const source = r.referralSource || 'unknown';
    referralsBySource[source] = (referralsBySource[source] || 0) + 1;
  });

  const activeReferrers = customers.filter(c => c.referralCode).length;

  // Calculate fraud detection stats
  const referralsWithFraud = recentReferrals.filter(r => {
    const flags = JSON.parse(r.fraudFlags || '[]');
    return flags.length > 0;
  }).length;

  const fraudDetectionRate = recentReferrals.length > 0
    ? ((referralsWithFraud / recentReferrals.length) * 100).toFixed(1)
    : 0;

  // Top referrers
  const referrerCounts = {};
  refundedReferrals.forEach(r => {
    const key = `${r.referrerEmail}|${r.referrerName}`;
    referrerCounts[key] = (referrerCounts[key] || 0) + 1;
  });

  const topReferrers = Object.entries(referrerCounts)
    .map(([key, count]) => {
      const [email, name] = key.split('|');
      return { email, name, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const analytics = {
    totalRefunds,
    totalRefundAmount,
    totalReferrals,
    activeReferrers,
    referralsByStatus,
    topReferrers,
    fraudDetectionRate,
    referralsWithFraud,
    totalReferralRevenue,
    referralROI,
    referralsBySource
  };

  return { customers, pendingReferrals, allReferrals: recentReferrals, analytics, settings };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  // Handle referral approval
  if (actionType === "approve") {
    const referralId = formData.get("referralId");
    const referral = await db.referral.findUnique({
      where: { id: referralId }
    });

    if (!referral) {
      return { success: false, message: "Referral not found" };
    }
    
    // Combine subscription check and order fetch into single query for better performance
    try {
      const referrerOrdersResponse = await admin.graphql(
        `#graphql
          query getCustomerOrders($customerId: ID!) {
            customer(id: $customerId) {
              id
              email
              orders(first: 10, reverse: true, query: "financial_status:paid OR financial_status:partially_paid") {
                edges {
                  node {
                    id
                    name
                    displayFinancialStatus
                    transactions {
                      id
                      kind
                      status
                      gateway
                    }
                  }
                }
              }
            }
          }`,
        {
          variables: {
            customerId: referral.referrerId
          }
        }
      );

      const referrerOrdersJson = await referrerOrdersResponse.json();
      const referrerOrders = referrerOrdersJson.data?.customer?.orders?.edges || [];

      // Check if referrer has paid orders (active subscription)
      if (referrerOrders.length === 0) {
        return {
          success: false,
          message: "⚠️ Referrer does not have an active subscription. Cannot approve refund for cancelled subscribers."
        };
      }

      // Get the most recent paid order
      const referrerOrder = referrerOrders[0].node;

      // Find the original payment transaction for the referrer's order
      const parentTransaction = referrerOrder.transactions.find(t =>
        (t.kind === "SALE" || t.kind === "CAPTURE") && t.status === "SUCCESS"
      );

      if (!parentTransaction) {
        return {
          success: false,
          message: "No valid payment transaction found for referrer's order"
        };
      }

      // Now issue the $50 refund to the REFERRER's order
      const refundResponse = await admin.graphql(
        `#graphql
          mutation refundCreate($input: RefundInput!) {
            refundCreate(input: $input) {
              refund {
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
            input: {
              orderId: referrerOrder.id,
              note: `Referral program reward: ${referral.refereeName} (${referral.refereeEmail}) used code ${referral.referralCode}`,
              notify: true,
              refundLineItems: [],
              transactions: [
                {
                  orderId: referrerOrder.id,
                  parentId: parentTransaction.id,
                  amount: String(referral.rewardAmount || referral.refundAmount),
                  kind: "REFUND",
                  gateway: parentTransaction.gateway
                }
              ]
            }
          }
        }
      );

      const refundJson = await refundResponse.json();

      console.log("Refund API Response:", JSON.stringify(refundJson, null, 2));

      if (refundJson.data?.refundCreate?.userErrors?.length > 0) {
        console.error("Refund errors:", refundJson.data.refundCreate.userErrors);
        return {
          success: false,
          message: `Refund failed: ${refundJson.data.refundCreate.userErrors[0].message}`
        };
      }

      if (refundJson.errors) {
        console.error("GraphQL errors:", refundJson.errors);
        return {
          success: false,
          message: `GraphQL Error: ${refundJson.errors[0]?.message || 'Unknown error'}`
        };
      }

      // Update referral status to refunded
      await db.referral.update({
        where: { id: referralId },
        data: { status: "refunded" }
      });

      const rewardAmount = referral.rewardAmount || referral.refundAmount;
      return { success: true, message: `Referral approved! $${rewardAmount} refunded to ${referral.referrerName} on order ${referrerOrder.name}` };
    } catch (error) {
      console.error("Error issuing refund:", error);
      return { success: false, message: `Error issuing refund: ${error.message}` };
    }
  }

  // Handle referral rejection
  if (actionType === "reject") {
    const referralId = formData.get("referralId");
    const rejectionReason = formData.get("rejectionReason");
    
    if (!rejectionReason || rejectionReason.trim() === '') {
      return { 
        success: false, 
        message: "Please provide a reason for rejection" 
      };
    }

    try {
      await db.referral.update({
        where: { id: referralId },
        data: { 
          status: "rejected",
          rejectionReason: rejectionReason
        }
      });

      return { 
        success: true, 
        message: "Referral rejected" 
      };
    } catch (error) {
      console.error("Error rejecting referral:", error);
      return { 
        success: false, 
        message: `Error rejecting referral: ${error.message}` 
      };
    }
  }

  // Handle code generation
  if (actionType === "generate") {
    const { session } = await authenticate.admin(request);

    // Get or create shop settings to configure discounts properly
    let settings = await db.settings.findUnique({
      where: { shop: session.shop }
    });

    if (!settings) {
      console.log(`[Bulk Generation] No settings found for shop ${session.shop}, creating defaults...`);
      settings = await db.settings.create({
        data: {
          shop: session.shop,
          purchaseType: "Subscription",
          discountPercentage: 10,
          refundAmount: "50.00",
          allowShippingCombos: true
        }
      });
      console.log(`[Bulk Generation] Created default settings`);
    }

    console.log(`[Bulk Generation] Shop: ${session.shop}`);
    console.log(`[Bulk Generation] Settings:`, JSON.stringify(settings, null, 2));

    const discountPercentage = (settings?.discountPercentage || 10) / 100; // Convert to decimal

    const customersResponse = await admin.graphql(
      `#graphql
        query {
          customers(first: 250) {
            edges {
              node {
                id
                firstName
                lastName
                email
                metafield(namespace: "custom", key: "referral_code") {
                  value
                }
              }
            }
          }
        }`
    );

    const customersJson = await customersResponse.json();
    const customers = customersJson.data.customers.edges;

    let generatedCount = 0;
    let klaviyoSyncCount = 0;

    for (const { node: customer } of customers) {
      if (customer.metafield?.value) continue;

      const baseName = (customer.firstName || customer.email.split('@')[0]).toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 8);
      const randomSuffix = Math.random().toString(36).substring(2, 5).toUpperCase();
      const code = `${baseName}${randomSuffix}`;

      await admin.graphql(
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
              id: customer.id,
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

      await admin.graphql(
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
                first_name: customer.firstName,
                last_name: customer.lastName,
                properties: {
                  referral_code: code
                }
              }
            }
          })
        });

        if (klaviyoResponse.ok) {
          klaviyoSyncCount++;
          console.log(`Successfully synced referral code to Klaviyo for ${customer.email}`);
        } else {
          const errorText = await klaviyoResponse.text();
          console.error(`Failed to sync to Klaviyo for ${customer.email}: ${klaviyoResponse.status} - ${errorText}`);
        }
      } catch (error) {
        console.error(`Error syncing to Klaviyo for ${customer.email}:`, error);
      }

      generatedCount++;
    }

    return { 
      success: true, 
      message: `Referral codes generated for ${generatedCount} customers. ${klaviyoSyncCount} synced to Klaviyo.`, 
      count: generatedCount 
    };
  }

  // Handle test data seeding
  if (actionType === "seed") {
    // Clear existing test data
    await db.referral.deleteMany({
      where: {
        referrerEmail: {
          contains: "example.com"
        }
      }
    });

    // Create test scenarios with different dates
    const now = new Date();
    const testReferrals = [
      {
        referrerId: "gid://shopify/Customer/1001",
        referrerEmail: "russell.winfield@example.com",
        referrerName: "Russell Winfield",
        refereeId: "gid://shopify/Customer/2001",
        refereeEmail: "newcustomer1@example.com",
        refereeName: "John Smith",
        orderId: "gid://shopify/Order/1001",
        orderNumber: "#1001",
        orderTotal: "450.00",
        referralCode: "RUSSELL50",
        fraudFlags: JSON.stringify([]),
        status: "pending",
        refundAmount: "50.00",
        referralSource: "manual",
        refereeRevenue: "450.00",
        createdAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000) // 5 days ago
      },
      {
        referrerId: "gid://shopify/Customer/1002",
        referrerEmail: "karine.ruby@example.com",
        referrerName: "Karine Ruby",
        refereeId: "gid://shopify/Customer/1002",
        refereeEmail: "karine.ruby@example.com",
        refereeName: "Karine Ruby",
        orderId: "gid://shopify/Order/1002",
        orderNumber: "#1002",
        orderTotal: "380.00",
        referralCode: "KARINE50",
        fraudFlags: JSON.stringify(["SAME_EMAIL"]),
        status: "pending",
        refundAmount: "50.00",
        referralSource: "email_form",
        refereeRevenue: "380.00",
        createdAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000) // 3 days ago
      },
      {
        referrerId: "gid://shopify/Customer/1003",
        referrerEmail: "ayumu.hirano@example.com",
        referrerName: "Ayumu Hirano",
        refereeId: "gid://shopify/Customer/2003",
        refereeEmail: "ayumu.h@gmail.com",
        refereeName: "Ayumu Hirano",
        orderId: "gid://shopify/Order/1003",
        orderNumber: "#1003",
        orderTotal: "420.00",
        referralCode: "AYUMU50",
        fraudFlags: JSON.stringify(["SAME_NAME"]),
        status: "pending",
        refundAmount: "50.00",
        referralSource: "whatsapp",
        refereeRevenue: "420.00",
        createdAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000) // 1 day ago
      },
      {
        referrerId: "gid://shopify/Customer/1004",
        referrerEmail: "eric.knight@example.com",
        referrerName: "Eric Knight",
        refereeId: "gid://shopify/Customer/2004",
        refereeEmail: "cheapskate@example.com",
        refereeName: "Cheap Order",
        orderId: "gid://shopify/Order/1004",
        orderNumber: "#1004",
        orderTotal: "75.00",
        referralCode: "ERIC50",
        fraudFlags: JSON.stringify(["LOW_ORDER_VALUE"]),
        status: "pending",
        refundAmount: "50.00",
        referralSource: "manual",
        refereeRevenue: "75.00",
        createdAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) // 7 days ago
      },
      {
        referrerId: "gid://shopify/Customer/1005",
        referrerEmail: "suspicious@example.com",
        referrerName: "Sus Person",
        refereeId: "gid://shopify/Customer/1005",
        refereeEmail: "suspicious@example.com",
        refereeName: "Sus Person",
        orderId: "gid://shopify/Order/1005",
        orderNumber: "#1005",
        orderTotal: "85.00",
        referralCode: "SUS50",
        fraudFlags: JSON.stringify(["SAME_EMAIL", "SAME_NAME", "LOW_ORDER_VALUE", "SAME_ADDRESS"]),
        status: "pending",
        refundAmount: "50.00",
        referralSource: "facebook",
        refereeRevenue: "85.00",
        createdAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000) // 10 days ago
      }
    ];

    for (const referral of testReferrals) {
      await db.referral.create({ data: referral });
    }

    return { success: true, message: "Test data seeded - 5 test referrals created" };
  }

  // Handle settings update
  if (actionType === "updateSettings") {
    const { session } = await authenticate.admin(request);
    const purchaseType = formData.get("purchaseType");
    const discountPercentage = parseInt(formData.get("discountPercentage"));
    const refundAmount = formData.get("refundAmount");
    const allowShippingCombos = formData.get("allowShippingCombos") === "true";

    try {
      await db.settings.upsert({
        where: { shop: session.shop },
        update: {
          purchaseType,
          discountPercentage,
          refundAmount,
          allowShippingCombos
        },
        create: {
          shop: session.shop,
          purchaseType,
          discountPercentage,
          refundAmount,
          allowShippingCombos
        }
      });

      return { success: true, message: "Program settings updated successfully" };
    } catch (error) {
      console.error("Error updating settings:", error);
      return { success: false, message: "Failed to update settings" };
    }
  }

  return { success: false };
};

export default function Referrals() {
  const { customers, pendingReferrals, allReferrals, analytics, settings } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [activeTab, setActiveTab] = useState("pending");
  const [searchQuery, setSearchQuery] = useState("");
  const [historySearchQuery, setHistorySearchQuery] = useState("");
  const [rejectingReferralId, setRejectingReferralId] = useState(null);
  const [rejectionReason, setRejectionReason] = useState("");

  // Settings state
  const [showSettings, setShowSettings] = useState(false);
  const [purchaseType, setPurchaseType] = useState(settings.purchaseType);
  const [discountPercentage, setDiscountPercentage] = useState(settings.discountPercentage);
  const [refundAmount, setRefundAmount] = useState(settings.refundAmount);
  const [allowShippingCombos, setAllowShippingCombos] = useState(settings.allowShippingCombos);

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show(fetcher.data.message);
    } else if (fetcher.data?.success === false) {
      shopify.toast.show(fetcher.data.message, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const generateCodes = () => {
    fetcher.submit({ actionType: "generate" }, { method: "POST" });
  };

  const approve = (referralId) => {
    fetcher.submit(
      { actionType: "approve", referralId },
      { method: "POST" }
    );
  };

  const reject = (referralId) => {
    setRejectingReferralId(referralId);
    setRejectionReason("");
  };

  const confirmReject = () => {
    if (!rejectionReason.trim()) {
      shopify.toast.show("Please provide a reason for rejection", { isError: true });
      return;
    }
    
    fetcher.submit(
      { 
        actionType: "reject", 
        referralId: rejectingReferralId,
        rejectionReason: rejectionReason 
      },
      { method: "POST" }
    );
    
    setRejectingReferralId(null);
    setRejectionReason("");
  };

  const cancelReject = () => {
    setRejectingReferralId(null);
    setRejectionReason("");
  };

  const seedTestData = () => {
    fetcher.submit({ actionType: "seed" }, { method: "POST" });
  };

  const saveSettings = () => {
    fetcher.submit(
      {
        actionType: "updateSettings",
        purchaseType,
        discountPercentage: discountPercentage.toString(),
        refundAmount,
        allowShippingCombos: allowShippingCombos.toString()
      },
      { method: "POST" }
    );
  };

  // Helper to display name or email
  const displayName = (name, email) => {
    return (name && name !== 'N/A') ? name : email;
  };

  // Helper to extract customer ID from gid
  const getCustomerIdFromGid = (gid) => {
    return gid.split('/').pop();
  };

  // Helper to get customer profile URL
  const getCustomerUrl = (customerId) => {
    if (typeof window === 'undefined') return '#';
    const id = getCustomerIdFromGid(customerId);
    return `https://admin.shopify.com/store/${window.location.hostname.split('.')[0]}/customers/${id}`;
  };

  // Helper to calculate days old
  const getDaysOld = (createdAt) => {
    const now = new Date();
    const created = new Date(createdAt);
    const diffTime = Math.abs(now - created);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
  };

  // Filter referrals based on search query
  const filteredReferrals = pendingReferrals.filter(referral => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      referral.referrerName.toLowerCase().includes(query) ||
      referral.refereeName.toLowerCase().includes(query) ||
      referral.referrerEmail.toLowerCase().includes(query) ||
      referral.refereeEmail.toLowerCase().includes(query) ||
      referral.orderNumber.toLowerCase().includes(query) ||
      referral.referralCode.toLowerCase().includes(query)
    );
  });

  // Filter history referrals based on search query
  const filteredHistoryReferrals = allReferrals.filter(referral => {
    if (!historySearchQuery) return true;
    const query = historySearchQuery.toLowerCase();
    return (
      referral.referrerName.toLowerCase().includes(query) ||
      referral.refereeName.toLowerCase().includes(query) ||
      referral.referrerEmail.toLowerCase().includes(query) ||
      referral.refereeEmail.toLowerCase().includes(query) ||
      referral.orderNumber.toLowerCase().includes(query) ||
      referral.referralCode.toLowerCase().includes(query) ||
      referral.status.toLowerCase().includes(query)
    );
  });

  return (
    <>
      {/* Rejection Reason Modal */}
      {rejectingReferralId && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <div style={{
            background: 'white',
            padding: '32px',
            borderRadius: '8px',
            maxWidth: '500px',
            width: '90%'
          }}>
            <h2 style={{ marginTop: 0, marginBottom: '16px' }}>Reject Referral</h2>
            <p style={{ color: '#666', marginBottom: '20px' }}>
              Please provide a reason for rejecting this referral:
            </p>
            <textarea
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="e.g., Fraud detected - same email address"
              style={{
                width: '100%',
                minHeight: '100px',
                padding: '12px',
                border: '1px solid #c9cccf',
                borderRadius: '6px',
                fontSize: '14px',
                fontFamily: 'inherit',
                marginBottom: '20px'
              }}
            />
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                onClick={cancelReject}
                style={{
                  padding: '10px 20px',
                  border: '1px solid #c9cccf',
                  background: 'white',
                  borderRadius: '6px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmReject}
                style={{
                  padding: '10px 20px',
                  border: 'none',
                  background: '#dc3545',
                  color: 'white',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: 'bold'
                }}
              >
                Reject Referral
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .desktop-layout {
          display: grid;
          grid-template-columns: 50px 130px 130px 70px 70px 70px 90px 40px 140px;
          gap: 12px;
          align-items: center;
        }
        .history-desktop-layout {
          display: grid;
          grid-template-columns: 100px 130px 130px 70px 70px 70px 90px 40px 80px;
          gap: 12px;
          align-items: center;
        }
        .mobile-layout {
          display: none;
        }
        .header-row {
          display: grid;
          grid-template-columns: 50px 130px 130px 70px 70px 70px 90px 40px 140px;
          gap: 12px;
          padding: 12px 0;
          border-bottom: 2px solid #e1e3e5;
          margin-bottom: 16px;
        }
        .history-header-row {
          display: grid;
          grid-template-columns: 100px 130px 130px 70px 70px 70px 90px 40px 80px;
          gap: 12px;
          padding: 12px 0;
          border-bottom: 2px solid #e1e3e5;
          margin-bottom: 16px;
        }
        .search-bar {
          margin-bottom: 16px;
        }
        .search-bar input {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid #c9cccf;
          border-radius: 6px;
          font-size: 14px;
        }
        .search-bar input:focus {
          outline: none;
          border-color: #005bd3;
        }
        .customer-link {
          color: #005bd3;
          text-decoration: none;
        }
        .customer-link:hover {
          text-decoration: underline;
        }
        .fraud-indicator {
          display: inline-block;
          width: 20px;
          height: 20px;
          background: #d72c0d;
          color: white;
          border-radius: 50%;
          text-align: center;
          line-height: 20px;
          font-size: 12px;
          font-weight: bold;
          cursor: help;
          position: relative;
        }
        .fraud-indicator:hover .tooltip {
          display: block;
        }
        .tooltip {
          display: none;
          position: absolute;
          bottom: 25px;
          left: 50%;
          transform: translateX(-50%);
          background: #2c2c2c;
          color: white;
          padding: 8px 12px;
          border-radius: 6px;
          white-space: nowrap;
          font-size: 12px;
          z-index: 1000;
          box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        }
        .tooltip::after {
          content: '';
          position: absolute;
          top: 100%;
          left: 50%;
          transform: translateX(-50%);
          border: 5px solid transparent;
          border-top-color: #2c2c2c;
        }
        .button-group {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .button-group button {
          width: 100%;
          min-width: 120px;
        }
        .status-badge {
          display: inline-block;
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 500;
        }
        .status-pending {
          background: #fff4e5;
          color: #663c00;
        }
        .status-refunded {
          background: #e3f5ed;
          color: #004d25;
        }
        .status-rejected {
          background: #fef1f1;
          color: #7a0000;
        }
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 16px;
          margin-bottom: 24px;
        }
        .stat-card {
          background: white;
          border: 1px solid #e1e3e5;
          border-radius: 8px;
          padding: 20px;
        }
        .stat-value {
          font-size: 32px;
          font-weight: bold;
          color: #005bd3;
          margin: 8px 0;
        }
        .stat-label {
          font-size: 14px;
          color: #666;
        }
        .leaderboard {
          background: white;
          border: 1px solid #e1e3e5;
          border-radius: 8px;
          padding: 20px;
        }
        .leaderboard-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 0;
          border-bottom: 1px solid #f1f1f1;
        }
        .leaderboard-item:last-child {
          border-bottom: none;
        }
        .rank {
          font-weight: bold;
          color: #005bd3;
          margin-right: 16px;
          min-width: 30px;
        }
        .referrer-info {
          flex: 1;
        }
        .referrer-count {
          font-weight: bold;
          color: #28a745;
        }
        @media (max-width: 768px) {
          .desktop-layout, .header-row, .history-desktop-layout, .history-header-row {
            display: none !important;
          }
          .mobile-layout {
            display: block !important;
          }
          .stats-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <s-page heading="Referral Program">
        <s-section>
          <s-stack direction="block" gap="large">
            {/* Tab Navigation */}
            <s-stack direction="inline" gap="base">
              <s-button
                onClick={() => setActiveTab("pending")}
                variant={activeTab === "pending" ? "primary" : "secondary"}
              >
                Pending Approvals ({pendingReferrals.length})
              </s-button>
              <s-button
                onClick={() => setActiveTab("history")}
                variant={activeTab === "history" ? "primary" : "secondary"}
              >
                Referral History
              </s-button>
              <s-button
                onClick={() => setActiveTab("analytics")}
                variant={activeTab === "analytics" ? "primary" : "secondary"}
              >
                Analytics
              </s-button>
            </s-stack>

            {/* Pending Approvals Tab */}
            {activeTab === "pending" && (
              <s-stack direction="block" gap="base">
                {/* Program Rules Card */}
                <s-card>
                  <s-stack direction="block" gap="base">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={() => setShowSettings(!showSettings)}>
                      <s-heading>Program Rules</s-heading>
                      <span style={{ fontSize: '20px' }}>{showSettings ? '▼' : '▶'}</span>
                    </div>

                    {showSettings && (
                      <s-stack direction="block" gap="base">
                        <s-stack direction="block" gap="tight">
                          <label style={{ fontWeight: 'bold' }}>Purchase Type</label>
                          <select
                            value={purchaseType}
                            onChange={(e) => setPurchaseType(e.target.value)}
                            style={{ padding: '8px', borderRadius: '4px', border: '1px solid #c9cccf' }}
                          >
                            <option value="Subscription">Subscription</option>
                            <option value="One-time">One-time</option>
                            <option value="Any">Any Purchase</option>
                          </select>
                        </s-stack>

                        <s-stack direction="block" gap="tight">
                          <label style={{ fontWeight: 'bold' }}>Discount Percentage (%)</label>
                          <input
                            type="number"
                            value={discountPercentage}
                            onChange={(e) => setDiscountPercentage(parseInt(e.target.value))}
                            min="0"
                            max="100"
                            style={{ padding: '8px', borderRadius: '4px', border: '1px solid #c9cccf' }}
                          />
                        </s-stack>

                        <s-stack direction="block" gap="tight">
                          <label style={{ fontWeight: 'bold' }}>Refund Amount ($)</label>
                          <input
                            type="text"
                            value={refundAmount}
                            onChange={(e) => setRefundAmount(e.target.value)}
                            placeholder="50.00"
                            style={{ padding: '8px', borderRadius: '4px', border: '1px solid #c9cccf' }}
                          />
                        </s-stack>

                        <s-stack direction="block" gap="tight">
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <input
                              type="checkbox"
                              checked={allowShippingCombos}
                              onChange={(e) => setAllowShippingCombos(e.target.checked)}
                            />
                            <span style={{ fontWeight: 'bold' }}>Allow Combination with Shipping Discounts</span>
                          </label>
                        </s-stack>

                        <s-button onClick={saveSettings} variant="primary">
                          Save Settings
                        </s-button>
                      </s-stack>
                    )}

                    {!showSettings && (
                      <s-unordered-list>
                        <s-list-item>Referrer receives ${refundAmount} refund after referee completes their first {purchaseType.toLowerCase()} order</s-list-item>
                        <s-list-item>Referee receives {discountPercentage}% discount on their first {purchaseType.toLowerCase()} order</s-list-item>
                        <s-list-item>Only applies to {purchaseType.toLowerCase()} orders</s-list-item>
                        <s-list-item>Only active subscribers are eligible to receive referral rewards</s-list-item>
                        {allowShippingCombos && <s-list-item>Can be combined with shipping discounts</s-list-item>}
                      </s-unordered-list>
                    )}

                    <s-stack direction="inline" gap="tight">
                      <s-button onClick={generateCodes} variant="primary">
                        Generate Referral Codes for All Customers
                      </s-button>
                      <s-button onClick={seedTestData} variant="secondary">
                        Seed Test Data (Dev Only)
                      </s-button>
                    </s-stack>
                  </s-stack>
                </s-card>

                {pendingReferrals.length === 0 ? (
                  <s-card>
                    <s-paragraph>No pending referrals to review.</s-paragraph>
                  </s-card>
                ) : (
                  <s-card>
                    {/* Search Bar */}
                    <div className="search-bar">
                      <input
                        type="text"
                        placeholder="Search by name, email, order, or code..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                    </div>

                    {/* Column Headers - Desktop Only */}
                    <div className="header-row">
                      <s-text weight="bold">Days Old</s-text>
                      <s-text weight="bold">Referrer</s-text>
                      <s-text weight="bold">New Customer</s-text>
                      <s-text weight="bold">Order</s-text>
                      <s-text weight="bold">Total</s-text>
                      <s-text weight="bold">Refund</s-text>
                      <s-text weight="bold">Code</s-text>
                      <div></div>
                      <s-text weight="bold">Actions</s-text>
                    </div>

                    {filteredReferrals.length === 0 ? (
                      <s-paragraph>No referrals match your search.</s-paragraph>
                    ) : (
                      filteredReferrals.map((referral, index) => {
                        const fraudFlags = JSON.parse(referral.fraudFlags || "[]");
                        const hasFraud = fraudFlags.length > 0;
                        const daysOld = getDaysOld(referral.createdAt);

                        return (
                          <div key={referral.id}>
                            {index > 0 && (
                              <div style={{ borderTop: '1px solid #e1e3e5', margin: '16px 0' }}></div>
                            )}

                            {/* Desktop Layout */}
                            <div className="desktop-layout">
                              <s-text>{daysOld}</s-text>

                              <a
                                href={getCustomerUrl(referral.referrerId)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="customer-link"
                              >
                                {displayName(referral.referrerName, referral.referrerEmail)}
                              </a>

                              <a
                                href={getCustomerUrl(referral.refereeId)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="customer-link"
                              >
                                {displayName(referral.refereeName, referral.refereeEmail)}
                              </a>

                              <s-text>{referral.orderNumber}</s-text>

                              <s-text>${referral.orderTotal}</s-text>

                              <s-text>${referral.refundAmount}</s-text>

                              <s-text>{referral.referralCode}</s-text>

                              <div>
                                {hasFraud && (
                                  <span className="fraud-indicator">
                                    !
                                    <span className="tooltip">⚠️ {fraudFlags.join(", ")}</span>
                                  </span>
                                )}
                              </div>

                              <div className="button-group">
                                <s-button
                                  onClick={() => approve(referral.id)}
                                  variant="primary"
                                >
                                  Approve ${referral.refundAmount}
                                </s-button>
                                <s-button
                                  onClick={() => reject(referral.id)}
                                  variant="secondary"
                                >
                                  Reject
                                </s-button>
                              </div>
                            </div>

                            {/* Mobile Layout */}
                            <div className="mobile-layout">
                              <s-stack direction="block" gap="base">
                                <s-text weight="bold">{daysOld} days old</s-text>

                                {hasFraud && (
                                  <div style={{ background: '#fef1f1', padding: '8px 12px', borderRadius: '6px', color: '#7a0000', fontSize: '12px' }}>
                                    ⚠️ Fraud: {fraudFlags.join(", ")}
                                  </div>
                                )}

                                <s-stack direction="inline" gap="large">
                                  <s-stack direction="block" gap="tight">
                                    <s-text weight="bold">Referrer</s-text>
                                    <a
                                      href={getCustomerUrl(referral.referrerId)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="customer-link"
                                    >
                                      {displayName(referral.referrerName, referral.referrerEmail)}
                                    </a>
                                  </s-stack>

                                  <s-stack direction="block" gap="tight">
                                    <s-text weight="bold">New Customer</s-text>
                                    <a
                                      href={getCustomerUrl(referral.refereeId)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="customer-link"
                                    >
                                      {displayName(referral.refereeName, referral.refereeEmail)}
                                    </a>
                                  </s-stack>
                                </s-stack>

                                <s-stack direction="inline" gap="large">
                                  <s-stack direction="block" gap="tight">
                                    <s-text weight="bold">Order</s-text>
                                    <s-text>{referral.orderNumber}</s-text>
                                  </s-stack>

                                  <s-stack direction="block" gap="tight">
                                    <s-text weight="bold">Total</s-text>
                                    <s-text>${referral.orderTotal}</s-text>
                                  </s-stack>

                                  <s-stack direction="block" gap="tight">
                                    <s-text weight="bold">Refund</s-text>
                                    <s-text>${referral.refundAmount}</s-text>
                                  </s-stack>

                                  <s-stack direction="block" gap="tight">
                                    <s-text weight="bold">Code</s-text>
                                    <s-text>{referral.referralCode}</s-text>
                                  </s-stack>
                                </s-stack>

                                <s-stack direction="inline" gap="tight">
                                  <s-button
                                    onClick={() => approve(referral.id)}
                                    variant="primary"
                                  >
                                    Approve ${referral.refundAmount}
                                  </s-button>
                                  <s-button
                                    onClick={() => reject(referral.id)}
                                    variant="secondary"
                                  >
                                    Reject
                                  </s-button>
                                </s-stack>
                              </s-stack>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </s-card>
                )}
              </s-stack>
            )}

            {/* Referral History Tab */}
            {activeTab === "history" && (
              <s-card>
                {/* Search Bar */}
                <div className="search-bar">
                  <input
                    type="text"
                    placeholder="Search by name, email, order, code, or status..."
                    value={historySearchQuery}
                    onChange={(e) => setHistorySearchQuery(e.target.value)}
                  />
                </div>

                {/* Column Headers - Desktop Only */}
                <div className="history-header-row">
                  <s-text weight="bold">Action Date</s-text>
                  <s-text weight="bold">Referrer</s-text>
                  <s-text weight="bold">New Customer</s-text>
                  <s-text weight="bold">Order</s-text>
                  <s-text weight="bold">Total</s-text>
                  <s-text weight="bold">Refund</s-text>
                  <s-text weight="bold">Code</s-text>
                  <div></div>
                  <s-text weight="bold">Status</s-text>
                </div>

                {filteredHistoryReferrals.length === 0 ? (
                  <s-paragraph>No referrals match your search.</s-paragraph>
                ) : (
                  filteredHistoryReferrals.map((referral, index) => {
                    const fraudFlags = JSON.parse(referral.fraudFlags || "[]");
                    const hasFraud = fraudFlags.length > 0;
                    const statusClass = `status-${referral.status}`;

                    return (
                      <div key={referral.id}>
                        {index > 0 && (
                          <div style={{ borderTop: '1px solid #e1e3e5', margin: '16px 0' }}></div>
                        )}

                        {/* Desktop Layout */}
                        <div className="history-desktop-layout">
                          <s-text>{new Date(referral.updatedAt).toLocaleDateString()}</s-text>

                          <a
                            href={getCustomerUrl(referral.referrerId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="customer-link"
                          >
                            {displayName(referral.referrerName, referral.referrerEmail)}
                          </a>

                          <a
                            href={getCustomerUrl(referral.refereeId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="customer-link"
                          >
                            {displayName(referral.refereeName, referral.refereeEmail)}
                          </a>

                          <s-text>{referral.orderNumber}</s-text>

                          <s-text>${referral.orderTotal}</s-text>

                          <s-text>${referral.refundAmount}</s-text>

                          <s-text>{referral.referralCode}</s-text>

                          <div>
                            {hasFraud && (
                              <span className="fraud-indicator">
                                !
                                <span className="tooltip">⚠️ {fraudFlags.join(", ")}</span>
                              </span>
                            )}
                          </div>

                          <div>
                            <span className={`status-badge ${statusClass}`}>
                              {referral.status}
                            </span>
                          </div>
                        </div>

                        {/* Mobile Layout */}
                        <div className="mobile-layout">
                          <s-stack direction="block" gap="base">
                            <s-text weight="bold">
                              {new Date(referral.updatedAt).toLocaleDateString()}
                            </s-text>

                            {hasFraud && (
                              <div style={{ background: '#fef1f1', padding: '8px 12px', borderRadius: '6px', color: '#7a0000', fontSize: '12px' }}>
                                ⚠️ Fraud: {fraudFlags.join(", ")}
                              </div>
                            )}

                            <s-stack direction="inline" gap="large">
                              <s-stack direction="block" gap="tight">
                                <s-text weight="bold">Referrer</s-text>
                                <a
                                  href={getCustomerUrl(referral.referrerId)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="customer-link"
                                >
                                  {displayName(referral.referrerName, referral.referrerEmail)}
                                </a>
                              </s-stack>

                              <s-stack direction="block" gap="tight">
                                <s-text weight="bold">New Customer</s-text>
                                <a
                                  href={getCustomerUrl(referral.refereeId)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="customer-link"
                                >
                                  {displayName(referral.refereeName, referral.refereeEmail)}
                                </a>
                              </s-stack>
                            </s-stack>

                            <s-stack direction="inline" gap="large">
                              <s-stack direction="block" gap="tight">
                                <s-text weight="bold">Order</s-text>
                                <s-text>{referral.orderNumber}</s-text>
                              </s-stack>

                              <s-stack direction="block" gap="tight">
                                <s-text weight="bold">Total</s-text>
                                <s-text>${referral.orderTotal}</s-text>
                              </s-stack>

                              <s-stack direction="block" gap="tight">
                                <s-text weight="bold">Refund</s-text>
                                <s-text>${referral.refundAmount}</s-text>
                              </s-stack>

                              <s-stack direction="block" gap="tight">
                                <s-text weight="bold">Code</s-text>
                                <s-text>{referral.referralCode}</s-text>
                              </s-stack>
                            </s-stack>

                            <s-stack direction="block" gap="tight">
                              <s-text weight="bold">Status</s-text>
                              <span className={`status-badge ${statusClass}`}>
                                {referral.status}
                              </span>
                            </s-stack>
                          </s-stack>
                        </div>
                      </div>
                    );
                  })
                )}
              </s-card>
            )}

            {/* Analytics Tab */}
            {activeTab === "analytics" && (
              <s-stack direction="block" gap="large">
                {/* Overview Stats */}
                <div className="stats-grid">
                  <div className="stat-card">
                    <div className="stat-label">Active Referrers</div>
                    <div className="stat-value">{analytics.activeReferrers}</div>
                    <div className="stat-label">Customers with codes</div>
                  </div>

                  <div className="stat-card">
                    <div className="stat-label">Total Referrals</div>
                    <div className="stat-value">{analytics.totalReferrals}</div>
                    <div className="stat-label">All-time</div>
                  </div>

                  <div className="stat-card">
                    <div className="stat-label">Refunds Issued</div>
                    <div className="stat-value">{analytics.totalRefunds}</div>
                    <div className="stat-label">Approved referrals</div>
                  </div>

                  <div className="stat-card">
                    <div className="stat-label">Total Paid Out</div>
                    <div className="stat-value">${analytics.totalRefundAmount.toFixed(2)}</div>
                    <div className="stat-label">In refunds</div>
                  </div>

                  <div className="stat-card">
                    <div className="stat-label">Revenue Generated</div>
                    <div className="stat-value" style={{ color: '#28a745' }}>
                      ${analytics.totalReferralRevenue.toFixed(2)}
                    </div>
                    <div className="stat-label">From referred customers</div>
                  </div>

                  <div className="stat-card">
                    <div className="stat-label">Program ROI</div>
                    <div className="stat-value" style={{ color: analytics.referralROI > 0 ? '#28a745' : '#dc3545' }}>
                      {analytics.referralROI}%
                    </div>
                    <div className="stat-label">Return on investment</div>
                  </div>
                </div>

                {/* Referral Source Breakdown */}
                <s-card>
                  <s-stack direction="block" gap="base">
                    <s-heading>Referral Sources</s-heading>
                    <s-stack direction="block" gap="tight">
                      {Object.entries(analytics.referralsBySource).map(([source, count]) => (
                        <div key={source} style={{ 
                          display: 'flex', 
                          justifyContent: 'space-between', 
                          padding: '12px 0', 
                          borderBottom: '1px solid #f1f1f1' 
                        }}>
                          <s-text style={{ textTransform: 'capitalize' }}>
                            {source.replace('_', ' ')}
                          </s-text>
                          <s-text weight="bold">{count}</s-text>
                        </div>
                      ))}
                    </s-stack>
                  </s-stack>
                </s-card>

                {/* Status Breakdown */}
                <s-card>
                  <s-stack direction="block" gap="base">
                    <s-heading>Referral Status Breakdown</s-heading>
                    <s-stack direction="block" gap="tight">
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid #f1f1f1' }}>
                        <s-text>Pending Approval</s-text>
                        <s-text weight="bold" style={{ color: '#ffa500' }}>{analytics.referralsByStatus.pending}</s-text>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid #f1f1f1' }}>
                        <s-text>Approved & Refunded</s-text>
                        <s-text weight="bold" style={{ color: '#28a745' }}>{analytics.referralsByStatus.refunded}</s-text>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0' }}>
                        <s-text>Rejected</s-text>
                        <s-text weight="bold" style={{ color: '#dc3545' }}>{analytics.referralsByStatus.rejected}</s-text>
                      </div>
                    </s-stack>
                  </s-stack>
                </s-card>

                {/* Fraud Detection Stats */}
                <s-card>
                  <s-stack direction="block" gap="base">
                    <s-heading>Fraud Detection</s-heading>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
                      <div>
                        <div className="stat-value" style={{ fontSize: '48px' }}>{analytics.fraudDetectionRate}%</div>
                        <div className="stat-label">Detection Rate</div>
                      </div>
                      <div>
                        <s-text>{analytics.referralsWithFraud} of {analytics.totalReferrals} referrals flagged</s-text>
                      </div>
                    </div>
                  </s-stack>
                </s-card>

                {/* Top Referrers Leaderboard */}
                <div className="leaderboard">
                  <s-heading>Top Referrers (All-Time)</s-heading>
                  <div style={{ marginTop: '16px' }}>
                    {analytics.topReferrers.length === 0 ? (
                      <s-text>No successful referrals yet.</s-text>
                    ) : (
                      analytics.topReferrers.map((referrer, index) => (
                        <div key={referrer.email} className="leaderboard-item">
                          <span className="rank">#{index + 1}</span>
                          <div className="referrer-info">
                            <div style={{ fontWeight: '500' }}>{referrer.name || referrer.email}</div>
                            <div style={{ fontSize: '12px', color: '#666' }}>{referrer.email}</div>
                          </div>
                          <span className="referrer-count">{referrer.count} referral{referrer.count !== 1 ? 's' : ''}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </s-stack>
            )}
          </s-stack>
        </s-section>
      </s-page>
    </>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

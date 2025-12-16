import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import db from "../db.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  await authenticate.admin(request);

  // Clear existing test data
  await db.referral.deleteMany({
    where: {
      referrerEmail: {
        contains: "example.com"
      }
    }
  });

  // Scenario 1: Clean referral - no fraud flags
  await db.referral.create({
    data: {
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
      rewardAmount: 50.00
    }
  });

  // Scenario 2: Self-referral - same email
  await db.referral.create({
    data: {
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
      rewardAmount: 50.00
    }
  });

  // Scenario 3: Same name - different email
  await db.referral.create({
    data: {
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
      rewardAmount: 50.00
    }
  });

  // Scenario 4: Low order value
  await db.referral.create({
    data: {
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
      rewardAmount: 50.00
    }
  });

  // Scenario 5: Multiple fraud flags
  await db.referral.create({
    data: {
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
      rewardAmount: 50.00
    }
  });

  // Scenario 6: Already approved
  await db.referral.create({
    data: {
      referrerId: "gid://shopify/Customer/1006",
      referrerEmail: "approved@example.com",
      referrerName: "Already Approved",
      refereeId: "gid://shopify/Customer/2006",
      refereeEmail: "referee6@example.com",
      refereeName: "Happy Customer",
      orderId: "gid://shopify/Order/1006",
      orderNumber: "#1006",
      orderTotal: "500.00",
      referralCode: "APPROVED50",
      fraudFlags: JSON.stringify([]),
      status: "approved",
      refundAmount: "50.00",
      rewardAmount: 50.00
    }
  });

  // Scenario 7: Rejected
  await db.referral.create({
    data: {
      referrerId: "gid://shopify/Customer/1007",
      referrerEmail: "rejected@example.com",
      referrerName: "Rejected User",
      refereeId: "gid://shopify/Customer/2007",
      refereeEmail: "referee7@example.com",
      refereeName: "Rejected Customer",
      orderId: "gid://shopify/Order/1007",
      orderNumber: "#1007",
      orderTotal: "400.00",
      referralCode: "REJECT50",
      fraudFlags: JSON.stringify(["SAME_EMAIL"]),
      status: "rejected",
      refundAmount: "50.00",
      rewardAmount: 50.00
    }
  });

  return { success: true, message: "Test data seeded successfully" };
};

export default function SeedTestData() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show(fetcher.data.message);
    }
  }, [fetcher.data, shopify]);

  const seedData = () => {
    fetcher.submit({}, { method: "POST" });
  };

  return (
    <s-page heading="Seed Test Data">
      <s-section>
        <s-card>
          <s-stack direction="block" gap="base">
            <s-heading>Create Test Referrals</s-heading>
            <s-paragraph>
              This will create 7 test referrals with different scenarios:
            </s-paragraph>
            <s-unordered-list>
              <s-list-item>Clean referral (no fraud flags)</s-list-item>
              <s-list-item>Self-referral (same email)</s-list-item>
              <s-list-item>Same name fraud</s-list-item>
              <s-list-item>Low order value</s-list-item>
              <s-list-item>Multiple fraud flags</s-list-item>
              <s-list-item>Already approved referral</s-list-item>
              <s-list-item>Already rejected referral</s-list-item>
            </s-unordered-list>
            <s-button onClick={seedData} variant="primary">
              Seed Test Data
            </s-button>
          </s-stack>
        </s-card>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
// api/notify.js
import { kv } from "@vercel/kv";
import webpush from "web-push";
import admin from "firebase-admin";

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf-8")
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

export default async function handler(req, res) {
  console.log("Notify handler invoked");

  if (req.method !== "POST") {
    return res.status(405).end();
  }

  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ error: "Subscription ID is missing." });
    }

    // Retrieve stored subscription from KV
    const subscription = await kv.get(id);
    if (!subscription) {
      return res.status(404).json({ error: "Subscription not found." });
    }

    const { fcmToken, pushKeys } = subscription;
    if (!fcmToken || !pushKeys) {
      return res.status(500).json({ error: "Invalid subscription data." });
    }

    const notificationData = req.body;
    console.log("Notification data:", notificationData);

    // 1️⃣ Send via FCM
    const fcmMessage = {
      notification: {
        title: notificationData.title || "Mastodon Notification",
        body: notificationData.body || "",
      },
      token: fcmToken,
      data: notificationData.data || {},
    };

    try {
      const fcmResponse = await admin.messaging().send(fcmMessage);
      console.log("FCM sent successfully:", fcmResponse);
    } catch (fcmError) {
      console.error("FCM send failed:", fcmError);
      if (fcmError.code === "messaging/registration-token-not-registered") {
        await kv.del(id); // Remove invalid token
      }
    }

    // 2️⃣ Optionally send via Web Push (Mastodon expects RFC-compliant Web Push)
    const webPushSubscription = {
      endpoint: `https://${req.headers.host}/api/notify?id=${id}`,
      keys: {
        p256dh: pushKeys.p256dh,
        auth: pushKeys.auth,
      },
    };

    try {
      await webpush.sendNotification(webPushSubscription, JSON.stringify(notificationData));
      console.log("Web Push sent successfully");
    } catch (wpError) {
      console.error("Web Push failed:", wpError);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Unhandled error in notify handler:", error);
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
}

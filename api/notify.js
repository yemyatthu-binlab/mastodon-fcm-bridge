import { kv } from "@vercel/kv";
import webpush from "web-push";
import admin from "firebase-admin";

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString(
      "utf-8"
    )
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

    // 1️⃣ Get subscription from KV
    const subscription = await kv.get(id);
    if (!subscription) {
      return res.status(404).json({ error: "Subscription not found." });
    }

    const { fcmToken, pushKeys } = subscription;
    if (!fcmToken || !pushKeys) {
      return res.status(500).json({ error: "Invalid subscription data." });
    }

    // 2️⃣ Decrypt Mastodon Notification Payload
    let decrypted;
    try {
      decrypted = await webpush.decrypt(
        req.body, // encrypted payload (Buffer)
        pushKeys.privateKey, // the VAPID private key you stored in subscribe.js
        pushKeys.publicKey   // public key (p256dh)
      );
    } catch (decryptError) {
      console.error("Failed to decrypt notification:", decryptError);
      return res.status(500).json({ error: "Decryption failed" });
    }

    let notificationData;
    try {
      notificationData = JSON.parse(decrypted);
    } catch (parseError) {
      console.error("Failed to parse decrypted payload:", parseError);
      return res.status(500).json({ error: "Invalid JSON in decrypted data" });
    }

    console.log("Decrypted Mastodon Notification:", notificationData);

    // 3️⃣ Build FCM Message
    const mastodonNotif = notificationData.notification || {};
    const fcmMessage = {
      notification: {
        title: "Qlub",
        body: `${mastodonNotif.account?.username || "Someone"} ${mastodonNotif.type}ed you`,
      },
      token: fcmToken,
      data: {
        noti_type: mastodonNotif.type || "mention",
        reblogged_id: mastodonNotif.status?.reblog?.id || "0",
        destination_id: mastodonNotif.status?.id || "",
        visibility: mastodonNotif.status?.visibility || "public",
      },
    };

    try {
      const fcmResponse = await admin.messaging().send(fcmMessage);
      console.log("FCM sent successfully:", fcmResponse);
    } catch (fcmError) {
      console.error("FCM send failed:", fcmError);
      if (fcmError.code === "messaging/registration-token-not-registered") {
        await kv.del(id);
      }
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Unhandled error in notify handler:", error);
    return res
      .status(500)
      .json({ error: "Internal Server Error", details: error.message });
  }
}

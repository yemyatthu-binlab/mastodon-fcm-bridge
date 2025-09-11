// api/notify.js
import { kv } from "@vercel/kv";
import admin from "firebase-admin";

// Initialize Firebase Admin SDK
// IMPORTANT: We check if the app is already initialized to avoid errors on hot reloads.
if (!admin.apps.length) {
  // Get credentials from environment variables
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
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  try {
    // 1. Get the unique ID from the query parameter
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ error: "Subscription ID is missing." });
    }

    // 2. Retrieve the corresponding FCM token from Vercel KV
    const fcmToken = await kv.get(id);
    if (!fcmToken) {
      return res
        .status(404)
        .json({ error: "FCM token not found for this subscription." });
    }

    // 3. The notification data from Mastodon is in the request body
    const notificationData = req.body;

    // 4. Construct the push notification message
    const message = {
      notification: {
        title: notificationData.title,
        body: notificationData.body,
      },
      token: fcmToken,
      // You can also add 'data' payload for background processing in your app
      // data: { ... }
    };

    // 5. Send the message using Firebase Admin SDK
    const response = await admin.messaging().send(message);
    console.log("Successfully sent message:", response);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Failed to send notification:", error);
    // If the token is invalid, you might want to remove it from KV
    if (error.code === "messaging/registration-token-not-registered") {
      const { id } = req.query;
      if (id) {
        await kv.del(id);
      }
    }
    return res.status(500).json({ error: "Failed to send push notification." });
  }
}

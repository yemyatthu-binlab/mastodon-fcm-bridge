// api/notify.js
import { kv } from "@vercel/kv";
import admin from "firebase-admin";
import http_ece from "http_ece"; // ✅ Correct import

// Initialize Firebase Admin
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf-8")
  );
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// IMPORTANT: Tell Vercel to not parse the body. We need the raw buffer.
export const config = {
  api: {
    bodyParser: false,
  },
};

// Helper to buffer the raw request stream
async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
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

    const { fcmToken, keys } = subscription;
    if (!fcmToken || !keys || !keys.privateKey || !keys.auth) {
      return res.status(500).json({ error: "Invalid subscription data in KV." });
    }
    
    // Convert keys from base64 strings back to Buffers
    const privateKey = Buffer.from(keys.privateKey, 'base64');
    const authSecret = Buffer.from(keys.auth, 'base64');

    // 2️⃣ Decrypt Mastodon Notification Payload
    let decryptedPayload;
    try {
      const rawBody = await buffer(req); // Get the raw request body
      
      // ✅ Use http_ece.decrypt() with the correct parameters
      const params = {
        version: 'aesgcm', // The standard for Web Push
        privateKey: privateKey,
        authSecret: authSecret,
        dh: req.headers['crypto-key']?.split(';')[0]?.split('=')[1],
        salt: req.headers['encryption']?.split('=')[1],
      };
      decryptedPayload = http_ece.decrypt(rawBody, params);

    } catch (decryptError) {
      console.error("Failed to decrypt notification:", decryptError);
      return res.status(500).json({ error: "Decryption failed", details: decryptError.message });
    }

    // Now, parse the decrypted buffer to get the JSON object
    const notificationData = JSON.parse(decryptedPayload.toString('utf-8'));
    console.log("✅ Successfully decrypted Mastodon Notification:", notificationData);

    // 3️⃣ Build FCM Message (Your logic here is already good!)
    const mastodonNotif = notificationData.notification || {};
    const fcmMessage = {
      notification: {
        title: "Qlub",
        body: `${mastodonNotif.account?.display_name || "Someone"} ${mastodonNotif.type}d you`,
      },
      token: fcmToken,
      data: {
        noti_type: mastodonNotif.type || "unknown",
        reblogged_id: mastodonNotif.status?.reblog?.id || "0",
        destination_id: mastodonNotif.status?.id || "",
        visibility: mastodonNotif.status?.visibility || "public",
      },
    };

    // 4️⃣ Send to FCM
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
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
}
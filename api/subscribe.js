// api/subscribe.js
import { kv } from "@vercel/kv";
import { randomBytes, createECDH } from "crypto";

// Helper to encode keys in URL-safe Base64
function toUrlSafeBase64(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export default async function handler(req, res) {
  const { v4: uuidv4 } = await import("uuid");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { fcmToken, mastodonToken } = req.body || {};

    if (!fcmToken || !mastodonToken) {
      return res.status(400).json({ error: "fcmToken and mastodonToken are required." });
    }

    // 1️⃣ Generate a unique subscription ID
    const subscriptionId = uuidv4();

    // 2️⃣ Generate correct Web Push subscription keys
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const publicKey = ecdh.getPublicKey(); // This is the p256dh key
    const privateKey = ecdh.getPrivateKey(); // This is the private key we need to store
    const authSecret = randomBytes(16); // This is the auth secret

    // 3️⃣ Store mapping in Vercel KV. We store the private key and auth secret.
    // Keys are stored as base64 strings for compatibility with JSON in KV.
    const subscriptionData = {
      fcmToken,
      keys: {
        privateKey: privateKey.toString('base64'),
        auth: authSecret.toString('base64'),
      },
    };
    await kv.set(subscriptionId, subscriptionData, { ex: 60 * 60 * 24 * 30 }); // 30 days

    // 4️⃣ Construct the webhook URL
    const host = process.env.VERCEL_URL || req.headers.host;
    const webhookUrl = `https://${host}/api/notify?id=${subscriptionId}`;

    // 5️⃣ Register webhook with Mastodon
    const mastodonResponse = await fetch(
      "https://qlub.channel.org/api/v1/push/subscription",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${mastodonToken}`,
        },
        body: JSON.stringify({
          subscription: {
            endpoint: webhookUrl,
            keys: {
              // Keys sent to Mastodon must be URL-safe Base64 encoded
              p256dh: toUrlSafeBase64(publicKey),
              auth: toUrlSafeBase64(authSecret),
            },
          },
          data: {
            alerts: {
              follow: true,
              favourite: true,
              reblog: true,
              mention: true,
              poll: true,
            },
          },
        }),
      }
    );

    if (!mastodonResponse.ok) {
      const errorData = await mastodonResponse.text();
      console.error("Mastodon API responded with error:", errorData);
      // Delete the key if Mastodon registration fails
      await kv.del(subscriptionId); 
      return res.status(500).json({
        error: "Mastodon API error",
        details: errorData,
      });
    }

    console.log("Mastodon subscription created successfully");
    return res.status(200).json({
      message: "Subscription created successfully.",
      subscriptionId,
    });

  } catch (error) {
    console.error("Unhandled error in subscription handler:", error);
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
}
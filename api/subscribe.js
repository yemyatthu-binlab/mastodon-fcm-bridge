// api/subscribe.js
import { kv } from "@vercel/kv";
import { randomBytes, createECDH } from "crypto";

// Helper to encode keys in URL-safe Base64
function toUrlSafeBase64(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export default async function handler(req, res) {
  const { v4: uuidv4 } = await import("uuid");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // 🔄 MODIFIED: Also accept an 'instanceUrl' from the request body.
    const { fcmToken, mastodonToken, instanceUrl } = req.body || {};

    if (!fcmToken || !mastodonToken) {
      return res
        .status(400)
        .json({ error: "fcmToken and mastodonToken are required." });
    }

    // ✨ NEW: Define the default instance for backward compatibility.
    const defaultInstance = "https://qlub.channel.org";
    // ✨ NEW: Use the provided instanceUrl or fall back to the default.
    const targetInstance = instanceUrl || defaultInstance;

    // 1️⃣ Generate a unique subscription ID
    const subscriptionId = uuidv4();

    // 2️⃣ Generate correct Web Push subscription keys
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const publicKey = ecdh.getPublicKey();
    const privateKey = ecdh.getPrivateKey();
    const authSecret = randomBytes(16);

    // 3️⃣ Store mapping in Vercel KV.
    // 🔄 MODIFIED: We now also store the 'targetInstance' URL.
    const subscriptionData = {
      fcmToken,
      instanceUrl: targetInstance, // Store the instance URL
      keys: {
        privateKey: privateKey.toString("base64"),
        auth: authSecret.toString("base64"),
      },
    };
    await kv.set(subscriptionId, subscriptionData, { ex: 60 * 60 * 24 * 30 }); // 30 days

    // 4️⃣ Construct the webhook URL
    const host = process.env.VERCEL_URL || req.headers.host;
    const webhookUrl = `https://${host}/api/notify?id=${subscriptionId}`;

    // 5️⃣ Register webhook with Mastodon
    // 🔄 MODIFIED: Use the dynamic 'targetInstance' URL instead of the hardcoded one.
    const mastodonResponse = await fetch(
      `${targetInstance}/api/v1/push/subscription`,
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
      await kv.del(subscriptionId);
      return res.status(500).json({
        error: "Mastodon API error",
        details: errorData,
      });
    }

    console.log(
      `Mastodon subscription created successfully for ${targetInstance}`
    );
    return res.status(200).json({
      message: "Subscription created successfully.",
      subscriptionId,
    });
  } catch (error) {
    console.error("Unhandled error in subscription handler:", error);
    return res
      .status(500)
      .json({ error: "Internal Server Error", details: error.message });
  }
}

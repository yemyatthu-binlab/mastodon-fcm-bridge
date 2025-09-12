// api/subscribe.js
import { kv } from "@vercel/kv";
import webpush from "web-push";

export default async function handler(req, res) {
  const { v4: uuidv4 } = await import("uuid"); // dynamic import for uuid

  console.log("Handler invoked");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { fcmToken, mastodonToken, lang } = req.body || {};
    console.log("Request body:", req.body);

    if (!fcmToken || !mastodonToken) {
      return res.status(400).json({ error: "fcmToken and mastodonToken are required." });
    }

    // 1️⃣ Generate a unique subscription ID
    const subscriptionId = uuidv4();
    console.log("Generated subscriptionId:", subscriptionId);

    // 2️⃣ Generate Web Push keys (p256dh + auth)
    const pushKeys = webpush.generateVAPIDKeys();
    // p256dh = publicKey, auth = random 16 bytes
    const p256dh = pushKeys.publicKey; 
    const auth = Buffer.from(pushKeys.privateKey).toString("base64").slice(0, 16); // 16 bytes
    console.log("Generated push keys:", { p256dh, auth });

    // 3️⃣ Store mapping in Vercel KV: subscriptionId -> { fcmToken, pushKeys }
    try {
      await kv.set(subscriptionId, { fcmToken, pushKeys }, { ex: 60 * 60 * 24 * 30 }); // 30 days
      console.log("Stored subscription in KV");
    } catch (kvError) {
      console.error("KV Error:", kvError);
      return res.status(500).json({ error: "KV storage failed" });
    }

    // 4️⃣ Construct the webhook URL
    const host = process.env.VERCEL_URL || req.headers.host;
    const webhookUrl = `https://${host}/api/notify?id=${subscriptionId}`;
    console.log("Webhook URL:", webhookUrl);

    // 5️⃣ Register webhook with Mastodon
    try {
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
                p256dh,
                auth,
              },
              standard: true, // use standard Web Push
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
    } catch (mastodonError) {
      console.error("Mastodon fetch failed:", mastodonError);
      return res.status(500).json({
        error: "Mastodon API request failed",
        details: mastodonError.message,
      });
    }
  } catch (error) {
    console.error("Unhandled error in subscription handler:", error);
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
}

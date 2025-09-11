// api/subscribe.js
import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  // Dynamically import uuid to avoid ESM/CommonJS issues
  const { v4: uuidv4 } = await import("uuid");

  console.log("Handler invoked");

  if (req.method !== "POST") {
    console.warn("Invalid method:", req.method);
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // Log the raw body for debugging
    console.log("Request body:", req.body);

    const { fcmToken, mastodonToken, lang } = req.body || {};

    if (!fcmToken || !mastodonToken) {
      console.error("Missing fcmToken or mastodonToken");
      return res
        .status(400)
        .json({ error: "fcmToken and mastodonToken are required." });
    }

    // 1. Generate unique subscription ID
    const subscriptionId = uuidv4();
    console.log("Generated subscriptionId:", subscriptionId);

    // 2. Store mapping in Vercel KV
    try {
      await kv.set(subscriptionId, fcmToken, { ex: 60 * 60 * 24 * 30 }); // 30 days
      console.log("Stored subscription in KV");
    } catch (kvError) {
      console.error("KV Error:", kvError);
      return res.status(500).json({ error: "KV storage failed" });
    }

    // 3. Construct webhook URL
    const host = process.env.VERCEL_URL || req.headers.host;
    const webhookUrl = `https://${host}/api/notify?id=${subscriptionId}`;
    console.log("Webhook URL:", webhookUrl);

    // 4. Register webhook with Mastodon
    try {
      const mastodonResponse = await fetch(
        "https://qlub.social/api/v1/push/subscription",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${mastodonToken}`,
          },
          body: JSON.stringify({
            subscription: {
              endpoint: webhookUrl,
              keys: {},
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
      return res
        .status(500)
        .json({ error: "Mastodon API request failed", details: mastodonError.message });
    }
  } catch (error) {
    console.error("Unhandled error in subscription handler:", error);
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
}

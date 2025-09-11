// api/subscribe.js
import { kv } from "@vercel/kv";
import { v4 as uuidv4 } from "uuid";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { fcmToken, mastodonToken } = req.body;

    if (!fcmToken || !mastodonToken) {
      return res
        .status(400)
        .json({ error: "fcmToken and mastodonToken are required." });
    }

    // 1. Generate a unique ID to link this subscription to the FCM token.
    const subscriptionId = uuidv4();

    // 2. Store the mapping in Vercel KV: subscriptionId -> fcmToken
    await kv.set(subscriptionId, fcmToken, { ex: 60 * 60 * 24 * 30 }); // Store for 30 days

    // 3. Construct the webhook URL for Mastodon to call.
    // This URL points to our *other* function and includes the unique ID.
    const webhookUrl = `https://${req.headers.host}/api/notify?id=${subscriptionId}`;

    // 4. Register this webhook with qlub.social's API
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
            keys: {}, // Keys are not needed for webhooks
          },
          data: {
            alerts: {
              // Subscribe to all notification types
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
      throw new Error(`Mastodon API Error: ${errorData}`);
    }

    return res
      .status(200)
      .json({ message: "Subscription created successfully.", subscriptionId });
  } catch (error) {
    console.error("Subscription failed:", error);
    return res.status(500).json({ error: error.message });
  }
}

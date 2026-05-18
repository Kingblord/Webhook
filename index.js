const express = require("express");
const dotenv = require("dotenv");
const axios = require("axios");

dotenv.config();

const app = express();
app.use(express.json());

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3001";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  console.warn("⚠️  OPENROUTER_API_KEY is not set in .env file");
}

// ========================
// AI RESPONSE USING OPENROUTER
// ========================

async function getAIResponse(userMessage) {
  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "openrouter/free",        // ← You can change model
        // model: "anthropic/claude-3.5-sonnet",     // Alternative good option
        messages: [
          {
            role: "system",
            content: "You are a helpful, friendly, and engaging assistant."
          },
          {
            role: "user",
            content: userMessage
          }
        ],
        temperature: 0.7,
        max_tokens: 500,
      },
      {
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://aromsg.up.railway.app", // Optional but recommended
          "X-Title": "AroMsg WhatsApp Gateway",
        },
        timeout: 15000,
      }
    );

    return response.data.choices[0]?.message?.content?.trim() || 
           "Sorry, I couldn't generate a response right now.";
  } catch (error) {
    console.error("❌ OpenRouter API Error:", error.response?.data || error.message);
    return "Sorry, I'm having trouble thinking right now. Please try again later.";
  }
}

// ========================
// WEBHOOK ENDPOINT
// ========================

app.post("/webhook", async (req, res) => {
  try {
    // ========================
    // AUTHENTICATION
    // ========================
    const authHeader = req.headers.authorization;

    if (!authHeader || authHeader !== `Bearer ${INTERNAL_API_KEY}`) {
      console.log("❌ Unauthorized webhook attempt");
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const { userId, from, text, platform, messageId, timestamp } = req.body;

    console.log("📨 WEBHOOK RECEIVED:");
    console.log(JSON.stringify(req.body, null, 2));

    if (!userId || !from || !text) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    // ========================
    // GET AI RESPONSE FROM OPENROUTER
    // ========================
    console.log("🤖 Generating AI reply...");
    const aiReply = await getAIResponse(text);

    console.log("🤖 AI Reply:", aiReply);

    // ========================
    // SEND REPLY BACK TO WHATSAPP via Gateway
    // ========================
    try {
      await axios.post(`${GATEWAY_URL}/send-message`, {
        userId,
        to: from,
        text: aiReply
      }, {
        headers: {
          Authorization: `Bearer ${INTERNAL_API_KEY}`
        },
        timeout: 10000
      });

      console.log(`✅ Reply sent successfully to ${from}`);
    } catch (sendError) {
      console.error("❌ Failed to send reply to gateway:", sendError.message);
    }

    // ========================
    // RESPOND TO GATEWAY
    // ========================
    res.json({
      success: true,
      aiReply
    });

  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
});

// ========================
// HEALTH CHECK
// ========================

app.get("/health", (_, res) => {
  res.send("Webhook server is running ✅");
});

// ========================
// START SERVER
// ========================

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Webhook Server running on port ${PORT}`);
  console.log(`📡 Gateway URL: ${GATEWAY_URL}`);
});

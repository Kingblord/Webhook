const express = require('express')
const dotenv = require('dotenv')
const axios = require('axios')
const admin = require('firebase-admin')

const { jidNormalizedUser } = require("@whiskeysockets/baileys")

dotenv.config()

const app = express()
app.use(express.json())

// ========================
// ENVIRONMENT VARIABLES
// ========================
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3001'
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp'

const PORT = process.env.PORT || 3000

// ========================
// FIREBASE INITIALIZATION
// ========================
let db
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail: FIREBASE_CLIENT_EMAIL,
    }),
    projectId: FIREBASE_PROJECT_ID,
  })
  db = admin.firestore()
  console.log('✅ Firebase Admin SDK initialized successfully')
} catch (err) {
  console.error('❌ Firebase initialization error:', err.message)
  process.exit(1)
}

// ========================
// OFFICIAL BAILEYS JID NORMALIZER
// ========================
function normalizeJid(jid) {
  if (!jid) return jid;
  return jidNormalizedUser(jid);
}

// ========================
// GET CONVERSATION HISTORY
// ========================
async function getConversationHistory(businessId, phoneNumber, limit = 12) {
  try {
    const snapshot = await db
      .collection('businesses')
      .doc(businessId)
      .collection('whatsapp_messages')
      .where('contactJid', '==', phoneNumber.replace(/\D/g, ''))
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get()

    return snapshot.docs.map(doc => doc.data()).reverse()
  } catch (err) {
    console.error('[DB] History fetch error:', err.message)
    return []
  }
}

// ========================
// GET BUSINESS CONTEXT + PRODUCTS
// ========================
async function getBusinessContext(businessId) {
  try {
    const businessDoc = await db.collection('businesses').doc(businessId).get()
    if (!businessDoc.exists) return null

    const businessData = businessDoc.data()

    const productsSnapshot = await db
      .collection('businesses')
      .doc(businessId)
      .collection('products')
      .get()

    const products = productsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }))

    let productsContext = ''
    if (products.length > 0) {
      productsContext = '\n\nAvailable Products:\n' + 
        products.map(p => {
          const negotiable = p.negotiationEnabled ? ' [Negotiable]' : '';
          return `- ${p.name} (${p.price})${negotiable}: ${p.description || ''}`;
        }).join('\n');
    }

    return {
      businessId,
      businessName: businessData.name,
      aiPersonality: businessData.aiPersonality,
      productsContext,
      products
    }
  } catch (err) {
    console.error('[DB] Business context error:', err.message)
    return null
  }
}

// ========================
// TOOL DEFINITIONS
// ========================
const tools = [
  { type: "function", function: { name: "getProductList", description: "Return list of all available products", parameters: { type: "object", properties: {}, required: [] } }},
  { type: "function", function: { name: "getProductInfo", description: "Get detailed info about a specific product", parameters: { type: "object", properties: { productName: { type: "string" }}, required: ["productName"] } }},
  { type: "function", function: { name: "createOrder", description: "Create order when customer is ready to buy", parameters: { type: "object", properties: { productName: { type: "string" }, quantity: { type: "number", default: 1 }, customerName: { type: "string" }}, required: ["productName"] } }},
  { type: "function", function: { name: "getPaymentDetails", description: "Get payment methods and instructions", parameters: { type: "object", properties: {}, required: [] } }},
  { type: "function", function: { name: "checkOrderStatus", description: "Check status of an existing order", parameters: { type: "object", properties: { orderId: { type: "string" }}, required: ["orderId"] } }}
]

// ========================
// TOOL EXECUTION LAYER
// ========================
async function executeTool(toolCall, businessId, phoneNumber, products = []) {
  const { name, arguments: argsStr } = toolCall.function
  const args = JSON.parse(argsStr || '{}')

  console.log(`[TOOL] Executing ${name} with args:`, args)

  switch (name) {
    case "getProductList": {
      if (products.length === 0) return "We currently have no products listed."
      
      return `Here are our products:\n` +
        products.map(p => {
          const negotiable = p.negotiationEnabled ? ' [Negotiable]' : '';
          return `• ${p.name} (${p.price})${negotiable}`;
        }).join('\n') +
        `\n\nWhich one are you interested in?`;
    }

    case "getProductInfo": {
      const productNameArg = args.productName || '';
      const product = products.find(p => 
        p.name.toLowerCase().includes(productNameArg.toLowerCase())
      );

      if (product) {
        const status = product.negotiationEnabled ? 'Negotiable' : 'Fixed price';
        return `Product Inventory Data:\n- Name: ${product.name}\n- Price: ${product.price}\n- Description: ${product.description || 'No description provided.'}\n- Status: ${status}`;
      }
      
      return `Product "${productNameArg}" not found in current inventory.`;
    }

    case "createOrder": {
      return `✅ Order started for **${args.productName}**.\nPlease provide your full name to complete the order.`;
    }

    case "getPaymentDetails": {
      return "We accept Bank Transfer, USSD, and Card payments.\nWould you like our account details?";
    }

    case "checkOrderStatus": {
      return `I'll check the status of order #${args.orderId || 'N/A'} for you.`;
    }

    default: {
      return "I'm processing your request...";
    }
  }
}

// ========================
// AI DECISION BRAIN
// ========================
async function getAIResponse(businessName, personality, productsContext, history, userMessage) {
  const systemPrompt = `You are a smart AI Sales Assistant for ${businessName}.

${personality || 'You are friendly, professional, and focused on helping customers.'}

Current Business Inventory & Context:
"""
${productsContext || 'No product data available.'}
"""

**IMPORTANT INSTRUCTIONS:**
1. First, think step by step about the user's intent.
2. Decide if you need to use a tool to extract structured product data or take action (like checking/creating orders).
3. Use tools when the user asks about products, pricing, availability, or orders.
4. When a tool returns data, do NOT show raw brackets or code syntax to the user. Instead, process that information and respond like a natural, smooth, empathetic human salesperson.
5. If an item is marked as negotiable, do not just state 'it is negotiable'. Engage the user conversationally (e.g., ask for their target budget or offer a minor concession to close the sale).
6. Be concise, persuasive, and natural in your final reply. Never make up product info.`

  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          ...history.slice(-8).map(m => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.text
          })),
          { role: 'user', content: userMessage }
        ],
        tools: tools,
        tool_choice: "auto",
        temperature: 0.65,
        max_tokens: 800,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://aromsg.up.railway.app',
          'X-Title': 'AroMsg WhatsApp AI',
        },
        timeout: 20000,
      }
    )

    const message = response.data.choices[0].message

    if (message.tool_calls?.length > 0) {
      console.log(`[AI] 🛠️ Tool Called: ${message.tool_calls[0].function.name}`)
      return {
        type: "tool_call",
        tool: message.tool_calls[0],
        content: message.content || ""
      }
    }

    return {
      type: "text",
      content: message.content?.trim() || "I'm here to help! What would you like to know?"
    }

  } catch (error) {
    console.error('[AI] Error:', error.response?.data || error.message)
    return { type: "text", content: "Sorry, I'm having trouble right now. Please try again." }
  }
}

// ========================
// SAVE MESSAGE + SEND REPLY
// ========================
async function saveMessage(businessId, phoneNumber, role, text, messageId) {
  try {
    const timestamp = Date.now()
    const normalizedPhone = phoneNumber.replace(/\D/g, '')

    await db.collection('businesses').doc(businessId).collection('whatsapp_messages').add({
      contactJid: normalizedPhone,
      from: role === 'user' ? normalizedPhone : businessId,
      to: role === 'user' ? businessId : normalizedPhone,
      text,
      role,
      platform: 'whatsapp',
      messageId,
      timestamp,
      direction: role === 'user' ? 'incoming' : 'outgoing',
    })
    return true
  } catch (err) {
    console.error('[DB] Save error:', err.message)
    return false
  }
}

async function sendReplyViaGateway(userId, jid, replyText) {
  try {
    const normalizedJid = normalizeJid(jid)
    await axios.post(`${GATEWAY_URL}/send-message`, {
      userId,
      to: normalizedJid,
      text: replyText,
    }, {
      headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` },
      timeout: 10000,
    })
    console.log(`[GATEWAY] ✅ Sent to ${normalizedJid}`)
    return true
  } catch (err) {
    console.error('[GATEWAY] Failed:', err.message)
    return false
  }
}

// ========================
// MAIN WEBHOOK
// ========================
app.post('/webhook', async (req, res) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || authHeader !== `Bearer ${INTERNAL_API_KEY}`) {
      return res.status(401).json({ success: false, error: 'Unauthorized' })
    }

    const { userId, from, text, messageId } = req.body
    if (!userId || !from || !text) {
      return res.status(400).json({ success: false, error: 'Missing fields' })
    }

    const normalizedFrom = normalizeJid(from)
    const phoneNumber = normalizedFrom.replace('@s.whatsapp.net', '')

    console.log(`[WEBHOOK] 📨 Message from ${phoneNumber}: ${text.substring(0, 70)}...`)

    const history = await getConversationHistory(userId, phoneNumber)
    const context = await getBusinessContext(userId)

    if (!context) {
      return res.status(404).json({ success: false, error: 'Business not found' })
    }

    // Fetch User Profile Currency Settings (Defaults to NGN if field is unpopulated)
    const businessDoc = await db.collection('businesses').doc(userId).get()
    const businessData = businessDoc.data() || {}
    const userCurrency = businessData.currency || 'NGN' 

    const aiResult = await getAIResponse(
      context.businessName,
      context.aiPersonality,
      context.productsContext,
      history,
      text
    )

    let replyText;

    if (aiResult.type === "tool_call") {
      const toolResult = await executeTool(aiResult.tool, userId, phoneNumber, context.products)
      
      console.log(`[AI-BRAIN] Re-routing tool data to AI for natural language synthesis...`)
      
      try {
        const secondarySystemPrompt = `You are a smooth, persuasive AI Sales Assistant for ${context.businessName}.
        
        Here is the real-time execution response from the database regarding their request:
        """
        ${toolResult}
        """
        
        CRITICAL OPERATIONAL DIRECTIVES:
        1. Answer the customer's request conversationally using the data values listed above.
        2. Format all prices matching the profile's preferred currency system: "${userCurrency}". (e.g., If NGN use ₦, if USD use $, etc.)
        3. If the item status shows it is negotiable, handle it gracefully like a master human negotiator. Ask for their target price range or extend a polite opening offer to secure the order.
        4. Do NOT output raw variable templates, code blocks, or JavaScript structural braces to the customer.
        5. Keep your response concise, friendly, and structured perfectly for a short WhatsApp chat message.`

        const refinedResponse = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: OPENROUTER_MODEL,
            messages: [
              { role: 'system', content: secondarySystemPrompt },
              ...history.slice(-6).map(m => ({
                role: m.role === 'user' ? 'user' : 'assistant',
                content: m.text
              })),
              { role: 'user', content: text }
            ],
            temperature: 0.7,
            max_tokens: 450,
          },
          {
            headers: {
              Authorization: `Bearer ${OPENROUTER_API_KEY}`,
              'HTTP-Referer': 'https://aromsg.up.railway.app',
              'X-Title': 'AroMsg WhatsApp AI',
            },
            timeout: 20000,
          }
        )

        replyText = refinedResponse.data.choices[0].message.content?.trim() || "Let me process that information for you.";

      } catch (refineError) {
        console.error('[AI Tool Refinement Loop Error]:', refineError.message)
        replyText = toolResult 
      }

    } else {
      replyText = aiResult.content
    }

    await saveMessage(userId, phoneNumber, 'user', text, messageId || `in_${Date.now()}`)
    await saveMessage(userId, phoneNumber, 'assistant', replyText, `ai_${Date.now()}`)

    await sendReplyViaGateway(userId, normalizedFrom, replyText)

    res.json({ 
      success: true, 
      reply: replyText, 
      mode: aiResult.type,
      tool: aiResult.type === "tool_call" ? aiResult.tool.function.name : null 
    })

  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message)
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'AroMsg AI Decision Brain' })
})

app.listen(PORT, () => {
  console.log(`🚀 AroMsg AI Decision Brain running on port ${PORT}`)
})

module.exports = app

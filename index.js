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

    return snapshot.docs.map(doc => doc.data()).reverse() // oldest first
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

    // Fetch products
    let productsContext = ''
    const productsSnapshot = await db
      .collection('businesses')
      .doc(businessId)
      .collection('products')
      .get()

    const products = productsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }))

    if (products.length > 0) {
      productsContext = '\n\nAvailable Products:\n' + 
        products.map(p => 
          `- \( {p.name} (\[ {p.price}) \){p.negotiationEnabled ? ' [Negotiable]' : ''}: ${p.description || ''}`
        ).join('\n')
    }

    return {
      businessId,
      businessName: businessData.name,
      aiPersonality: businessData.aiPersonality,
      productsContext,
      products // raw products for tool execution
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
    case "getProductList":
      return products.length > 0 
        ? `Here are our products:\n${products.map(p => `- \( {p.name} ( \]{p.price}) \){p.negotiationEnabled ? ' [Negotiable]' : ''}`).join('\n')}\n\nWhich one interests you?`
        : "We currently have no products listed."

    case "getProductInfo":
      const product = products.find(p => 
        p.name.toLowerCase().includes(args.productName.toLowerCase())
      )
      if (product) {
        return `${product.name} - $${product.price}\n\( {product.description || ''}\n \){product.negotiationEnabled ? 'This product is negotiable.' : 'Fixed price.'}`
      }
      return `Sorry, I couldn't find information about "${args.productName}".`

    case "createOrder":
      // TODO: You can expand this to actually create order document
      return `✅ Order started for **${args.productName}** (Qty: ${args.quantity || 1}).\nPlease provide your full name to proceed.`

    case "getPaymentDetails":
      return "We accept:\n• Bank Transfer\n• USSD\n• Card Payment\n\nWould you like our account details?"

    case "checkOrderStatus":
      return `I'll check the status of order #${args.orderId} for you...`

    default:
      return "I'm processing your request..."
  }
}

// ========================
// AI DECISION BRAIN
// ========================
async function getAIResponse(businessName, personality, productsContext, history, userMessage) {
  const systemPrompt = `You are a smart and helpful AI Sales Assistant for ${businessName}.

${personality || 'You are friendly, professional, and goal-oriented towards closing sales.'}

Core Rules:
- Understand user intent: product inquiry, interest, negotiation, or ready to buy.
- Use tools when needed instead of guessing.
- Consider negotiationEnabled flag when customer wants to negotiate.
- Be concise, natural, and conversational.
- Never make up product information.`

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
        temperature: 0.7,
        max_tokens: 700,
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
      content: message.content?.trim() || "I'm here to help! Tell me more about what you're looking for."
    }

  } catch (error) {
    console.error('[AI] Error:', error.response?.data || error.message)
    return { type: "text", content: "Sorry, I'm having trouble right now. Please try again." }
  }
}

// ========================
// SAVE MESSAGE
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

// ========================
// SEND REPLY
// ========================
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

    const aiResult = await getAIResponse(
      context.businessName,
      context.aiPersonality,
      context.productsContext,
      history,
      text
    )

    let replyText = aiResult.content

    if (aiResult.type === "tool_call") {
      const toolResult = await executeTool(aiResult.tool, userId, phoneNumber, context.products)
      replyText = toolResult
    }

    // Save messages
    await saveMessage(userId, phoneNumber, 'user', text, messageId || `in_${Date.now()}`)
    await saveMessage(userId, phoneNumber, 'assistant', replyText, `ai_${Date.now()}`)

    // Send reply
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

// ========================
// HEALTH CHECK
// ========================
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'AroMsg AI Decision Brain' })
})

app.listen(PORT, () => {
  console.log(`🚀 AroMsg AI Decision Brain running on port ${PORT}`)
})

module.exports = app

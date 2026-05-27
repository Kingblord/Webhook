const express = require('express')
const dotenv = require('dotenv')
const axios = require('axios')
const admin = require('firebase-admin')
const crypto = require('crypto')
const { jidNormalizedUser } = require('@whiskeysockets/baileys')

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

// Korapay Specific Environment Variables
const KORA_SECRET_KEY = process.env.KORA_SECRET_KEY // sk_live_xxxxx or sk_test_xxxxx
const PRODUCT_A_WEBHOOK = process.env.PRODUCT_A_WEBHOOK_URL
const PRODUCT_B_WEBHOOK = process.env.PRODUCT_B_WEBHOOK_URL

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
// BAILEYS JID NORMALIZER
// ========================
function normalizeJid(jid) {
  if (!jid) return jid
  return jidNormalizedUser(jid)
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

    return snapshot.docs.map((doc) => doc.data()).reverse()
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

    const products = productsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))

    let productsContext = ''
    if (products.length > 0) {
      productsContext =
        '\n\nAvailable Products:\n' +
        products
          .map((p) => {
            const negotiable = p.negotiationEnabled ? ' [Negotiable]' : ''
            return `- ${p.name} (${p.price})${negotiable}: ${p.description || ''}`
          })
          .join('\n')
    }

    return {
      businessId,
      businessName: businessData.name,
      aiPersonality: businessData.aiPersonality,
      productsContext,
      products,
    }
  } catch (err) {
    console.error('[DB] Business context error:', err.message)
    return null
  }
}

// ========================
// TOOL DEFINITIONS FOR AI
// ========================
const AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'getProductList',
      description: 'Return list of all available products',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getProductInfo',
      description: 'Get detailed info about a specific product',
      parameters: {
        type: 'object',
        properties: { productName: { type: 'string' } },
        required: ['productName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'createOrder',
      description: 'Create order when customer is ready to buy',
      parameters: {
        type: 'object',
        properties: {
          productName: { type: 'string' },
          quantity: { type: 'number', default: 1 },
          customerName: { type: 'string' },
        },
        required: ['productName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getPaymentDetails',
      description: 'Get payment methods and instructions or request direct Korapay virtual account to pay immediately',
      parameters: {
        type: 'object',
        properties: {
          productName: { type: 'string', description: 'The name of the product being purchased' },
          agreedPrice: { type: 'number', description: 'The final total price agreed upon for the transaction' }
        },
        required: ['productName', 'agreedPrice']
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'checkOrderStatus',
      description: 'Check status of an existing order',
      parameters: {
        type: 'object',
        properties: { orderId: { type: 'string' } },
        required: ['orderId'],
      },
    },
  },
]

// ========================
// CRITICAL OPERATIONAL DIRECTIVES
// ========================
const CRITICAL_DIRECTIVES = `
**CRITICAL OPERATIONAL DIRECTIVES:**
1. First, think step by step about the user's intent.
2. Decide if you need to use a tool to extract structured product data or take action (like checking/creating orders or generating custom checkout data).
3. Use tools when the user asks about products, pricing, availability, orders, or when they are ready to make a payment.
4. When a tool returns data, do NOT show raw brackets or code syntax to the user. Instead, process that information and respond like a natural, smooth, empathetic human salesperson.
5. If an item is marked as negotiable, do not just state 'it is negotiable'. Engage the user conversationally (e.g., ask for their target budget or offer a minor concession to close the sale).
6. Be concise, persuasive, and natural in your final reply. Never make up product info.
`

// ========================
// ERROR MESSAGES
// ========================
const ERROR_MESSAGES = {
  generic: "Sorry, I'm having trouble right now. Please try again.",
  aiGeneration: "I'm processing your request right now. Please give me a moment.",
  toolExecution: 'Let me process that information for you.',
  orderCreation: 'I\'m having trouble creating your order. Please try again or contact support.',
  paymentDetails: "I'll get you our payment details. One moment please.",
  orderStatus: 'Let me check that order status for you.',
  productNotFound: "I couldn't find that product. Would you like to see what we have available?",
  inventory: "I'm checking our inventory for you.",
  delivery: "I'll help you schedule delivery. Let me get that set up.",
  promo: "I'll verify that promo code for you.",
  negotiation: "Great! Let's work out a deal. What budget did you have in mind?",
}

// ========================
// TOOL EXECUTION LAYER
// ========================
async function executeTool(toolCall, businessId, phoneNumber, products = []) {
  const { name, arguments: argsStr } = toolCall.function
  const args = JSON.parse(argsStr || '{}')

  console.log(`[TOOL] 🔧 Executing ${name} with args:`, args)

  switch (name) {
    case 'getProductList': {
      if (!products || products.length === 0) return ERROR_MESSAGES.productNotFound

      return (
        'Here are our products:\n' +
        products
          .map((p) => {
            const negotiable = p.negotiationEnabled ? ' [Negotiable]' : ''
            return `• ${p.name} (${p.price})${negotiable}`
          })
          .join('\n') +
        '\n\nWhich one are you interested in?'
      )
    }

    case 'getProductInfo': {
      const productNameArg = args.productName || ''
      const product = products.find((p) =>
        p.name.toLowerCase().includes(productNameArg.toLowerCase())
      )

      if (product) {
        const status = product.negotiationEnabled ? 'Negotiable' : 'Fixed price'
        return `Product Details:\n- Name: ${product.name}\n- Price: ${product.price}\n- Description: ${product.description || 'No description provided.'}\n- Status: ${status}`
      }

      return ERROR_MESSAGES.productNotFound
    }

    case 'createOrder': {
      return `✅ Order started for **${args.productName}**.\nPlease provide your full name to complete the order.`
    }

    case 'getPaymentDetails': {
      try {
        const reference = `REF-${Date.now()}-${phoneNumber.slice(-4)}`;
        const amountToCharge = args.agreedPrice || 0;
        const targetProduct = args.productName || 'Order Transaction';

        if (amountToCharge <= 0) {
          return "We accept bank transfers via automated checkout options. Could you confirm the item you want so I can pull up account information?";
        }

        console.log(`[KORAPAY] Initializing dynamic checkout parameters for reference: ${reference}, amount: ${amountToCharge}`);
        
        const koraResponse = await axios.post(`https://checkout.korapay.com/?type=payment-link`, {
          amount: parseFloat(amountToCharge),
          reference: reference,
          currency: 'NGN',
          notification_url: 'https://aromsg.up.railway.app/korapay-webhook',
          customer: {
            name: `WhatsApp Client`,
            email: `${phoneNumber}@aromsg.app`
          },
          merchant_bears_cost: false,
          channels: ['bank_transfer']
        }, {
          headers: { 
            'accept': 'application/json',
            'content-type': 'application/json'
          },
          timeout: 12000
        });

        const koraData = koraResponse.data;

        if (koraData && koraData.success && koraData.data?.bank_account_number) {
          // Store pending transaction parameters inside Firestore
          await db.collection('businesses').doc(businessId).collection('orders').doc(reference).set({
            reference,
            phoneNumber,
            amount: amountToCharge,
            product: targetProduct,
            status: 'pending',
            createdAt: Date.now()
          });

          return `KORAPAY_ACCOUNT_INFO:\n` +
                 `- Bank Name: ${koraData.data.bank_name || 'Korapay Partner Bank'}\n` +
                 `- Account Number: ${koraData.data.bank_account_number}\n` +
                 `- Account Name: ${koraData.data.bank_account_name || 'AroMsg Order Payment'}\n` +
                 `- Amount: ₦${amountToCharge}\n` +
                 `- Expiry: This temporary transfer details expires in 20 minutes.\n` +
                 `- Reference: ${reference}`;
        }
        
        return `KORAPAY_FALLBACK_INFO:\n` +
               `- Status: Ready to receive transfer\n` +
               `- Reference: ${reference}\n` +
               `- Amount: ₦${amountToCharge}\n` +
               `- Instruction: Please proceed to confirm your transfer request. An automated confirmation will follow.`;

      } catch (koraErr) {
        console.error('[KORAPAY BACKEND ERROR]:', koraErr.response?.data || koraErr.message);
        return "We process payments instantly using automated Bank Transfers. Let's try getting those bank account details up again in a moment.";
      }
    }

    case 'checkOrderStatus': {
      return `Let me check the status of order #${args.orderId || 'N/A'} for you.`
    }

    default: {
      return ERROR_MESSAGES.generic
    }
  }
}

// ========================
// AI RESPONSE WITH TOOL SUPPORT
// ========================
async function getAIResponse(businessName, personality, productsContext, history, userMessage, userModel = null) {
  const model = userModel || OPENROUTER_MODEL
  
  const systemPrompt = `You are a smart AI Sales Assistant for ${businessName}.

${personality || 'You are friendly, professional, and focused on helping customers.'}

Current Business Inventory & Context:
"""
${productsContext || 'No product data available.'}
"""

${CRITICAL_DIRECTIVES}`

  try {
    const formattedHistory = history.slice(-8).map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.text,
    }))

    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...formattedHistory,
          { role: 'user', content: userMessage },
        ],
        tools: AI_TOOLS,
        tool_choice: 'auto',
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

    const message = response.data.choices[0]?.message

    if (message.tool_calls?.length > 0) {
      console.log(`[AI] 🛠️ Tool called: ${message.tool_calls[0].function.name}`)
      return {
        type: 'tool_call',
        tool: message.tool_calls[0],
        content: message.content || '',
      }
    }

    return {
      type: 'text',
      content: message.content?.trim() || ERROR_MESSAGES.generic,
    }
  } catch (error) {
    console.error('[AI] Error:', error.response?.data || error.message)
    return {
      type: 'text',
      content: ERROR_MESSAGES.generic,
    }
  }
}

// ========================
// GET REFINEMENT DIRECTIVES
// ========================
const getRefinementDirectives = (businessName, currency) => `You are a smooth, persuasive AI Sales Assistant for ${businessName}.

**CRITICAL OPERATIONAL DIRECTIVES:**
1. Answer the customer's request conversationally using the database data provided above.
2. Format all prices matching the profile's preferred currency system: "${currency}". (Currency is always in Naira NGN unless explicitly configured).
3. If the data contains Korapay Bank Account Information (Bank Name, Account Number, Expiry), extract those details and write a highly natural, helpful text response. Do NOT provide or share links; give them the exact Account details directly in the chat text block.
4. Explicitly include a friendly statement informing them of how long they have left to transfer the money (e.g., "This temporary account expires in 20 minutes, so let me know as soon as you make the transfer!").
5. Do NOT output raw variable templates, code blocks, or JavaScript structural braces to the customer. Keep your response concise, human, and structured perfectly for a short WhatsApp chat message.
`

// ========================
// SAVE MESSAGE + SEND REPLY
// ========================
async function saveMessage(businessId, phoneNumber, role, text, messageId) {
  try {
    const timestamp = Date.now()
    const normalizedPhone = phoneNumber.replace(/\D/g, '')

    await db
      .collection('businesses')
      .doc(businessId)
      .collection('whatsapp_messages')
      .add({
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

    console.log(`[DB] ✅ Message saved: ${role} from ${phoneNumber}`)
    return true
  } catch (err) {
    console.error('[DB] Save error:', err.message)
    return false
  }
}

async function sendReplyViaGateway(userId, jid, replyText) {
  try {
    const normalizedJid = normalizeJid(jid)
    await axios.post(
      `${GATEWAY_URL}/send-message`,
      {
        userId,
        to: normalizedJid,
        text: replyText,
      },
      {
        headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` },
        timeout: 10000,
      }
    )
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

    const context = await getBusinessContext(userId)
    if (!context) {
      return res.status(404).json({ success: false, error: 'Business not found' })
    }

    const businessDoc = await db.collection('businesses').doc(userId).get()
    const businessData = businessDoc.data() || {}
    const userModel = businessData.openrouterModel || OPENROUTER_MODEL
    const userCurrency = businessData.currency || 'NGN'

    const history = await getConversationHistory(userId, phoneNumber)

    console.log('[WEBHOOK] 🤖 Generating AI response with model:', userModel)
    const aiResult = await getAIResponse(
      context.businessName,
      context.aiPersonality,
      context.productsContext,
      history,
      text,
      userModel
    )

    let replyText

    if (aiResult.type === 'tool_call') {
      console.log('[WEBHOOK] 🔧 AI called tool:', aiResult.tool.function.name)
      const toolResult = await executeTool(aiResult.tool, userId, phoneNumber, context.products || [])

      console.log('[WEBHOOK] 🔄 Re-routing tool data to AI for natural language synthesis...')

      try {
        const refinementPrompt =
          getRefinementDirectives(context.businessName, userCurrency) +
          '\n\nDatabase Response:\n"""' +
          toolResult +
          '"""'

        const refinedResponse = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: userModel,
            messages: [
              {
                role: 'system',
                content: refinementPrompt,
              },
              ...history.slice(-6).map((m) => ({
                role: m.role === 'user' ? 'user' : 'assistant',
                content: m.text,
              })),
              {
                role: 'user',
                content: text,
              },
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

        replyText = refinedResponse.data.choices[0]?.message?.content?.trim() || ERROR_MESSAGES.toolExecution
        console.log('[WEBHOOK] ✅ Refined response:', replyText.substring(0, 100))
      } catch (refineErr) {
        console.error('[WEBHOOK] ⚠️ Refinement error:', refineErr.message)
        replyText = toolResult
      }
    } else {
      replyText = aiResult.content
    }

    await saveMessage(userId, phoneNumber, 'user', text, messageId || `in_${Date.now()}`)
    await saveMessage(userId, phoneNumber, 'assistant', replyText, `ai_${Date.now()}`)
    await sendReplyViaGateway(userId, normalizedFrom, replyText)

    console.log('[WEBHOOK] ✅ Complete\n' + '='.repeat(60))

    res.json({
      success: true,
      reply: replyText,
      mode: aiResult.type,
      tool: aiResult.type === 'tool_call' ? aiResult.tool.function.name : null,
      messagesSaved: true,
      gatewaySent: true,
    })
  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message)
    res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// ========================
// NEW KORAPAY WEBHOOK ROUTER (Express Port)
// ========================
function verifyKoraSignature(body, signature) {
  if (!signature || !KORA_SECRET_KEY) return false

  try {
    const hash = crypto
      .createHmac('sha256', KORA_SECRET_KEY)
      .update(JSON.stringify(body.data))
      .digest('hex')

    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature))
  } catch (error) {
    console.error('Signature verification error:', error)
    return false
  }
}

async function forwardToProduct(productUrl, payload) {
  try {
    if (!productUrl) return
    await axios.post(productUrl, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 8000,
    })
  } catch (error) {
    console.error(`Failed to forward to ${productUrl}:`, error.message)
  }
}

app.post('/korapay-webhook', async (req, res) => {
  const signature = req.headers['x-korapay-signature']
  const body = req.body

  // 1. Verify signature authenticity
  if (!verifyKoraSignature(body, signature)) {
    console.warn('Invalid Kora webhook signature received.')
    return res.status(200).json({ received: true }) // Return 200 to satisfy Kora response requirements
  }

  // 2. Acknowledge Kora instantly before processing deep logic
  res.status(200).json({ received: true })

  // 3. Process the routing logic asynchronously
  setImmediate(async () => {
    const data = body.data || {}
    const reference = data.reference || data.payment_reference || data.unique_reference || ''

    console.log(`[KORA-WEBHOOK] 📨 Event: ${body.event}, Reference: ${reference}`)

    // Check if reference matches the WhatsApp Brain order system
    if (reference.startsWith('REF-')) {
      console.log(`[KORA-WEBHOOK] Matching reference detected for WhatsApp automated sales system: ${reference}`)
      
      try {
        // Query across business collections to find the matching transaction record
        const ordersRef = db.collectionGroup('orders').where('reference', '==', reference)
        const snapshot = await ordersRef.get()

        if (!snapshot.empty) {
          for (const doc of snapshot.docs) {
            await doc.ref.update({
              status: 'success',
              updatedAt: Date.now(),
              rawWebhookPayload: body
            })
            console.log(`[KORA-WEBHOOK] ✅ Order status updated successfully in Firestore for reference: ${reference}`)
          }
        } else {
          console.warn(`[KORA-WEBHOOK] Reference ${reference} found but no matching order item exists in Firestore.`)
        }
      } catch (dbErr) {
        console.error('[KORA-WEBHOOK] Firestore update failure:', dbErr.message)
      }

    // Otherwise pass transaction payloads over to your Product A or Product B external services
    } else if (reference.startsWith('PRODA-') || reference.includes('producta')) {
      console.log(`[KORA-WEBHOOK] Forwarding payload to Product A endpoint...`)
      await forwardToProduct(PRODUCT_A_WEBHOOK, body)
    } else if (reference.startsWith('PRODB-') || reference.includes('productb')) {
      console.log(`[KORA-WEBHOOK] Forwarding payload to Product B endpoint...`)
      await forwardToProduct(PRODUCT_B_WEBHOOK, body)
    } else {
      console.log('[KORA-WEBHOOK] Unknown reference prefix pattern. Routing to Product A as global fallback...')
      await forwardToProduct(PRODUCT_A_WEBHOOK, body)
    }
  })
})

// ========================
// HEALTH & INITIALIZATION
// ========================
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'AroMsg AI Decision Brain' })
})

app.listen(PORT, () => {
  console.log(`🚀 AroMsg AI Decision Brain running on port ${PORT}`)
})

module.exports = app

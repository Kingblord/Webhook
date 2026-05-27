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
const KORA_SECRET_KEY = process.env.KORA_SECRET_KEY
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
async function getConversationHistory(businessId, phoneNumber, limit = 15) {
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
        '\nINVENTORY DATA:\n' +
        products
          .map((p) => {
            const negotiable = p.negotiationEnabled ? 'Yes' : 'No'
            const basePrice = parseFloat(p.price || 0)
            const floorPrice = parseFloat(p.minPrice || p.floorPrice || (basePrice * 0.88))
            return `- Item: ${p.name}\n  Listed Price: ₦${basePrice.toLocaleString()}\n  Is Negotiable: ${negotiable}\n  CONFIDENTIAL MERCHANDISE FLOOR: ₦${floorPrice.toLocaleString()}\n  Description: ${p.description || 'No custom description available'}`
          })
          .join('\n\n')
    }

    return {
      businessId,
      businessName: businessData.name,
      aiPersonality: businessData.aiPersonality,
      productsContext,
      products,
      currency: businessData.currency || 'NGN'
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
          agreedPrice: { type: 'number' }
        },
        required: ['productName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getPaymentDetails',
      description: 'Generate dynamic payment credentials using the Korapay bank transfer framework. Run this immediately when the customer accepts an agreed price, asks how to pay, or is ready to check out.',
      parameters: {
        type: 'object',
        properties: {
          productName: { type: 'string', description: 'The name of the product being purchased' },
          agreedPrice: { type: 'number', description: 'The final total price agreed upon for the transaction' },
          customerName: { type: 'string', description: 'Customer full name if known' }
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
**CRITICAL OPERATIONAL & WHATSAPP CHAT DIRECTIVES:**
1. CHAT STYLE: Speak exactly like a local, professional, real human merchant on WhatsApp. Keep messages ultra-short and precise (1-2 sentences max). 
2. NO MARKDOWN ABUSE: Never put bold asterisks (**) on regular text phrases or sentences. Only use bold formatting inside structural catalogs or list outputs.
3. REALISTIC NEGOTIATION RULES: 
   - Never reveal or blurt out the 'CONFIDENTIAL MERCHANDISE FLOOR'.
   - If the customer counters with a very low price (e.g., offering 600k for a 1.3M item), do NOT drop immediately to your minimum floor price. Instead, negotiate like a real person trying to keep margins high! Drop the price slightly (e.g., try 1.15M or 1.1M first). Counter-offer step by step. Only use the floor price as your absolute final shield line if they push hard.
   - If a customer makes an offer that is strictly equal to or above the 'CONFIDENTIAL MERCHANDISE FLOOR', you can choose to accept it gracefully to close the deal fast.
4. MANDATORY PAYMENT TOOL TRIGGER: When a customer says "how can I pay", accepts a counter-price, or says an offer is cool, you MUST immediately call the 'getPaymentDetails' tool. Never write fake account details, fake bank names, or placeholders. You do not have manual bank accounts; you depend completely on the tool execution layer to give you real data.
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
// FUZZY PRODUCT MATCHING
// ========================
function findBestProductMatch(query, products) {
  if (!query || !products.length) return null;
  query = query.toLowerCase().trim();

  let bestMatch = null;
  let highestScore = 0;

  for (const product of products) {
    const name = (product.name || '').toLowerCase();
    const desc = (product.description || '').toLowerCase();
    
    let score = 0;
    
    if (name.includes(query) || query.includes(name.split(' ').slice(0, 3).join(' '))) {
      score = 0.95;
    } else {
      const queryWords = query.split(/\s+/);
      const nameWords = name.split(/\s+/);
      let matches = queryWords.filter(qw => 
        nameWords.some(nw => nw.includes(qw) || qw.includes(nw))
      ).length;
      score = matches / Math.max(queryWords.length, 1);
    }

    if (score > highestScore) {
      highestScore = score;
      bestMatch = product;
    }
  }

  return highestScore > 0.45 ? bestMatch : null;
}

// ========================
// TOOL EXECUTION LAYER
// ========================
async function executeTool(toolCall, businessId, phoneNumber, products = [], context = {}) {
  const { name, arguments: argsStr } = toolCall.function
  let args = {}
  try {
    args = JSON.parse(argsStr || '{}')
  } catch (e) {
    console.error('[TOOL] Args parse error:', e.message)
  }

  console.log(`[TOOL] 🔧 Executing ${name} with args:`, args)

  switch (name) {
    case 'getProductList': {
      if (!products || products.length === 0) return ERROR_MESSAGES.productNotFound

      return (
        'PRODUCT_LIST:\n' +
        products
          .map((p, index) => {
            const name = (p.name || `Product ${index + 1}`).trim();
            const price = p.price ? `₦${parseFloat(p.price).toLocaleString()}` : 'Price on request';
            const negotiable = p.negotiationEnabled ? ' [Negotiable]' : '';
            return `${index + 1}. **${name}** - ${price}${negotiable}`;
          })
          .join('\n') +
        '\n\nWhich one are you interested in?'
      )
    }

    case 'getProductInfo': {
      const product = findBestProductMatch(args.productName, products);
      
      if (product) {
        const status = product.negotiationEnabled ? 'Negotiable' : 'Fixed price';
        return `PRODUCT_INFO:${JSON.stringify({
          name: product.name,
          price: product.price,
          description: product.description || 'No description provided.',
          status
        })}`
      }
      return ERROR_MESSAGES.productNotFound
    }

    case 'createOrder': {
      const orderId = `ORD-${Date.now()}-${phoneNumber.slice(-4)}`
      try {
        await db.collection('businesses').doc(businessId).collection('orders').doc(orderId).set({
          orderId,
          phoneNumber,
          productName: args.productName,
          quantity: args.quantity || 1,
          agreedPrice: args.agreedPrice || null,
          customerName: args.customerName || 'Pending',
          status: 'draft',
          createdAt: Date.now()
        })
        return `ORDER_CREATED:${orderId}: ${args.productName}`
      } catch (e) {
        console.error('[TOOL] Order creation failed:', e.message)
        return ERROR_MESSAGES.orderCreation
      }
    }

    case 'getPaymentDetails': {
      try {
        const reference = `REF-${Date.now()}-${phoneNumber.slice(-4)}`
        const amountToCharge = parseFloat(args.agreedPrice) || 0
        const targetProduct = args.productName || 'Order Transaction'
        const customerName = args.customerName || 'WhatsApp Client'

        if (amountToCharge <= 0) {
          return "We accept bank transfers via automated checkout. Could you confirm the item and price?"
        }

        console.log(`[KORAPAY] Creating dynamic account for ${reference}, amount: ${amountToCharge}`)

        const koraResponse = await axios.post(`https://api.korapay.com/v1/charges/bank-transfer`, {
          amount: amountToCharge,
          reference: reference,
          currency: 'NGN',
          notification_url: 'https://aromsg.up.railway.app/korapay-webhook',
          customer: {
            name: customerName,
            email: `${phoneNumber}@aromsg.app`
          },
          merchant_bears_cost: false
        }, {
          headers: { 
            'Authorization': `Bearer ${KORA_SECRET_KEY}`,
            'accept': 'application/json',
            'content-type': 'application/json'
          },
          timeout: 15000
        })

        const koraData = koraResponse.data

        if (koraData && koraData.status === true && koraData.data?.bank_account_number) {
          await db.collection('businesses').doc(businessId).collection('orders').doc(reference).set({
            reference,
            phoneNumber,
            amount: amountToCharge,
            product: targetProduct,
            customerName,
            status: 'pending',
            createdAt: Date.now(),
            orderLinked: true,
            koraRawResponse: koraData
          })

          return `RAW_KORAPAY_RESPONSE:${JSON.stringify({
            success: koraData.status,
            data: koraData.data,
            reference: reference,
            amount: amountToCharge,
            product: targetProduct,
            expiryMinutes: 20
          })}`
        }
        
        return `KORAPAY_FALLBACK_INFO: Ready to receive transfer for ${targetProduct} - Amount: ₦${amountToCharge} - Reference: ${reference}`

      } catch (koraErr) {
        console.error('[KORAPAY BACKEND ERROR]:', koraErr.response?.data || koraErr.message)
        return "We're having a small issue generating your payment account. Please try again in a moment."
      }
    }

    case 'checkOrderStatus': {
      try {
        const orderSnap = await db.collectionGroup('orders')
          .where('reference', '==', args.orderId)
          .limit(1)
          .get()
        
        if (!orderSnap.empty) {
          const order = orderSnap.docs[0].data()
          return `ORDER_STATUS:${order.status || 'unknown'}|${order.product || 'N/A'}|${order.amount || 0}`
        }
        return `ORDER_STATUS:NOT_FOUND`
      } catch (e) {
        return `Let me check that order status for you.`
      }
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
  
  const systemPrompt = `You are an expert sales person representing ${businessName} on WhatsApp.

${personality || 'You are friendly, smart, and business-focused.'}

${productsContext || 'No inventory data verified.'}

${CRITICAL_DIRECTIVES}`

  try {
    const formattedHistory = history.slice(-10).map((m) => ({
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
        temperature: 0.55,
        max_tokens: 850,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://aromsg.up.railway.app',
          'X-Title': 'AroMsg WhatsApp AI',
        },
        timeout: 25000,
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
const getRefinementDirectives = (businessName, currency) => `You are a real human merchant chatting on WhatsApp for ${businessName}.

**CRITICAL STYLE RULES:**
1. Keep the message short (1-2 sentences maximum). Be natural and direct.
2. Absolutely DO NOT show code syntax, raw JSON characters, or backticks.
3. NEVER use bold asterisks (**) in conversational text responses. Keep structural formatting for lists clean.
4. If raw Korapay data is present, extract the Bank, Account Number, and Account Name cleanly in regular clear lines so they can copy-paste easily. Don't add extra fluff.`

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
        timeout: 12000,
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
// POST-PAYMENT NOTIFICATION
// ========================
async function notifyPaymentSuccess(businessId, phoneNumber, orderData) {
  try {
    const message = `✅ *Payment received successfully!*\n\n` +
                   `Product: ${orderData.product || 'Your Order'}\n` +
                   `Amount: ₦${orderData.amount}\n` +
                   `Reference: ${orderData.reference}\n\n` +
                   `Thank you for your purchase! We'll process your order shortly.`

    await sendReplyViaGateway(businessId, `${phoneNumber}@s.whatsapp.net`, message)
    console.log(`[PAYMENT] ✅ Success notification sent to ${phoneNumber}`)
  } catch (e) {
    console.error('[PAYMENT] Notification failed:', e.message)
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
      const toolResult = await executeTool(aiResult.tool, userId, phoneNumber, context.products || [], context)

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
              { role: 'system', content: refinementPrompt },
              ...history.slice(-8).map((m) => ({
                role: m.role === 'user' ? 'user' : 'assistant',
                content: m.text,
              })),
              { role: 'user', content: text },
            ],
            temperature: 0.45,
            max_tokens: 500,
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
      } catch (refineErr) {
        console.error('[WEBHOOK] ⚠️ Refinement error:', refineErr.message)
        replyText = toolResult.replace(/RAW_KORAPAY_RESPONSE:|PRODUCT_LIST:|PRODUCT_INFO:|ORDER_/g, '').trim()
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
// KORAPAY WEBHOOK
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

  if (!verifyKoraSignature(body, signature)) {
    console.warn('Invalid Kora webhook signature received.')
    return res.status(200).json({ received: true })
  }

  res.status(200).json({ received: true })

  setImmediate(async () => {
    const data = body.data || {}
    const reference = data.reference || data.payment_reference || data.unique_reference || ''
    const event = body.event || ''

    console.log(`[KORA-WEBHOOK] 📨 Event: ${event}, Reference: ${reference}`)

    if (reference.startsWith('REF-') && event === 'charge.success') {
      console.log(`[KORA-WEBHOOK] ✅ Successful payment for WhatsApp order: ${reference}`)
      
      try {
        const ordersRef = db.collectionGroup('orders').where('reference', '==', reference)
        const snapshot = await ordersRef.get()

        if (!snapshot.empty) {
          for (const doc of snapshot.docs) {
            const orderData = doc.data()
            await doc.ref.update({
              status: 'success',
              updatedAt: Date.now(),
              rawWebhookPayload: body,
              paidAt: Date.now()
            })

            await notifyPaymentSuccess(doc.ref.parent.parent.id, orderData.phoneNumber, orderData)
          }
        }
      } catch (dbErr) {
        console.error('[KORA-WEBHOOK] Firestore update failure:', dbErr.message)
      }
    } 
    else if (reference.startsWith('PRODA-') || reference.includes('producta')) {
      await forwardToProduct(PRODUCT_A_WEBHOOK, body)
    } 
    else if (reference.startsWith('PRODB-') || reference.includes('productb')) {
      await forwardToProduct(PRODUCT_B_WEBHOOK, body)
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

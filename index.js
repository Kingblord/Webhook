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

function normalizeJid(jid) {
  if (!jid) return jid
  return jidNormalizedUser(jid)
}

// ========================
// PERSISTENT FIRESTORE CONTEXT TRACKING
// ========================
async function getOrCreateConversationContext(businessId, phoneNumber) {
  const cleanPhone = phoneNumber.replace(/\D/g, '')
  const docRef = db.collection('businesses').doc(businessId).collection('contexts').doc(cleanPhone)
  
  try {
    const doc = await docRef.get()
    if (doc.exists) {
      const data = doc.data()
      // If data is older than 45 minutes, clear negotiation round to prevent stale loop traps
      if (Date.now() - (data.lastInteraction || 0) > 2700000) {
        return {
          currentProduct: null,
          lastPrice: null,
          negotiationRound: 0,
          intent: 'browsing'
        }
      }
      return data
    }
  } catch (e) {
    console.error('[CONTEXT DB FETCH ERROR]:', e.message)
  }

  return {
    currentProduct: null,
    lastPrice: null,
    negotiationRound: 0,
    intent: 'browsing'
  }
}

async function saveConversationContext(businessId, phoneNumber, contextData) {
  const cleanPhone = phoneNumber.replace(/\D/g, '')
  const docRef = db.collection('businesses').doc(businessId).collection('contexts').doc(cleanPhone)
  try {
    await docRef.set({
      ...contextData,
      lastInteraction: Date.now()
    }, { merge: true })
  } catch (e) {
    console.error('[CONTEXT DB SAVE ERROR]:', e.message)
  }
}

// ========================
// HISTORY WITH CONCISE ANALYTICS
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

    const messages = snapshot.docs.map((doc) => doc.data()).reverse()
    const userMessages = messages.filter(m => m.role === 'user')
    const negotiationCount = messages.filter(m => m.text && (m.text.toLowerCase().includes('k') || m.text.toLowerCase().includes('000'))).length

    return {
      messages,
      count: messages.length,
      isPriceSensitive: negotiationCount > 3
    }
  } catch (err) {
    console.error('[DB] History fetch error:', err.message)
    return { messages: [], count: 0, isPriceSensitive: false }
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
        '\n📦 VERIFIED STORE INVENTORY:\n' +
        products
          .map((p) => {
            const negotiable = p.negotiationEnabled ? 'Yes' : 'No'
            const basePrice = parseFloat(p.price || 0)
            const floorPrice = parseFloat(p.minPrice || p.floorPrice || (basePrice * 0.88))
            return `• Item Name: ${p.name}\n  Store Price: ₦${basePrice.toLocaleString()}\n  Negotiable: ${negotiable}\n  INTERNAL_PROTECTED_FLOOR: ₦${floorPrice.toLocaleString()}\n  Description: ${p.description || 'Premium Stock'}`
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
// SECURE AI TOOLS STRUCT
// ========================
const AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'getProductList',
      description: 'Show list of all available store products.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getProductInfo',
      description: 'Get deep technical specs or details on a particular item.',
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
      name: 'makeCounterOffer',
      description: 'Call this ONLY when a customer requests a cheaper price or presents a lower counter offer counter budget. The backend handles strategy calculations.',
      parameters: {
        type: 'object',
        properties: {
          productName: { type: 'string', description: 'Exact name of product being negotiated' },
          customerOffer: { type: 'number', description: 'The absolute raw numeric price offer from user' }
        },
        required: ['productName', 'customerOffer'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'initiatePayment',
      description: 'CRITICAL: Run this instantly when the customer accepts an agreed price, says ok/cool/send account, or is ready to make transaction transfers.',
      parameters: {
        type: 'object',
        properties: {
          productName: { type: 'string', description: 'The product being bought' },
          agreedPrice: { type: 'number', description: 'The dynamic finalized transaction value' },
          customerName: { type: 'string', description: 'Known client name or leave empty' }
        },
        required: ['productName', 'agreedPrice']
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'checkOrderStatus',
      description: 'Verify payment or tracking records.',
      parameters: {
        type: 'object',
        properties: { orderId: { type: 'string' } },
        required: ['orderId'],
      },
    },
  },
]

// ========================
// ULTRA-HUMAN NIGERIAN TRADER DIRECTIVES
// ========================
const MASTER_DIRECTIVES = `
🎯 PERSONALITY DESIGN: YOU ARE A HUMAN NIGERIAN VENDOR TRADING ON WHATSAPP.
- Keep chats short (1-2 sentences absolute max). Avoid automated blocks of texts.
- Use natural, current urban Nigerian/Lagos trading phrases: "How far?", "Omo, that amount low o", "Make we do business na", "I dey online, data active", "Sharp sharp".
- BANNED: Never use raw markdown asterisks (**) across common messages. No brackets, no code text logs.

🔒 STRATEGIC BARGAINING RULES:
- Never say "Internal protected floor" or reveal bottom metrics.
- If a client bids drastically low, do NOT break or dump down to your lowest floor limits instantly. Step down gradually: Drop roughly 8% in Round 1, 12% in Round 2, and approach floor metrics only during desperate Round 3 push efforts.
- If their offer cleanly hits or matches above your internal protected metrics floor, lock the deal immediately and move directly to checking out.

⚡ INSTANT PAYMENT PROTOCOL:
- When the deal lands or the user gives explicit greenlights ("send account", "how can I pay", "cool", "I will pay"), you MUST call 'initiatePayment' tool instantly. Never fabricate fake banks, transfer tables, or placeholder digits.
`

function findBestProductMatch(query, products) {
  if (!query || !products.length) return null
  query = query.toLowerCase().trim()
  let bestMatch = null
  let highestScore = 0

  for (const product of products) {
    const name = (product.name || '').toLowerCase()
    let score = 0
    if (name === query) score = 1.0
    else if (name.includes(query) || query.includes(name)) score = 0.85
    if (score > highestScore) {
      highestScore = score
      bestMatch = product
    }
  }
  return highestScore > 0.4 ? bestMatch : null
}

// ========================
// RE-ENGINEERED NEGOTIATION MATRIX
// ========================
function calculateCounterOffer(customerOffer, listPrice, floorPrice, round) {
  if (customerOffer >= floorPrice) {
    return {
      price: customerOffer,
      strategy: 'accept',
      message: 'Deal locked! Let me get your invoice'
    }
  }

  if (round <= 1) {
    const targetPrice = Math.max(listPrice * 0.91, floorPrice * 1.12)
    return {
      price: Math.round(targetPrice),
      strategy: 'round_1_hold',
      message: `Abeg that one low o. Let's do ₦${Math.round(targetPrice).toLocaleString()}`
    }
  } else if (round === 2) {
    const targetPrice = Math.max(listPrice * 0.85, floorPrice * 1.05)
    return {
      price: Math.round(targetPrice),
      strategy: 'round_2_push',
      message: `Last offer make we run am sharp sharp: ₦${Math.round(targetPrice).toLocaleString()}`
    }
  } else {
    if (customerOffer >= floorPrice * 0.95) {
      return {
        price: Math.round(floorPrice),
        strategy: 'absolute_floor',
        message: `Omo I am not making profit but just take am for ₦${Math.round(floorPrice).toLocaleString()}`
      }
    }
    return {
      price: null,
      strategy: 'hard_reject',
      message: `Capital never complete for that side boss. Best price is ₦${Math.round(floorPrice * 1.03).toLocaleString()}`
    }
  }
}

// ========================
// HARDENED TOOL EXECUTION
// ========================
async function executeTool(toolCall, businessId, phoneNumber, products = [], convContext) {
  const { name, arguments: argsStr } = toolCall.function
  let args = {}
  try {
    args = JSON.parse(argsStr || '{}')
  } catch (e) {
    console.error('[TOOL PARSE FAILURE]:', e.message)
  }

  console.log(`[EXECUTING SERVICE LAYER]: 🔧 ${name}`)

  switch (name) {
    case 'getProductList': {
      if (!products.length) return 'RESULT: No items cataloged.'
      convContext.intent = 'browsing'
      const list = products.map((p, i) => `${i + 1}. **${p.name}** - ₦${parseFloat(p.price).toLocaleString()}`).join('\n')
      return `RESULT:STORE_LISTING\n${list}`
    }

    case 'getProductInfo': {
      const item = findBestProductMatch(args.productName, products)
      if (!item) return 'RESULT: Product profile out of stock.'
      convContext.currentProduct = item.name
      convContext.intent = 'interested'
      return `RESULT:PRODUCT_META\nName: ${item.name}\nPrice: ₦${parseFloat(item.price).toLocaleString()}\nSpecs: ${item.description || 'Standard'}`
    }

    case 'makeCounterOffer': {
      const item = findBestProductMatch(args.productName, products)
      if (!item) return 'RESULT: Selected item matching profile is unavailable.'

      const listPrice = parseFloat(item.price || 0)
      const floorPrice = parseFloat(item.minPrice || item.floorPrice || (listPrice * 0.88))
      
      convContext.currentProduct = item.name
      convContext.negotiationRound += 1
      convContext.intent = 'negotiating'

      const contract = calculateCounterOffer(args.customerOffer, listPrice, floorPrice, convContext.negotiationRound)
      if (contract.strategy === 'accept') {
        convContext.lastPrice = args.customerOffer
      } else if (contract.price) {
        convContext.lastPrice = contract.price
      }

      return `RESULT:NEGOTIATION_OUTCOME\n${JSON.stringify(contract)}`
    }

    case 'initiatePayment': {
      try {
        const reference = `REF-${Date.now()}-${phoneNumber.slice(-4)}`
        const checkAmount = parseFloat(args.agreedPrice) || 0
        const tag = args.productName || 'Inventory Order'

        if (checkAmount <= 0) return 'RESULT: Invalid pricing parameters.'

        convContext.intent = 'buying'
        convContext.lastPrice = checkAmount

        const koraResponse = await axios.post(
          `https://api.korapay.com/v1/charges/bank-transfer`,
          {
            amount: checkAmount,
            reference: reference,
            currency: 'NGN',
            notification_url: 'https://aromsg.up.railway.app/korapay-webhook',
            customer: { name: 'WhatsApp Buyer', email: `${phoneNumber}@aromsg.app` },
            merchant_bears_cost: false
          },
          { headers: { 'Authorization': `Bearer ${KORA_SECRET_KEY}` }, timeout: 15000 }
        )

        const payload = koraResponse.data
        if (payload?.status === true && payload.data?.bank_account_number) {
          const wire = payload.data
          await db.collection('businesses').doc(businessId).collection('orders').doc(reference).set({
            reference,
            phoneNumber: phoneNumber.replace(/\D/g, ''),
            amount: checkAmount,
            product: tag,
            status: 'pending',
            createdAt: Date.now()
          })

          return `RESULT:KORA_DYNAMIC_WIRE\nBank: ${wire.bank_name}\nAccountNumber: ${wire.bank_account_number}\nAccountName: ${wire.account_name}\nAmount: ₦${checkAmount.toLocaleString()}\nReference: ${reference}`
        }
        return 'RESULT: Dynamic channels unaligned. Try again.'
      } catch (err) {
        console.error('[KORAPAY CRITICAL]:', err.response?.data || err.message)
        return 'RESULT: Payment interface unreachable.'
      }
    }

    case 'checkOrderStatus': {
      try {
        const snap = await db.collectionGroup('orders').where('reference', '==', args.orderId).limit(1).get()
        if (!snap.empty) {
          const match = snap.docs[0].data()
          return `RESULT:INVOICE_STATUS\nStatus: ${match.status}\nItem: ${match.product}\nSum: ₦${match.amount?.toLocaleString()}`
        }
        return 'RESULT: Invoice trace not found.'
      } catch (e) {
        return 'RESULT: Query route error.'
      }
    }
    default:
      return 'RESULT: Action undefined.'
  }
}

// ========================
// ENGINE PIPELINES
// ========================
async function getAIResponse(businessContext, historyPackage, userMessage, convContext) {
  const { businessName, aiPersonality, productsContext } = businessContext
  const { messages } = historyPackage

  const analyticalState = `
[LIVE ENGINE STATE TRACKING]
- FocusProduct: ${convContext.currentProduct || 'None'}
- CustomRound: ${convContext.negotiationRound}
- TargetLastPrice: ${convContext.lastPrice ? `₦${convContext.lastPrice}` : 'None'}
- CurrentIntent: ${convContext.intent}
`

  const systemPrompt = `${MASTER_DIRECTIVES}
BUSINESS NAME: ${businessName}
PERSONALITY OVERLAY: ${aiPersonality || ''}
${productsContext}
${analyticalState}
CRITICAL: Match actions meticulously. Keep lines down to casual 1-2 sentence frames.`

  try {
    const structuredHistory = messages.slice(-12).map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.text
    }))

    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: OPENROUTER_MODEL,
        messages: [{ role: 'system', content: systemPrompt }, ...structuredHistory, { role: 'user', content: userMessage }],
        tools: AI_TOOLS,
        tool_choice: 'auto',
        temperature: 0.5,
      },
      { headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` }, timeout: 22000 }
    )

    const choice = response.data.choices[0]?.message
    if (choice.tool_calls?.length > 0) {
      return { type: 'tool_call', tool: choice.tool_calls[0] }
    }
    return { type: 'text', content: choice.content?.trim() || 'I look you, give me one sec' }
  } catch (err) {
    console.error('[CORE REASONING LOOP ERROR]:', err.message)
    return { type: 'text', content: 'Deji, let me confirm something sharp.' }
  }
}

async function synthesizeResponse(toolResult, businessName, userMessage, history) {
  const customPrompt = `You are a native Nigerian individual running sales operations on WhatsApp for ${businessName}.
Transform the raw data context block into an extremely clean, organic, human text response.

RULES:
1. MAX 1-2 short casual conversational sentences.
2. ABSOLUTELY NO BOLD MARKDOWN ASTERISKS (**). Keep things clean and flat.
3. If the data details bank accounts (KORA_DYNAMIC_WIRE), write out the Bank Name, Account Number, and Account Name plainly on split clean clear lines so they can copy-paste easily.

RAW SYSTEM DATA SUMMARY:
${toolResult}

CONVERSATION TIMELINE:
${history.slice(-3).map(m => `${m.role}: ${m.text}`).join('\n')}`

  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: OPENROUTER_MODEL,
        messages: [{ role: 'system', content: customPrompt }, { role: 'user', content: userMessage }],
        temperature: 0.4,
      },
      { headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` }, timeout: 15000 }
    )
    return res.data.choices[0]?.message?.content?.trim() || toolResult
  } catch (e) {
    return toolResult.replace(/RESULT:|[{}""[\]]/g, '').trim()
  }
}

// ========================
// PERSISTENCE LAYERS
// ========================
async function saveMessage(businessId, phoneNumber, role, text, messageId) {
  try {
    const cleanNum = phoneNumber.replace(/\D/g, '')
    await db.collection('businesses').doc(businessId).collection('whatsapp_messages').add({
      contactJid: cleanNum,
      from: role === 'user' ? cleanNum : businessId,
      to: role === 'user' ? businessId : cleanNum,
      text,
      role,
      messageId,
      timestamp: Date.now()
    })
    return true
  } catch (e) {
    return false
  }
}

async function sendReplyViaGateway(userId, jid, text) {
  try {
    await axios.post(`${GATEWAY_URL}/send-message`, { userId, to: normalizeJid(jid), text }, {
      headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` }, timeout: 12000
    })
    return true
  } catch (e) {
    console.error('[GATEWAY FAILURE]:', e.message)
    return false
  }
}

// ========================
// WEBHOOK ROUTERS
// ========================
app.post('/webhook', async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${INTERNAL_API_KEY}`) {
      return res.status(401).json({ success: false })
    }

    const { userId, from, text, messageId } = req.body
    if (!userId || !from || !text) return res.status(400).json({ error: 'Payload empty' })

    const normalizedFrom = normalizeJid(from)
    const phoneNumber = normalizedFrom.replace('@s.whatsapp.net', '')

    const storeContext = await getBusinessContext(userId)
    if (!storeContext) return res.status(404).json({ error: 'Store missed' })

    // Load persistent state context directly from FireStore
    const convContext = await getOrCreateConversationContext(userId, phoneNumber)
    const structuralHistory = await getConversationHistory(userId, phoneNumber)

    const routingDecision = await getAIResponse(storeContext, structuralHistory, text, convContext)

    let definitiveReply

    if (routingDecision.type === 'tool_call') {
      const internalExecution = await executeTool(routingDecision.tool, userId, phoneNumber, storeContext.products, convContext)
      definitiveReply = await synthesizeResponse(internalExecution, storeContext.businessName, text, structuralHistory.messages)
    } else {
      definitiveReply = routingDecision.content
    }

    // Sanitize technical leak strings
    definitiveReply = definitiveReply
      .replace(/```json|```/gi, '')
      .replace(/RESULT:|PRODUCT_LIST:|PAYMENT_DETAILS:|KORA_DYNAMIC_WIRE/gi, '')
      .trim()

    await saveMessage(userId, phoneNumber, 'user', text, messageId || `in_${Date.now()}`)
    await saveMessage(userId, phoneNumber, 'assistant', definitiveReply, `ai_${Date.now()}`)
    
    // Core state save back to FireStore database
    await saveConversationContext(userId, phoneNumber, convContext)
    await sendReplyViaGateway(userId, normalizedFrom, definitiveReply)

    res.json({ success: true, intent: convContext.intent })
  } catch (err) {
    console.error('[ROUTING EXCEPTION]:', err.message)
    res.status(500).json({ success: false })
  }
})

// ========================
// KORAPAY WEBHOOK VERIFICATION
// ========================
function verifyKoraSignature(body, signature) {
  if (!signature || !KORA_SECRET_KEY) return false
  try {
    const payloadString = JSON.stringify(body.data)
    const hash = crypto.createHmac('sha256', KORA_SECRET_KEY).update(payloadString).digest('hex')
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature))
  } catch {
    return false
  }
}

app.post('/korapay-webhook', async (req, res) => {
  const signature = req.headers['x-korapay-signature']
  const body = req.body

  if (!verifyKoraSignature(body, signature)) return res.status(200).json({ received: true })
  res.status(200).json({ received: true })

  setImmediate(async () => {
    const data = body.data || {}
    const reference = data.reference || data.payment_reference || ''
    if (reference.startsWith('REF-') && body.event === 'charge.success') {
      try {
        const snapshot = await db.collectionGroup('orders').where('reference', '==', reference).limit(1).get()
        if (!snapshot.empty) {
          const docTarget = snapshot.docs[0]
          const orderData = docTarget.data()
          await docTarget.ref.update({ status: 'success', paidAt: Date.now() })

          const summaryAlert = `✅ *Payment Confirmed!* \n\nReceived payment for: ${orderData.product}\nValue: ₦${orderData.amount.toLocaleString()}\n\nProcessing order details immediately! 🚀`
          await sendReplyViaGateway(docTarget.ref.parent.parent.id, `${orderData.phoneNumber}@s.whatsapp.net`, summaryAlert)
        }
      } catch (e) {
        console.error('[KORA MATCH FAIL]:', e.message)
      }
    }
  })
})

app.get('/health', (req, res) => res.json({ status: 'online', memory: process.memoryUsage().heapUsed / 1024 / 1024 }))

app.listen(PORT, () => console.log(`🚀 Production Architecture Scaled On Port ${PORT}`))

module.exports = app

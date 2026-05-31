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

const KORAPAY_SECRET_KEY = process.env.KORAPAY_SECRET_KEY || process.env.KORA_SECRET_KEY || ''
const KORAPAY_PUBLIC_KEY = process.env.KORAPAY_PUBLIC_KEY || process.env.KORA_PUBLIC_KEY || ''

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
    return { messages, count: messages.length }
  } catch (err) {
    console.error('[DB] History fetch error:', err.message)
    return { messages: [], count: 0 }
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
      description: 'Call this ONLY when a customer requests a cheaper price or presents a lower counter offer.',
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
      description: 'CRITICAL: Run this instantly when the customer accepts an agreed price, says ok/cool/send account, or is ready to make a transfer.',
      parameters: {
        type: 'object',
        properties: {
          productName: { type: 'string', description: 'The product being bought' },
          agreedPrice: { type: 'number', description: 'The dynamic finalized transaction value' }
        },
        required: ['productName', 'agreedPrice']
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'checkOrderStatus',
      description: 'Verify payment or tracking records using the tracking reference ID.',
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
- When the deal lands or the user gives explicit greenlights ("send account", "how can I pay", "cool", "send gimme na"), you MUST call 'initiatePayment' tool instantly. Never fabricate fake banks, transfer tables, or placeholder digits.
- CRITICAL: You must wait for the actual real bank credentials from the API. Never make up or fake an account number or bank name if the data is not fully fetched.
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

function calculateCounterOffer(customerOffer, listPrice, floorPrice, round) {
  if (customerOffer >= floorPrice) {
    return {
      price: customerOffer,
      strategy: 'accept',
      message: 'Deal locked! Let me get your link setup'
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

// ============================================================================
// 🏦 INLINE 4-STEP RECURSIVE BANK TRANSFERS WITH END-TO-END TELEMETRY LOGGING
// ============================================================================
async function executeTool(toolCall, businessId, phoneNumber, products = [], convContext) {
  const { name, arguments: argsStr } = toolCall.function
  let args = {}
  try {
    args = JSON.parse(argsStr || '{}')
  } catch (e) {
    console.error('[TOOL PARSE FAILURE]:', e.message)
  }

  // Injecting explicit Authorization header blocks to prevent placeholder fallbacks
  const authenticatedHeaders = {
    'accept': 'application/json',
    'content-type': 'application/json',
    'Authorization': `Bearer ${KORAPAY_SECRET_KEY}`,
    'priority': 'u=1, i',
    'sec-ch-ua': '"Microsoft Edge";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin'
  }

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

        // --------------------------------------------------------------------
        // LOG STEP 1: CREATE PAYMENT LINK REQUEST/RESPONSE
        // --------------------------------------------------------------------
        const step1Payload = {
          key: KORAPAY_PUBLIC_KEY, 
          reference: reference,
          amount: checkAmount,
          currency: "NGN",
          customer: {
            name: "WhatsApp Client",
            email: `${phoneNumber}@aromsg.app`
          },
          notification_url: "https://lit-proxy.vercel.app/api/proxy?provider=kora"
        }
        console.log(`📡 [LOG STEP 1 REQUEST] Outbound URL: https://checkout.korapay.com/?type=payment-link`, JSON.stringify(step1Payload, null, 2));
        
        const createRes = await axios.post(
          'https://checkout.korapay.com/?type=payment-link',
          step1Payload,
          { headers: authenticatedHeaders, timeout: 15000 }
        )
        console.log(`📨 [LOG STEP 1 RESPONSE] Raw Inbound:`, JSON.stringify(createRes.data, null, 2));

        // --------------------------------------------------------------------
        // LOG STEP 2: VALIDATE LINK LOOKUP REQUEST/RESPONSE
        // --------------------------------------------------------------------
        const step2Payload = { slug: reference, env: 'live' }
        console.log(`📡 [LOG STEP 2 REQUEST] Outbound URL: https://checkout.korapay.com/validate-link`, JSON.stringify(step2Payload, null, 2));
        
        const validateRes = await axios.post(
          'https://checkout.korapay.com/validate-link',
          step2Payload,
          { headers: authenticatedHeaders, timeout: 15000 }
        )
        console.log(`📨 [LOG STEP 2 RESPONSE] Raw Inbound:`, JSON.stringify(validateRes.data, null, 2));

        const lookupDetails = validateRes.data?.data
        const sessionTransactionId = lookupDetails?.txn_id || lookupDetails?.id || reference

        // --------------------------------------------------------------------
        // LOG STEP 3: BANK CHARGE REQUEST/RESPONSE
        // --------------------------------------------------------------------
        const step3Payload = {
          transaction_id: sessionTransactionId,
          bank_code: "090270", 
          env: 'live'
        }
        console.log(`📡 [LOG STEP 3 REQUEST] Outbound URL: https://checkout.korapay.com/bank/charge`, JSON.stringify(step3Payload, null, 2));
        
        const bankChargeRes = await axios.post(
          'https://checkout.korapay.com/bank/charge',
          step3Payload,
          { headers: authenticatedHeaders, timeout: 15000 }
        )
        console.log(`📨 [LOG STEP 3 RESPONSE] Raw Inbound:`, JSON.stringify(bankChargeRes.data, null, 2));

        const bankData = bankChargeRes.data?.data || {}
        const dynamicAccountNumber = bankData.account_number || bankData.payment_details?.account_number
        const dynamicBankName = bankData.bank_name || bankData.payment_details?.bank_name

        // Intercept placeholder objects. Force a strict retry loop state if details are missing.
        if (!dynamicAccountNumber || dynamicAccountNumber === '0000000000') {
          console.warn(`⚠️ [AUTHENTICATION WARN] Server received empty or mock fallback account parameters. Intercepting response parsing layer.`);
          return `RESULT:SYSTEM_BUSY_RETRY\nMessage: System is updating bank configuration records. Please hold on for a minute.`
        }

        // Save valid transaction safely inside Firestore database
        await db.collection('businesses').doc(businessId).collection('orders').doc(reference).set({
          reference,
          phoneNumber: phoneNumber.replace(/\D/g, ''),
          amount: checkAmount,
          product: tag,
          status: 'pending',
          createdAt: Date.now(),
          generatedAccount: dynamicAccountNumber,
          generatedBank: dynamicBankName
        })

        return `RESULT:BANK_TRANSFER_PAYLOAD_GENERATION\nAmount: ₦${checkAmount.toLocaleString()}\nReference: ${reference}\nBankAccountNumber: ${dynamicAccountNumber}\nBankName: ${dynamicBankName}`
        
      } catch (err) {
        console.error('❌ [4-STEP TELEMETRY PIPELINE RUNTIME ERROR]:', err.response?.data || err.message)
        return `RESULT:SYSTEM_BUSY_RETRY\nMessage: Network interface timed out while creating account. Please try again.`
      }
    }

    case 'checkOrderStatus': {
      try {
        console.log(`🔍 [VERIFY ENGINE ACTIVE]: Checking validation status for reference ID: ${args.orderId}`);
        
        const verifyAltRes = await axios.post(
          'https://checkout.korapay.com/validate-link',
          { slug: args.orderId, env: 'live' },
          { headers: authenticatedHeaders, timeout: 15000 }
        )

        const verifyData = verifyAltRes.data
        const isPaymentSuccessful = verifyData.success && 
          (verifyData.data?.data?.status === 'success' || 
           verifyData.data?.data?.payment_status === 'success' ||
           verifyData.data?.status === true)

        if (isPaymentSuccessful) {
          return `RESULT:INVOICE_STATUS\nStatus: confirmed\nReference: ${args.orderId}`
        }
        return `RESULT:INVOICE_STATUS\nStatus: pending_confirmation\nReference: ${args.orderId}`
      } catch (e) {
        return 'RESULT: Query route verification timed out.'
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
    return { type: 'text', content: choice.content?.trim() || 'One sec let me look into that.' }
  } catch (err) {
    console.error('[CORE REASONING LOOP ERROR]:', err.message)
    return { type: 'text', content: 'Let me confirm that for you real quick.' }
  }
}

async function synthesizeResponse(toolResult, businessName, userMessage, history) {
  // Catch system fallback/retry indicators and tell the user directly to wait a brief second instead of generating fake account text.
  if (toolResult.includes('SYSTEM_BUSY_RETRY')) {
    return "Hold on a second, boss. Let me refresh the network line to generate your bank transfer credentials real quick."
  }

  const customPrompt = `You are a native Nigerian individual running sales operations on WhatsApp for ${businessName}.
Transform the raw system data payload directly into a short, natural, conversational human text response.

RULES:
1. MAX 1-2 short casual sentences. Do not spam words.
2. ABSOLUTELY NO BOLD MARKDOWN ASTERISKS (**). Keep text completely flat and clean.
3. Inform them directly of the exact bank name and dynamic bank account number found in the system data summary so they can perform the transfer instantly.

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
// MAIN WEBHOOK ENTRY
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

    definitiveReply = definitiveReply
      .replace(/```json|```/gi, '')
      .replace(/RESULT:|PRODUCT_LIST:|PAYMENT_DETAILS:|BANK_TRANSFER_PAYLOAD_GENERATION/gi, '')
      .trim()

    await saveMessage(userId, phoneNumber, 'user', text, messageId || `in_${Date.now()}`)
    await saveMessage(userId, phoneNumber, 'assistant', definitiveReply, `ai_${Date.now()}`)
    
    await saveConversationContext(userId, phoneNumber, convContext)
    await sendReplyViaGateway(userId, normalizedFrom, definitiveReply)

    res.json({ success: true, intent: convContext.intent })
  } catch (err) {
    console.error('[ROUTING EXCEPTION]:', err.message)
    res.status(500).json({ success: false })
  }
})

// ============================================================================
// 🪝 LISTENER FOR MULTIPLEXER ROUTER WEBHOOK (POST EVENTS GENERATOR)
// ============================================================================
app.post('/korapay-webhook', async (req, res) => {
  const body = req.body

  console.log('📦 Multiplexer forwarded event captured.');
  res.status(200).json({ success: true, message: "Webhook payload cached" })

  setImmediate(async () => {
    const data = body.data || {}
    const reference = data.reference || ''
    const bankDetails = data.counter_party || {}
    const accountNumber = bankDetails.account_number || 'N/A'
    const bankName = bankDetails.bank_name || 'Transfer'

    if (body.event === 'charge.success' && data.status === 'success') {
      try {
        console.log(`🔍 [VERIFY OPERATION]: Confirming transaction state parameters against reference: ${reference}`)
        
        const verifyAltRes = await axios.post(
          'https://checkout.korapay.com/validate-link',
          { slug: reference, env: 'live' },
          {
            headers: {
              'accept': 'application/json',
              'content-type': 'application/json',
              'Authorization': `Bearer ${KORAPAY_SECRET_KEY}`
            },
            timeout: 15000
          }
        )

        const verifyData = verifyAltRes.data
        const isPaymentSuccessful = verifyData.success && 
          (verifyData.data?.data?.status === 'success' || 
           verifyData.data?.data?.payment_status === 'success' ||
           verifyData.data?.status === true)

        if (!isPaymentSuccessful) {
          console.warn(`⚠️ Verification block failed for transaction: ${reference}`)
          return
        }

        const snapshot = await db.collectionGroup('orders').where('reference', '==', reference).limit(1).get()
        if (!snapshot.empty) {
          const docTarget = snapshot.docs[0]
          const orderData = docTarget.data()
          
          await docTarget.ref.update({ 
            status: 'success', 
            paidAt: Date.now(),
            accountVerified: accountNumber
          })

          const cleanPhone = orderData.phoneNumber
          const businessId = docTarget.ref.parent.parent.id
          await db.collection('businesses').doc(businessId).collection('contexts').doc(cleanPhone).update({
            currentProduct: null,
            lastPrice: null,
            negotiationRound: 0,
            intent: 'browsing'
          })

          const receiptAlert = `🧾 *TRANSACTION RECEIPT*
----------------------------------------
🛍️ *Product:* ${orderData.product}
💰 *Amount Paid:* ₦${orderData.amount.toLocaleString()}
🆔 *Reference:* ${reference}
🏦 *Paid Via:* ${bankName} (${accountNumber})
📅 *Status:* Payment Confirmed Successfully

Thank you for your patronage! Your order is being processed sharp sharp. 🚀`

          await sendReplyViaGateway(businessId, `${cleanPhone}@s.whatsapp.net`, receiptAlert)
          console.log(`✅ Receipt dispatched successfully for reference ${reference}`)
        }
      } catch (e) {
        console.error('[WEBHOOK FAULT EXCEPTION]:', e.response?.data || e.message)
      }
    }
  })
})

app.get('/health', (req, res) => res.json({ status: 'online', memory: process.memoryUsage().heapUsed / 1024 / 1024 }))

app.listen(PORT, () => console.log(`🚀 Dedicated Production Engine Running Inline 4-Step Hook Arrays On Port ${PORT}`))

module.exports = app

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
    await db.runTransaction(async (transaction) => {
      transaction.set(docRef, {
        ...contextData,
        lastInteraction: Date.now()
      }, { merge: true })
    })
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
            return `• Item Name: \( {p.name}\n  Store Price: ₦ \){basePrice.toLocaleString()}\n  Negotiable: \( {negotiable}\n  INTERNAL_PROTECTED_FLOOR: ₦ \){floorPrice.toLocaleString()}\n  Description: ${p.description || 'Premium Stock'}`
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
  { type: 'function', function: { name: 'getProductList', description: 'Show list of all available store products.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'getProductInfo', description: 'Get deep technical specs or details on a particular item.', parameters: { type: 'object', properties: { productName: { type: 'string' } }, required: ['productName'] } } },
  { type: 'function', function: { name: 'makeCounterOffer', description: 'Call this ONLY when a customer requests a cheaper price or presents a lower counter offer.', parameters: { type: 'object', properties: { productName: { type: 'string' }, customerOffer: { type: 'number' } }, required: ['productName', 'customerOffer'] } } },
  { type: 'function', function: { name: 'initiatePayment', description: 'CRITICAL: Run this instantly when the customer accepts an agreed price.', parameters: { type: 'object', properties: { productName: { type: 'string' }, agreedPrice: { type: 'number' } }, required: ['productName', 'agreedPrice'] } } },
  { type: 'function', function: { name: 'checkOrderStatus', description: 'Verify payment using reference ID.', parameters: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] } } }
]

// ========================
// ULTRA-HUMAN NIGERIAN TRADER DIRECTIVES
// ========================
const MASTER_DIRECTIVES = `
🎯 PERSONALITY DESIGN: YOU ARE A HUMAN NIGERIAN VENDOR TRADING ON WHATSAPP.
- Keep chats short (1-2 sentences absolute max).
- Use natural Lagos trading phrases: "How far?", "Omo, that amount low o", "Sharp sharp".
- BANNED: Never use markdown ** or code blocks.
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
    return { price: customerOffer, strategy: 'accept', message: 'Deal locked! Let me get your link setup' }
  }
  if (round <= 1) {
    const targetPrice = Math.max(listPrice * 0.91, floorPrice * 1.12)
    return { price: Math.round(targetPrice), strategy: 'round_1_hold', message: `Abeg that one low o. Let's do ₦${Math.round(targetPrice).toLocaleString()}` }
  } else if (round === 2) {
    const targetPrice = Math.max(listPrice * 0.85, floorPrice * 1.05)
    return { price: Math.round(targetPrice), strategy: 'round_2_push', message: `Last offer make we run am sharp sharp: ₦${Math.round(targetPrice).toLocaleString()}` }
  } else {
    if (customerOffer >= floorPrice * 0.95) {
      return { price: Math.round(floorPrice), strategy: 'absolute_floor', message: `Omo I am not making profit but just take am for ₦${Math.round(floorPrice).toLocaleString()}` }
    }
    return { price: null, strategy: 'hard_reject', message: `Capital never complete for that side boss. Best price is ₦${Math.round(floorPrice * 1.03).toLocaleString()}` }
  }
}

// ============================================================================
// DIRECT KORAPAY 4-STEP EXECUTOR (No Proxy)
// ============================================================================
async function executeTool(toolCall, businessId, phoneNumber, products = [], convContext) {
  const { name, arguments: argsStr } = toolCall.function
  let args = {}
  try {
    args = JSON.parse(argsStr || '{}')
  } catch (e) {
    console.error('[TOOL PARSE FAILURE]:', e.message)
  }

  const nativeCheckoutHeaders = {
    'accept': 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
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
      const list = products.map((p, i) => `${i + 1}. \( {p.name} - ₦ \){parseFloat(p.price).toLocaleString()}`).join('\n')
      return `RESULT:STORE_LISTING\n${list}`
    }

    case 'getProductInfo': {
      const item = findBestProductMatch(args.productName, products)
      if (!item) return 'RESULT: Product profile out of stock.'
      convContext.currentProduct = item.name
      convContext.intent = 'interested'
      return `RESULT:PRODUCT_META\nName: \( {item.name}\nPrice: ₦ \){parseFloat(item.price).toLocaleString()}\nSpecs: ${item.description || 'Standard'}`
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
      if (contract.strategy === 'accept') convContext.lastPrice = args.customerOffer
      else if (contract.price) convContext.lastPrice = contract.price

      return `RESULT:NEGOTIATION_OUTCOME\n${JSON.stringify(contract)}`
    }

    case 'initiatePayment': {
      try {
        const reference = `REF-\( {Date.now()}- \){phoneNumber.slice(-4)}`
        const checkAmount = parseFloat(args.agreedPrice) || 0
        const tag = args.productName || 'Inventory Order'

        if (checkAmount <= 0) return 'RESULT: Invalid pricing parameters.'

        convContext.intent = 'buying'
        convContext.lastPrice = checkAmount

        // STEP 1: CREATE PAYMENT LINK
        const step1Payload = {
          key: KORAPAY_PUBLIC_KEY,
          reference: reference,
          amount: checkAmount,
          currency: "NGN",
          customer: { name: "WhatsApp Client", email: `${phoneNumber}@aromsg.app` },
          notification_url: "https://yourdomain.com/api/korapay-webhook" // Update with your actual webhook URL
        }

        console.log(`📡 [CREATE-PAYMENT]`, JSON.stringify(step1Payload, null, 2))
        const createRes = await axios.post('https://checkout.korapay.com/?type=payment-link', step1Payload, { headers: nativeCheckoutHeaders, timeout: 15000 })

        // STEP 2: VALIDATE LINK
        const step2Payload = { slug: reference, env: 'live' }
        console.log(`📡 [VALIDATE-LINK]`, JSON.stringify(step2Payload, null, 2))
        const validateRes = await axios.post('https://checkout.korapay.com/validate-link', step2Payload, { headers: nativeCheckoutHeaders, timeout: 15000 })

        const lookupDetails = validateRes.data?.data?.data || validateRes.data?.data
        const sessionTransactionId = lookupDetails?.txn_id || lookupDetails?.id || reference

        // STEP 3: BANK CHARGE
        const step3Payload = { transaction_id: sessionTransactionId, bank_code: "090270", env: 'live' }
        console.log(`📡 [BANK-CHARGE]`, JSON.stringify(step3Payload, null, 2))
        const bankChargeRes = await axios.post('https://checkout.korapay.com/bank/charge', step3Payload, { headers: nativeCheckoutHeaders, timeout: 15000 })

        const bankData = bankChargeRes.data?.data || {}
        const dynamicAccountNumber = bankData.account_number || bankData.payment_details?.account_number
        const dynamicBankName = bankData.bank_name || bankData.payment_details?.bank_name

        if (!dynamicAccountNumber || dynamicAccountNumber === '0000000000') {
          console.warn(`⚠️ [MOCK DETECTED] Missing account details`)
          return `RESULT:KORA_API_FETCH_FAILED`
        }

        // Save order
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
        console.error('❌ [PIPELINE RUNTIME FAULT]:', err.response?.data || err.message)
        return `RESULT:KORA_API_FETCH_FAILED`
      }
    }

    case 'checkOrderStatus': {
      try {
        console.log(`🔍 [VERIFY] Checking reference: ${args.orderId}`)
        const verifyRes = await axios.post(
          'https://checkout.korapay.com/validate-link',
          { slug: args.orderId, env: 'live' },
          { headers: nativeCheckoutHeaders, timeout: 15000 }
        )

        const verifyData = verifyRes.data
        const isPaymentSuccessful = verifyData.success && 
          (verifyData.data?.data?.status === 'success' || 
           verifyData.data?.data?.payment_status === 'success' ||
           verifyData.data?.status === true)

        return isPaymentSuccessful 
          ? `RESULT:INVOICE_STATUS\nStatus: confirmed\nReference: ${args.orderId}`
          : `RESULT:INVOICE_STATUS\nStatus: pending_confirmation\nReference: ${args.orderId}`
      } catch (e) {
        return 'RESULT: Query route verification timed out.'
      }
    }

    default:
      return 'RESULT: Action undefined.'
  }
}

// ========================
// ENGINE PIPELINES (Unchanged)
// ========================
async function getAIResponse(businessContext, historyPackage, userMessage, convContext) {
  const { businessName, aiPersonality, productsContext } = businessContext
  const { messages } = historyPackage

  const analyticalState = `
[LIVE ENGINE STATE TRACKING]
- FocusProduct: ${convContext.currentProduct || 'None'}
- CustomRound: ${convContext.negotiationRound}
- TargetLastPrice: \( {convContext.lastPrice ? `₦ \){convContext.lastPrice}` : 'None'}
- CurrentIntent: ${convContext.intent}
`

  const systemPrompt = `${MASTER_DIRECTIVES}
BUSINESS NAME: ${businessName}
PERSONALITY OVERLAY: ${aiPersonality || ''}
${productsContext}
${analyticalState}
CRITICAL: Match actions meticulously. Keep responses short.`

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
  if (toolResult.includes('KORA_API_FETCH_FAILED')) {
    return "Hold on a second, boss. The network line to generate your bank transfer details is loading, let me re-trigger it real quick."
  }

  const customPrompt = `You are a native Nigerian trader on WhatsApp for ${businessName}.
Turn the raw system data into short, natural message.
MAX 1-2 sentences. No markdown.

RAW DATA:
${toolResult}

Recent chat:
\( {history.slice(-3).map(m => ` \){m.role}: ${m.text}`).join('\n')}`

  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      { model: OPENROUTER_MODEL, messages: [{ role: 'system', content: customPrompt }, { role: 'user', content: userMessage }], temperature: 0.4 },
      { headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` }, timeout: 15000 }
    )
    return res.data.choices[0]?.message?.content?.trim() || toolResult
  } catch (e) {
    return toolResult.replace(/RESULT:|[{}""[\]]/g, '').trim()
  }
}

// ========================
// PERSISTENCE & GATEWAY (Unchanged)
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
// MAIN WEBHOOK
// ========================
app.post('/webhook', async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${INTERNAL_API_KEY}`) return res.status(401).json({ success: false })

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

    if (routingDecision.type === 'tool_call' && routingDecision.tool.function.name === 'initiatePayment') {
      const loadingPhrase = "Hold on na, make I get your account transfer details sharp sharp..."
      await sendReplyViaGateway(userId, normalizedFrom, loadingPhrase)
      await saveMessage(userId, phoneNumber, 'assistant', loadingPhrase, `ai_load_${Date.now()}`)

      const internalExecution = await executeTool(routingDecision.tool, userId, phoneNumber, storeContext.products, convContext)
      definitiveReply = await synthesizeResponse(internalExecution, storeContext.businessName, text, structuralHistory.messages)
    } else if (routingDecision.type === 'tool_call') {
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

// ========================
// KORAPAY WEBHOOK
// ========================
app.post('/korapay-webhook', async (req, res) => {
  const body = req.body
  res.status(200).json({ success: true })

  setImmediate(async () => {
    if (body.event === 'charge.success' && body.data?.status === 'success') {
      const reference = body.data.reference
      try {
        const verifyRes = await axios.post('https://checkout.korapay.com/validate-link', 
          { slug: reference, env: 'live' },
          { headers: { 'accept': 'application/json', 'content-type': 'application/json' }, timeout: 15000 }
        )

        const verifyData = verifyRes.data
        const isSuccessful = verifyData.success && 
          (verifyData.data?.data?.status === 'success' || verifyData.data?.data?.payment_status === 'success')

        if (!isSuccessful) return

        const snapshot = await db.collectionGroup('orders').where('reference', '==', reference).limit(1).get()
        if (!snapshot.empty) {
          const docTarget = snapshot.docs[0]
          const orderData = docTarget.data()
          
          await docTarget.ref.update({ status: 'success', paidAt: Date.now() })

          const cleanPhone = orderData.phoneNumber
          const businessId = docTarget.ref.parent.parent.id

          await db.collection('businesses').doc(businessId).collection('contexts').doc(cleanPhone).update({
            currentProduct: null, lastPrice: null, negotiationRound: 0, intent: 'browsing'
          })

          const receiptAlert = `🧾 TRANSACTION RECEIPT\nProduct: \( {orderData.product}\nAmount: ₦ \){orderData.amount.toLocaleString()}\nRef: ${reference}\nAccount: ${orderData.generatedAccount}\nStatus: Confirmed\n\nThank you!`

          await sendReplyViaGateway(businessId, `${cleanPhone}@s.whatsapp.net`, receiptAlert)
        }
      } catch (e) {
        console.error('[WEBHOOK ERROR]:', e.message)
      }
    }
  })
})

app.get('/health', (req, res) => res.json({ status: 'online' }))

app.listen(PORT, () => console.log(`🚀 AI Engine Running on Port ${PORT}`))

module.exports = app

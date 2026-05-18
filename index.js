const express = require('express')
const dotenv = require('dotenv')
const axios = require('axios')
const admin = require('firebase-admin')

// Official Baileys JID Normalizer
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
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free'
const PORT = process.env.PORT || 3000

if (!OPENROUTER_API_KEY) {
  console.warn('⚠️ OPENROUTER_API_KEY is not set in .env file')
}

if (!FIREBASE_PROJECT_ID || !FIREBASE_PRIVATE_KEY || !FIREBASE_CLIENT_EMAIL) {
  console.error('❌ Firebase credentials missing: FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL')
  process.exit(1)
}

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
// AI RESPONSE USING OPENROUTER
// ========================

async function getAIResponse(userMessage, systemPrompt) {
  try {
    console.log('[AI] 🤖 Calling OpenRouter API with model:', OPENROUTER_MODEL)
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.7,
        max_tokens: 500,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://aromsg.up.railway.app',
          'X-Title': 'AroMsg WhatsApp AI Service',
        },
        timeout: 15000,
      }
    )

    const reply = response.data.choices[0]?.message?.content?.trim()
    console.log('[AI] ✅ OpenRouter response received:', reply.substring(0, 100) + '...')
    return reply || 'Sorry, I could not generate a response right now.'
  } catch (error) {
    console.error('[AI] ❌ OpenRouter API Error:', error.response?.data || error.message)
    return 'Sorry, I am having trouble thinking right now. Please try again later.'
  }
}

// ========================
// FIND BUSINESS FOR CUSTOMER
// ========================

async function findBusinessForCustomer(phoneNumber) {
  try {
    console.log(`[DB] 🔍 Finding business for customer: ${phoneNumber}`)

    const contactsSnapshot = await db
      .collectionGroup('contacts')
      .where('phone', '==', phoneNumber.replace(/\D/g, ''))
      .limit(1)
      .get()

    if (contactsSnapshot.empty) {
      console.log(`[DB] ⚠️ No contact found for: ${phoneNumber}`)
      return null
    }

    const contactDoc = contactsSnapshot.docs[0]
    const contactData = contactDoc.data()
    const businessId = contactData.businessId

    console.log(`[DB] ✅ Found business: ${businessId}`)
    return businessId
  } catch (err) {
    console.error('[DB] ❌ Error finding business:', err.message)
    return null
  }
}

// ========================
// GET BUSINESS CONTEXT & PRODUCTS
// ========================

async function getBusinessContext(businessId) {
  try {
    console.log(`[DB] 📦 Loading business config for: ${businessId}`)

    const businessDoc = await db.collection('businesses').doc(businessId).get()
    if (!businessDoc.exists) {
      console.log(`[DB] ❌ Business not found: ${businessId}`)
      return null
    }

    const businessData = businessDoc.data()
    console.log(`[DB] ✅ Business loaded: ${businessData.name}`)

    let productsContext = ''
    try {
      const productsSnapshot = await db
        .collection('businesses')
        .doc(businessId)
        .collection('products')
        .orderBy('createdAt', 'desc')
        .get()

      if (!productsSnapshot.empty) {
        console.log(`[DB] 🛍️ Found ${productsSnapshot.size} products`)
        const productsList = productsSnapshot.docs
          .map((doc) => {
            const product = doc.data()
            return `- ${product.name} ($${product.price}${product.negotiationEnabled ? ', negotiable' : ''}): ${product.description}`
          })
          .join('\n')

        productsContext = '\n\nAvailable products:\n' + productsList
      }
    } catch (err) {
      console.error('[DB] ⚠️ Error fetching products:', err.message)
    }

    return {
      businessId,
      businessName: businessData.name,
      aiPersonality: businessData.aiPersonality,
      productsContext,
    }
  } catch (err) {
    console.error('[DB] ❌ Error getting business context:', err.message)
    return null
  }
}

// ========================
// SAVE MESSAGE TO FIRESTORE
// ========================

async function saveMessage(businessId, phoneNumber, role, text, messageId) {
  try {
    const timestamp = Date.now()
    const normalizedPhone = phoneNumber.replace(/\D/g, '')

    const messageDoc = {
      contactJid: normalizedPhone,
      from: role === 'user' ? normalizedPhone : businessId,
      to: role === 'user' ? businessId : normalizedPhone,
      text,
      role,
      platform: 'whatsapp',
      messageId,
      timestamp,
      direction: role === 'user' ? 'incoming' : 'outgoing',
    }

    await db
      .collection('businesses')
      .doc(businessId)
      .collection('whatsapp_messages')
      .add(messageDoc)

    console.log(`[DB] 💾 Message saved - Role: ${role}, Phone: ${normalizedPhone}`)
    return true
  } catch (err) {
    console.error('[DB] ❌ Error saving message:', err.message)
    return false
  }
}

// ========================
// SEND REPLY VIA GATEWAY (Updated with Official Normalizer)
// ========================

async function sendReplyViaGateway(userId, phoneNumber, replyText) {
  try {
    console.log(`[GATEWAY] 📤 Sending reply to ${phoneNumber}`)

    // Use Official Baileys Normalizer
    const normalizedJid = normalizeJid(phoneNumber);

    const response = await axios.post(
      `${GATEWAY_URL}/send-message`,
      {
        userId,
        to: normalizedJid,           // ← Now using official normalized JID
        text: replyText,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${INTERNAL_API_KEY}`,
        },
        timeout: 10000,
      }
    )

    console.log(`[GATEWAY] ✅ Reply queued successfully to ${normalizedJid}`)
    return true
  } catch (err) {
    console.error('[GATEWAY] ❌ Failed to send reply:', err.message)
    return false
  }
}

// ========================
// MAIN WEBHOOK ENDPOINT
// ========================

app.post('/webhook', async (req, res) => {
  try {
    const authHeader = req.headers.authorization

    if (!authHeader || authHeader !== `Bearer ${INTERNAL_API_KEY}`) {
      console.log('[AUTH] ❌ Unauthorized webhook attempt')
      return res.status(401).json({ success: false, error: 'Unauthorized' })
    }

    const { userId, from, text, platform, messageId, timestamp } = req.body

    console.log('\n' + '='.repeat(60))
    console.log('[WEBHOOK] 📨 WEBHOOK RECEIVED')
    console.log('='.repeat(60))
    console.log('[WEBHOOK] Payload:', JSON.stringify(req.body, null, 2))

    if (!userId || !from || !text) {
      console.log('[WEBHOOK] ❌ Missing required fields')
      return res.status(400).json({ success: false, error: 'Missing required fields' })
    }

    // Use official normalizer
    const normalizedFrom = normalizeJid(from);
    const phoneNumber = normalizedFrom.replace('@s.whatsapp.net', '');

    console.log(`[WEBHOOK] 📍 Normalized JID: ${normalizedFrom}`);

    // ========================
    // SAVE INCOMING MESSAGE
    // ========================
    console.log('[WEBHOOK] 💾 Saving incoming message...')
    const incomingMessageId = messageId || `in_${Date.now()}`
    await saveMessage(userId, phoneNumber, 'user', text, incomingMessageId)

    // ========================
    // BUSINESS CONTEXT
    // ========================
    let businessId = userId
    console.log(`[WEBHOOK] 📍 Using businessId: ${businessId}`)

    console.log('[WEBHOOK] 📦 Loading business context...')
    const context = await getBusinessContext(businessId)

    if (!context) {
      console.log('[WEBHOOK] ❌ Could not load business context')
      return res.status(404).json({ success: false, error: 'Business context not found' })
    }

    // ========================
    // BUILD SYSTEM PROMPT
    // ========================
    const personality = context.aiPersonality || 'You are a friendly and professional sales assistant.'

    const systemPrompt =
      `You are an AI sales assistant for ${context.businessName}.\n\n` +
      `\( {personality} \){context.productsContext}\n\n` +
      `Keep replies concise (1-3 sentences). Never make up product information. ` +
      `If a customer asks about negotiation on a product, check if negotiation is available. ` +
      `Never reveal you are an AI unless directly asked.`

    console.log('[WEBHOOK] 🧠 System prompt prepared')

    // ========================
    // GENERATE AI RESPONSE
    // ========================
    console.log('[WEBHOOK] 🤖 Generating AI response...')
    const aiReply = await getAIResponse(text, systemPrompt)

    // ========================
    // SAVE AI RESPONSE
    // ========================
    console.log('[WEBHOOK] 💾 Saving AI response...')
    const responseMessageId = `ai_${Date.now()}`
    await saveMessage(businessId, phoneNumber, 'assistant', aiReply, responseMessageId)

    // ========================
    // SEND REPLY VIA GATEWAY
    // ========================
    console.log('[WEBHOOK] 📤 Sending reply via gateway...')
    await sendReplyViaGateway(businessId, normalizedFrom, aiReply)   // ← Using normalized JID

    console.log('[WEBHOOK] ✅ Webhook complete')
    console.log('='.repeat(60) + '\n')

    res.json({
      success: true,
      aiReply,
      messagesSaved: true,
      gatewaySent: true,
    })
  } catch (err) {
    console.error('[WEBHOOK] ❌ Unhandled error:', err.message)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    })
  }
})

// ========================
// HEALTH CHECK
// ========================

app.get('/health', async (req, res) => {
  // ... (your existing health check logic - unchanged)
  try {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      checks: {
        api_key: !!INTERNAL_API_KEY,
        openrouter_key: !!OPENROUTER_API_KEY,
        firebase: !!db,
        gateway: false,
      },
    }

    try {
      const gatewayRes = await axios.get(`${GATEWAY_URL}/health`, { timeout: 5000 })
      health.checks.gateway = gatewayRes.status === 200
    } catch (err) {
      health.checks.gateway = false
    }

    const allHealthy = Object.values(health.checks).every((v) => v === true)
    health.status = allHealthy ? 'healthy' : 'degraded'

    console.log('[HEALTH] Status:', health.status)
    res.status(allHealthy ? 200 : 503).json(health)
  } catch (err) {
    console.error('[HEALTH] Error:', err.message)
    res.status(500).json({ status: 'unhealthy', error: err.message })
  }
})

// ========================
// START SERVER
// ========================

app.listen(PORT, () => {
  console.log('\n' + '='.repeat(60))
  console.log('🚀 AI Webhook Service Starting')
  console.log('='.repeat(60))
  console.log(`Port: ${PORT}`)
  console.log(`Gateway URL: ${GATEWAY_URL}`)
  console.log(`OpenRouter Model: ${OPENROUTER_MODEL}`)
  console.log(`Firebase Project: ${FIREBASE_PROJECT_ID}`)
  console.log('='.repeat(60) + '\n')
})

module.exports = app

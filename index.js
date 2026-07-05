const express = require('express')
const dotenv = require('dotenv')
const axios = require('axios')
const admin = require('firebase-admin')
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const sharp = require('sharp')
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

const VENDOR_ALERT_NUMBER = process.env.VENDOR_ALERT_NUMBER || ''
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`
const VENDOR_EMAIL = process.env.VENDOR_EMAIL || ''
const SMTP_HOST = process.env.SMTP_HOST || ''
const SMTP_PORT = process.env.SMTP_PORT || '587'
const SMTP_SECURE = process.env.SMTP_SECURE || 'false'
const SMTP_USER = process.env.SMTP_USER || ''
const SMTP_PASS = process.env.SMTP_PASS || ''
const SMTP_FROM = process.env.SMTP_FROM || ''

// ========================
// VERIFICATION CODE STORE
// ========================
const pendingVerifications = new Map() // phone -> { code, businessId, expiresAt }

// ========================
// INVOICE IMAGE GENERATOR
// ========================
const INVOICES_DIR = path.join(__dirname, 'invoices')
if (!fs.existsSync(INVOICES_DIR)) {
  fs.mkdirSync(INVOICES_DIR, { recursive: true })
}

function buildInvoiceSvg({ amount, accountNumber, bankName, merchantName, reference }) {
  const formattedAmount = Number(amount).toLocaleString()
  return `<svg width="600" height="500" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0b0f17"/>
      <stop offset="100%" style="stop-color:#111827"/>
    </linearGradient>
  </defs>
  <rect width="600" height="500" fill="url(#bg)" rx="16"/>
  <!-- Card -->
  <rect x="50" y="40" width="500" height="420" rx="24" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
  <!-- Header -->
  <text x="80" y="90" fill="#9ca3af" font-size="16" font-family="Arial, sans-serif" font-weight="bold">${escapeXml(merchantName)}</text>
  <rect x="400" y="72" width="120" height="28" rx="12" fill="#1e293b"/>
  <text x="420" y="91" fill="#38bdf8" font-size="12" font-family="Arial, sans-serif" font-weight="bold">PENDING PAYMENT</text>
  <!-- Amount -->
  <text x="80" y="150" fill="#6b7280" font-size="14" font-family="Arial, sans-serif">Total Payable Amount</text>
  <text x="80" y="200" fill="#34d399" font-size="42" font-family="Arial, sans-serif" font-weight="bold">₦${escapeXml(formattedAmount)}</text>
  <!-- Divider line -->
  <line x1="80" y1="230" x2="520" y2="230" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
  <!-- Bank Details Box -->
  <rect x="80" y="260" width="440" height="110" rx="16" fill="#111827"/>
  <text x="100" y="295" fill="#9ca3af" font-size="14" font-family="Arial, sans-serif">Bank Name</text>
  <text x="370" y="295" fill="#ffffff" font-size="14" font-family="Arial, sans-serif" font-weight="bold" text-anchor="end">${escapeXml(bankName)}</text>
  <text x="100" y="335" fill="#9ca3af" font-size="14" font-family="Arial, sans-serif">Account Number</text>
  <text x="370" y="335" fill="#38bdf8" font-size="20" font-family="Arial, sans-serif" font-weight="bold" text-anchor="end">${escapeXml(accountNumber)}</text>
  <text x="100" y="375" fill="#9ca3af" font-size="14" font-family="Arial, sans-serif">Reference</text>
  <text x="370" y="375" fill="#ffffff" font-size="12" font-family="Arial, sans-serif" text-anchor="end">${escapeXml(reference)}</text>
  <!-- Footer -->
  <line x1="80" y1="410" x2="520" y2="410" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
  <text x="300" y="440" fill="#4b5563" font-size="12" font-family="Arial, sans-serif" text-anchor="middle">⚡ Powered by AroMsg AI</text>
</svg>`
}

function escapeXml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function generateInvoiceImage({ amount, accountNumber, bankName, merchantName, reference }) {
  const safeRef = reference.replace(/[^a-zA-Z0-9_-]/g, '')
  const filename = `invoice_${safeRef}.png`
  const filepath = path.join(INVOICES_DIR, filename)
  
  // Skip regeneration if already exists
  if (fs.existsSync(filepath)) {
    console.log(`🖼️ Invoice image already exists: ${filename}`)
    const existingBase64 = fs.readFileSync(filepath, { encoding: 'base64' })
    return { filename, filepath, url: `/invoice/${filename}`, base64: `data:image/png;base64,${existingBase64}` }
  }
  
  const svgContent = buildInvoiceSvg({ amount, accountNumber, bankName, merchantName, reference })
  const pngBuffer = await sharp(Buffer.from(svgContent)).png({ quality: 90 }).toBuffer()
  fs.writeFileSync(filepath, pngBuffer)
  
  console.log(`🖼️ Invoice image generated: ${filename}`)
  return {
    filename,
    filepath,
    url: `/invoice/${filename}`,
    base64: `data:image/png;base64,${pngBuffer.toString('base64')}`
  }
}

// Cleanup old invoice images (older than 1 hour)
async function cleanupOldInvoiceImages() {
  try {
    const files = fs.readdirSync(INVOICES_DIR)
    const oneHourAgo = Date.now() - (60 * 60 * 1000)
    let deleted = 0
    for (const file of files) {
      const filepath = path.join(INVOICES_DIR, file)
      const stat = fs.statSync(filepath)
      if (stat.isFile() && stat.mtimeMs < oneHourAgo) {
        fs.unlinkSync(filepath)
        deleted++
      }
    }
    if (deleted > 0) console.log(`🧹 Cleaned ${deleted} old invoice images`)
    return deleted
  } catch (e) {
    console.error('[INVOICE CLEANUP ERROR]:', e.message)
    return 0
  }
}

// ============================================================================
// 🔔 VENDOR NOTIFICATION NUMBER VERIFICATION SYSTEM
// ============================================================================
// Flow:
//   1. Frontend sends POST /request-verification { businessId, notificationNumber }
//   2. System generates a random code, stores pending verification
//   3. Frontend responds: "Send this code to the bot: VERIFY-XXXX"
//   4. User sends the code to their WhatsApp bot number
//   5. Webhook detects the code, marks the number as verified
//   6. All future order alerts go to this verified number instead of env var
// ============================================================================

// ─── In-memory + Firestore backed store for verified notification numbers ───
async function getVerifiedNumber(businessId) {
  try {
    const doc = await db.collection('businesses').doc(businessId).get()
    return doc.data()?.notificationNumber || VENDOR_ALERT_NUMBER
  } catch {
    return VENDOR_ALERT_NUMBER
  }
}

async function setVerifiedNumber(businessId, phoneNumber) {
  try {
    await db.collection('businesses').doc(businessId).update({
      notificationNumber: phoneNumber,
      notificationVerifiedAt: Date.now()
    })
  } catch {
    // Fallback: try setting it
    await db.collection('businesses').doc(businessId).set({
      notificationNumber: phoneNumber,
      notificationVerifiedAt: Date.now()
    }, { merge: true })
  }
}

function generateVerificationCode() {
  return `VERIFY-${Math.random().toString(36).substring(2, 8).toUpperCase()}`
}

// ─── POST /request-verification — Called by frontend to start verification ───
app.post('/request-verification', async (req, res) => {
  try {
    const { businessId, notificationNumber } = req.body
    if (!businessId || !notificationNumber) {
      return res.status(400).json({ error: 'businessId and notificationNumber required' })
    }

    const cleanNum = notificationNumber.replace(/\D/g, '')
    if (cleanNum.length < 10) {
      return res.status(400).json({ error: 'Invalid phone number' })
    }

    // Generate code and store in memory (expires in 10 min)
    const code = generateVerificationCode()
    pendingVerifications.set(cleanNum, {
      code,
      businessId,
      expiresAt: Date.now() + 10 * 60 * 1000
    })

    // Auto-clean after 10 min
    setTimeout(() => pendingVerifications.delete(cleanNum), 10 * 60 * 1000)

    console.log(`🔐 Verification requested: ${businessId} → ${cleanNum} | Code: ${code}`)

    res.json({
      success: true,
      message: `Send this exact code to your bot WhatsApp number: ${code}`,
      code,
      expiresIn: '10 minutes'
    })
  } catch (err) {
    console.error('[VERIFICATION REQUEST ERROR]:', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// ─── POST /check-verification — Frontend polls to check if user sent the code ───
app.post('/check-verification', async (req, res) => {
  try {
    const { businessId } = req.body
    if (!businessId) return res.status(400).json({ error: 'businessId required' })

    const verified = await getVerifiedNumber(businessId)
    // If notificationNumber is set AND it's not the env var default, it's verified
    const isVerified = verified && verified !== VENDOR_ALERT_NUMBER

    res.json({
      success: true,
      verified: isVerified,
      notificationNumber: isVerified ? verified : null
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ─── detectVerificationReply — Called from the main webhook handler ─────────
async function detectVerificationReply(userId, fromNumber, userText) {
  const trimmed = userText.trim().toUpperCase()
  const cleanFrom = fromNumber.replace(/\D/g, '')

  // Check if the message matches any pending verification code
  for (const [pendingPhone, data] of pendingVerifications.entries()) {
    // Code matches AND the sender's phone matches the notification number
    if (trimmed === data.code && cleanFrom === pendingPhone) {
      // Mark verified in Firestore
      await setVerifiedNumber(data.businessId, pendingPhone)
      pendingVerifications.delete(pendingPhone)

      const welcomeMsg = `✅ Your notification number (${pendingPhone}) has been verified successfully! You will now receive real-time alerts for:
• New payment received
• Invoice copies
• Order dispatch updates
📊 *Coming soon:* You can also chat with your sales agent from this number to get daily/weekly/monthly market reports, sales summaries, and performance insights. Stay tuned! 🚀`

      await sendReplyViaGateway(data.businessId, `${cleanFrom}@s.whatsapp.net`, welcomeMsg)
      console.log(`✅ Notification number verified: ${data.businessId} → ${pendingPhone}`)
      return true
    }

    // ─── FUTURE SALES AGENT CHAT HOOK ─────────────────────────────────────────
    // This is the space where the vendor can talk to their AI sales agent.
    // Once notification is verified, any future messages from this number
    // that DON'T match a verification code can be routed here.
    //
    // Example integration:
    // if (cleanFrom === pendingPhone && data.expiresAt < Date.now() && trimmed !== data.code) {
    //   await routeToSalesAgentChat(data.businessId, cleanFrom, userText)
    // }
    // ===========================================================================
  }

  return false
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
// VENDOR CHAT ENGINE
// ========================
const vendorChat = require('./vendor-chat')(db, sendReplyViaGateway)
const { handleVendorChat, checkPendingOTP, pendingPayouts } = vendorChat

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
          intent: 'browsing',
          lastReference: null,
          status: 'browsing',
          currentOrderReference: null,
          lastUpdated: Date.now()
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
    intent: 'browsing',
    lastReference: null,
    status: 'browsing',
    currentOrderReference: null,
    lastUpdated: Date.now()
  }
}

async function saveConversationContext(businessId, phoneNumber, contextData) {
  const cleanPhone = phoneNumber.replace(/\D/g, '')
  const docRef = db.collection('businesses').doc(businessId).collection('contexts').doc(cleanPhone)
  try {
    await db.runTransaction(async (transaction) => {
      transaction.set(docRef, {
        ...contextData,
        lastInteraction: Date.now(),
        lastUpdated: Date.now()
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
            const hasImage = p.imageUrl ? 'Yes' : 'No'
            return `• Item Name: ${p.name}\n  Store Price: ₦${basePrice.toLocaleString()}\n  Negotiable: ${negotiable}\n  HasImage: ${hasImage}\n  INTERNAL_PROTECTED_FLOOR: ₦${floorPrice.toLocaleString()}\n  Description: ${p.description || 'Premium Stock'}`
          })
          .join('\n\n')
    }

    return {
      businessId,
      businessName: businessData.name,
      aiPersonality: businessData.aiPersonality,
      aiEnabled: businessData.universalAIResponse !== false,
      customPrompt: businessData.customPrompt || '',
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
      description: 'Get deep technical specs, details, or product photo on a particular item. Call this when the customer asks to see a product or wants more details.',
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
      description: 'Call this ONLY when a customer requests a cheaper price or presents a lower counter offer counter budget.',
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
      description: 'Verify payment or tracking records using the tracking reference ID. Call this when the user says they are done, have sent proof, or uploaded a receipt.',
      parameters: {
        type: 'object',
        properties: { 
          orderId: { 
            type: 'string',
            description: 'The transaction reference ID (e.g. KPY-PAY-...). Find this in LastReference.'
          } 
        },
        required: ['orderId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'saveDeliveryDetails',
      description: 'Saves the customer parsed full delivery address and contact details after a completed payment. Call this when the user provides their address, location, or delivery info.',
      parameters: {
        type: 'object',
        properties: {
          addressText: { type: 'string', description: 'The complete shipping address and phone numbers provided by the customer.' }
        },
        required: ['addressText']
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
- ABSOLUTELY FORBIDDEN: Never generate, make up, or display ANY bank name, account number, or payment details in your conversational text. All payment details must come EXCLUSIVELY from executing the 'initiatePayment' tool. If you have not called that tool, do not mention any bank accounts.

⚠️ VERIFICATION AND IMAGE HANDLING PROTOCOL:
- You cannot see or read images or receipt screenshots. If the user sends an image/receipt or says "Done", "I have paid", "sent", do NOT say "Payment received" or "Your order is confirmed" right away!
- Instead, you MUST call the 'checkOrderStatus' tool to query the bank network status using the LastReference, or politely explain to the customer that the payment is automatically tracked and you are waiting for the bank network clearance alert.
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
// 🏦 EXACT NEXT.JS MATCHING NATIVE 3-STEP EXECUTOR WITH FULL TEMPLATE PAYLOADS
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

  const cleanPhone = phoneNumber.replace(/\D/g, '')
  const sanitizedEmail = `${cleanPhone}@cloutivaapp.shop`

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
      return `RESULT:PRODUCT_META\nName: ${item.name}\nPrice: ₦${parseFloat(item.price).toLocaleString()}\nSpecs: ${item.description || 'Standard'}\nImageUrl: ${item.imageUrl || ''}`
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
        const dynamicSlug = "ovgtc2b4JUo4hEa" // System template token
        const checkAmount = Math.round(parseFloat(args.agreedPrice) || 0)
        const tag = args.productName || 'Inventory Order'

        if (checkAmount <= 0) return 'RESULT: Invalid pricing parameters.'

        convContext.intent = 'buying'
        convContext.lastPrice = checkAmount

        // --------------------------------------------------------------------
        // 📡 STEP 1: VALIDATE LINK (Gets reference & key)
        // --------------------------------------------------------------------
        const step1Payload = { slug: dynamicSlug, env: 'live' }
        console.log(`📡 [STEP 1: VALIDATE-LINK] URL: https://checkout.korapay.com/validate-link Payload:`, JSON.stringify(step1Payload));
        
        const validateRes = await axios.post(
          'https://checkout.korapay.com/validate-link',
          step1Payload,
          { headers: nativeCheckoutHeaders, timeout: 15000 }
        )
        
        const retrievedData = validateRes.data?.data?.data || {}
        const solvedRequestRef = retrievedData.reference || "KPY-PAY-REQ-g4z3vqwhnLHspIf"
        const activePublicKey = retrievedData.public_key || KORAPAY_PUBLIC_KEY

        console.log(`✅ [STEP 1 SUCCESS] Reference: ${solvedRequestRef} | Public Key: ${activePublicKey}`);

        // --------------------------------------------------------------------
        // 📡 STEP 2: CREATE CHARGE OVER PAYMENT LINK
        // --------------------------------------------------------------------
        const step2Payload = {
          data: {
            customer: {
              name: "WhatsApp Client",
              email: sanitizedEmail
            },
            amount: String(checkAmount),
            currency: "NGN",
            payment_request: {
              reference: solvedRequestRef
            }
          },
          public_key: activePublicKey
        }
        console.log(`📡 [STEP 2: CREATE-PAYMENT] URL: https://checkout.korapay.com/?type=payment-link Payload:`, JSON.stringify(step2Payload));

        const createRes = await axios.post(
          'https://checkout.korapay.com/?type=payment-link',
          step2Payload,
          { headers: nativeCheckoutHeaders, timeout: 15000 }
        )

        const payloadData = createRes.data?.data?.data || createRes.data?.data || {}
        const solvedPaymentReference = payloadData.payment_reference

        if (!solvedPaymentReference) {
          console.error('❌ Missing payment_reference token from Step 2 response. Full Response:', JSON.stringify(createRes.data));
          return `RESULT:KORA_API_FETCH_FAILED`
        }

        console.log(`✅ [STEP 2 SUCCESS] Payment Reference Obtained: ${solvedPaymentReference}`);
        convContext.lastReference = solvedPaymentReference // Save the transaction ID in conversation state!

        // --------------------------------------------------------------------
        // 📡 STEP 3: BANK CHARGE (Resolves direct Sterling Bank transfers details)
        // --------------------------------------------------------------------
        const step3Payload = {
          type: "bank_transfer",
          data: {
            public_key: activePublicKey,
            payment_reference: solvedPaymentReference
          }
        }
        console.log(`📡 [STEP 3: BANK-CHARGE] URL: https://checkout.korapay.com/bank/charge Payload:`, JSON.stringify(step3Payload));

        const bankChargeRes = await axios.post(
          'https://checkout.korapay.com/bank/charge',
          step3Payload,
          { headers: nativeCheckoutHeaders, timeout: 15000 }
        )

        const chargePayload = bankChargeRes.data?.data?.data || bankChargeRes.data?.data || {}
        const bankDetails = chargePayload.bank_details || chargePayload.bank_account || {}
        
        const dynamicAccountNumber = bankDetails.account_number
        const dynamicBankName = bankDetails.bank_name
        const dynamicAccountName = bankDetails.account_name || "Korapay-LIT-CHKOUT"
        const finalExpectedAmount = parseFloat(chargePayload.amount_expected || chargePayload.amount || checkAmount)

        if (!dynamicAccountNumber || dynamicAccountNumber === '0000000000') {
          console.error(`⚠️ Empty or mock account details returned in Step 3. Response:`, JSON.stringify(bankChargeRes.data));
          return `RESULT:KORA_API_FETCH_FAILED`
        }

        console.log(`✅ [STEP 3 SUCCESS] Account: ${dynamicAccountNumber} | Bank: ${dynamicBankName} | Name: ${dynamicAccountName} | Expecting: ₦${finalExpectedAmount}`);

        // Save order to subcollection (webhook's canonical store)
        await db.collection('businesses').doc(businessId).collection('orders').doc(solvedPaymentReference).set({
          reference: solvedPaymentReference,
          phoneNumber: cleanPhone,
          amount: finalExpectedAmount,
          product: tag,
          status: 'PENDING',
          createdAt: Date.now(),
          generatedAccount: dynamicAccountNumber,
          generatedBank: dynamicBankName,
          generatedAccountName: dynamicAccountName,
          deliveryAddress: null,
          expiryPeriod: "60 minutes"
        })

        // ─── Mirror to flat orders collection (frontend reads from here) ───
        await db.collection('orders').doc(solvedPaymentReference).set({
          id: solvedPaymentReference,
          businessId,
          userId: cleanPhone,
          productId: tag,
          productName: tag,
          amount: finalExpectedAmount,
          status: 'pending',
          createdAt: Date.now(),
          reference: solvedPaymentReference,
          phoneNumber: cleanPhone,
          generatedAccount: dynamicAccountNumber,
          generatedBank: dynamicBankName,
          generatedAccountName: dynamicAccountName,
          deliveryAddress: null,
          invoiceImage: null
        }).catch(e => console.error('[ORDER MIRROR ERROR]:', e.message))

        // Store order reference in context for post-payment flow
        convContext.currentOrderReference = solvedPaymentReference
        convContext.status = 'NEGOTIATING'

        return `RESULT:BANK_TRANSFER_PAYLOAD_GENERATION\nAmount: ₦${finalExpectedAmount.toLocaleString()}\nReference: ${solvedPaymentReference}\nBankAccountNumber: ${dynamicAccountNumber}\nBankName: ${dynamicBankName}\nBankAccountName: ${dynamicAccountName}\nExpiryTime: This account expires in 60 minutes`
        
      } catch (err) {
        console.error('❌ [INTERNAL PIPELINE EXECUTOR FAILURE]:', err.response?.data || err.message)
        return `RESULT:KORA_API_FETCH_FAILED`
      }
    }

    case 'checkOrderStatus': {
      try {
        console.log(`🔍 [VERIFY ENGINE ACTIVE]: Checking validation state status for reference ID: ${args.orderId}`);
        
        const verifyAltRes = await axios.post(
          'https://checkout.korapay.com/validate-link',
          { slug: args.orderId, env: 'live' },
          { headers: nativeCheckoutHeaders, timeout: 15000 }
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
    case 'saveDeliveryDetails': {
      try {
        const addressText = args.addressText || ''
        if (!addressText) return 'RESULT: No address provided.'

        const orderRef = convContext.currentOrderReference
        if (orderRef) {
          await db.collection('businesses').doc(businessId).collection('orders').doc(orderRef).update({
            deliveryAddress: addressText,
            status: 'PROCESSING_DISPATCH',
            deliveryCapturedAt: Date.now()
          })
          // Mirror to flat collection
          await db.collection('orders').doc(orderRef).update({
            status: 'confirmed',
            deliveryAddress: addressText,
            deliveryCapturedAt: Date.now()
          }).catch(e => console.error('[ORDER MIRROR UPDATE ERROR]:', e.message))
        }

        // Alert vendor
        const alertPhone = await getVerifiedNumber(businessId)
        if (alertPhone) {
          const productName = convContext.currentProduct || 'an item'
          const alertText = `🔔 *NEW ORDER DISPATCH ALERT*
📦 Product: ${productName}
📍 Address: ${addressText}
📞 Contact: ${cleanPhone}
💰 Amount: ₦${(convContext.lastPrice || 0).toLocaleString()}
🆔 Order Ref: ${orderRef || 'N/A'}

Login to your dashboard to manage this order.`
          await sendReplyViaGateway(businessId, alertPhone, alertText)
        }

        // Wipe context cleanly
        await db.collection('businesses').doc(businessId).collection('contexts').doc(cleanPhone).delete()

        return `RESULT:DELIVERY_SAVED\nAddress: ${addressText}\nStatus: PROCESSING_DISPATCH`
      } catch (e) {
        console.error('[DELIVERY SAVE ERROR]:', e.message)
        return 'RESULT: Delivery save failed.'
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
  const { businessName, aiPersonality, productsContext, customPrompt } = businessContext
  const { messages } = historyPackage

  const analyticalState = `
[LIVE ENGINE STATE TRACKING]
- FocusProduct: ${convContext.currentProduct || 'None'}
- CustomRound: ${convContext.negotiationRound}
- TargetLastPrice: ${convContext.lastPrice ? `₦${convContext.lastPrice}` : 'None'}
- CurrentIntent: ${convContext.intent}
- SessionStatus: ${convContext.status || 'browsing'}
- OrderReference: ${convContext.currentOrderReference || 'None'}
- LastReference: ${convContext.lastReference || 'None'}
`

  const systemPrompt = `${MASTER_DIRECTIVES}
BUSINESS NAME: ${businessName}
PERSONALITY OVERLAY: ${aiPersonality || ''}
${customPrompt ? `CUSTOM INSTRUCTIONS:\n${customPrompt}\n` : ''}
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
  if (toolResult.includes('KORA_API_FETCH_FAILED')) {
    return "Hold on a second, boss. The network line to generate your bank transfer details is loading, let me re-trigger it real quick."
  }

  const customPrompt = `You are a native Nigerian individual running sales operations on WhatsApp for ${businessName}.
Transform the raw data payload directly into a short, natural, conversational human text message response.

RULES:
1. MAX 1-2 short casual sentences. Do not spam words.
2. ABSOLUTELY NO BOLD MARKDOWN ASTERISKS (**). Keep text flat and clear.
3. If the data summary is BANK_TRANSFER_PAYLOAD_GENERATION, inform them of:
   - Account Number
   - Bank Name
   - Account Name (MUST include this!)
   - Expiration warning (expires in 60 minutes)
4. If the data is INVOICE_STATUS:
   - If Status is 'confirmed': Congratulate them and let them know the payment is confirmed, order is locked, and processing sharp sharp.
   - If Status is 'pending_confirmation': Politely explain that the transfer hasn't cleared on the bank network yet, but the system is monitoring it and will drop the receipt the second it hits. No need for them to send proof since it's auto-tracked!
5. If the data is DELIVERY_SAVED: Confirm to the customer that their delivery address has been saved successfully and their order is now being processed for dispatch.

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

// ─── DELIVERY ADDRESS PROMPTER ──────────────────────────────────────
async function handleDeliveryAddress(businessId, phoneNumber, normalizedFrom, userText, convContext, storeContext) {
  // If user text looks like an address, save it via AI extraction
  if (userText.length > 10) {
    try {
      const extractRes = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: OPENROUTER_MODEL,
          messages: [
            {
              role: 'system',
              content: `Extract the delivery address and phone number from this message. 
Return ONLY valid JSON: {"address": "full address", "phone": "contact phone"}.
If no clear address found, return {"address": null, "phone": null}.`
            },
            { role: 'user', content: userText }
          ],
          temperature: 0.1,
        },
        { headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` }, timeout: 10000 }
      )
      const parsed = JSON.parse(extractRes.data.choices[0]?.message?.content || '{}')
      
      if (parsed.address) {
        // Save delivery address to the order
        if (convContext.currentOrderReference) {
          await db.collection('businesses').doc(businessId).collection('orders').doc(convContext.currentOrderReference).update({
            deliveryAddress: parsed.address,
            contactPhone: parsed.phone || phoneNumber,
            status: 'PROCESSING_DISPATCH',
            deliveryCapturedAt: Date.now()
          })
          // Mirror to flat collection
          await db.collection('orders').doc(convContext.currentOrderReference).update({
            status: 'confirmed',
            deliveryAddress: parsed.address,
            deliveryCapturedAt: Date.now()
          }).catch(e => console.error('[ORDER MIRROR UPDATE ERROR]:', e.message))
        }

        // Alert vendor
        const alertPhone = await getVerifiedNumber(businessId)
        if (alertPhone) {
          const productName = convContext.currentProduct || 'an item'
          const alertText = `🔔 *NEW ORDER DISPATCH ALERT*
📦 Product: ${productName}
📍 Address: ${parsed.address}
📞 Contact: ${parsed.phone || phoneNumber}
💰 Amount: ₦${(convContext.lastPrice || 0).toLocaleString()}
🆔 Order Ref: ${convContext.currentOrderReference || 'N/A'}

Login to your dashboard to manage this order.`
          await sendReplyViaGateway(businessId, alertPhone, alertText)
        }

        // Wipe context cleanly
        await db.collection('businesses').doc(businessId).collection('contexts').doc(phoneNumber).delete()

        const confirmation = `Perfect! We don save your delivery details. Our team dey look into your order now sharp sharp. We go reach out to you as soon as your package is packed and ready for dispatch! 📦🚀`
        return { reply: confirmation, replied: true }
      }
    } catch (e) {
      console.error('[DELIVERY EXTRACT ERROR]:', e.message)
    }
  }

  // If address not extracted yet, prompt again
  const prompt = `Boss, abeg we still need your Delivery Address and Phone Number so we fit dispatch your package! Drop it sharp sharp 📍📞`
  return { reply: prompt, replied: false }
}
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

    // ─── VENDOR DETECTION ─────────────────────────────────────────────
    // If the sender is the verified notification number, route to vendor chat
    const vendorPhone = await getVerifiedNumber(userId)
    const isVendor = vendorPhone && phoneNumber === vendorPhone.replace(/\D/g, '')
    if (isVendor) {
      await handleVendorChat(userId, phoneNumber, text, storeContext, db, 
        (reply) => sendReplyViaGateway(userId, normalizedFrom, reply))
      return res.json({ success: true, intent: 'vendor_chat' })
    }

    const convContext = await getOrCreateConversationContext(userId, phoneNumber)
    const structuralHistory = await getConversationHistory(userId, phoneNumber)

    // ─── VERIFICATION CODE DETECTION ──────────────────────────────────
    // If a user sends a VERIFY-XXXX code, handle it before any AI routing
    const isVerification = await detectVerificationReply(userId, phoneNumber, text)
    if (isVerification) {
      await saveMessage(userId, phoneNumber, 'user', text, messageId || `in_${Date.now()}`)
      return res.json({ success: true, intent: 'verification' })
    }

    // ─── AWAITING_ADDRESS STATE ROUTING ───────────────────────────────
    if (convContext.status === 'AWAITING_ADDRESS') {
      const deliveryResult = await handleDeliveryAddress(userId, phoneNumber, normalizedFrom, text, convContext, storeContext)
      await saveMessage(userId, phoneNumber, 'user', text, messageId || `in_${Date.now()}`)
      if (deliveryResult.replied) {
        await saveMessage(userId, phoneNumber, 'assistant', deliveryResult.reply, `ai_${Date.now()}`)
      }
      await saveConversationContext(userId, phoneNumber, convContext)
      await sendReplyViaGateway(userId, normalizedFrom, deliveryResult.reply)
      return res.json({ success: true, intent: convContext.intent })
    }

    // ─── AI DISABLED CHECK ────────────────────────────────────────────
    if (storeContext.aiEnabled === false) {
      const disabledReply = `I'm currently away from the shop. Your message has been received and I'll get back to you asap.`
      await saveMessage(userId, phoneNumber, 'user', text, messageId || `in_${Date.now()}`)
      await saveMessage(userId, phoneNumber, 'assistant', disabledReply, `ai_${Date.now()}`)
      await sendReplyViaGateway(userId, normalizedFrom, disabledReply)
      return res.json({ success: true, intent: 'disabled' })
    }

    const routingDecision = await getAIResponse(storeContext, structuralHistory, text, convContext)

    let definitiveReply
    let internalExecution = null

    if (routingDecision.type === 'tool_call' && routingDecision.tool.function.name === 'initiatePayment') {
      const loadingPhrase = "Hold on na, make I get your account transfer details sharp sharp..."
      await sendReplyViaGateway(userId, normalizedFrom, loadingPhrase)
      await saveMessage(userId, phoneNumber, 'assistant', loadingPhrase, `ai_load_${Date.now()}`)

      internalExecution = await executeTool(routingDecision.tool, userId, phoneNumber, storeContext.products, convContext)
      definitiveReply = await synthesizeResponse(internalExecution, storeContext.businessName, text, structuralHistory.messages)

      // ─── Dual-Delivery: Send invoice image if payment generated ───
      if (internalExecution && internalExecution.includes('BANK_TRANSFER_PAYLOAD_GENERATION')) {
        const amountMatch = internalExecution.match(/Amount: ₦([\d,]+)/)
        const accMatch = internalExecution.match(/BankAccountNumber: (\S+)/)
        const bankMatch = internalExecution.match(/BankName: (.+)/)
        const refMatch = internalExecution.match(/Reference: (\S+)/)
        const invoiceAmount = amountMatch ? amountMatch[1].replace(/,/g, '') : '0'
        const invoiceAccount = accMatch ? accMatch[1] : '0000000000'
        const invoiceBank = bankMatch ? bankMatch[1] : 'Moniepoint MFB'
        const invoiceRef = refMatch ? refMatch[1] : ''
        const merchantName = storeContext.businessName || 'VENDOR'

        // Fire media send asynchronously — don't block the reply
        setImmediate(async () => {
          let invoiceImageUrl = ''
          try {
            // Generate invoice image locally via sharp
            const invoiceImage = await generateInvoiceImage({
              amount: invoiceAmount,
              accountNumber: invoiceAccount,
              bankName: invoiceBank,
              merchantName: merchantName,
              reference: invoiceRef
            })

            const baseUrl = `${req.protocol}://${req.get('host')}`
            invoiceImageUrl = `${baseUrl}${invoiceImage.url}`

            // Save invoice URL + base64 data to the order document
            if (convContext.currentOrderReference) {
              await db.collection('businesses').doc(userId).collection('orders').doc(convContext.currentOrderReference).update({
                invoiceImage: invoiceImage.url,
                invoiceImageData: invoiceImage.base64
              }).catch(e => console.error('[INVOICE DB SAVE ERROR]:', e.message))
              // Mirror to flat collection
              await db.collection('orders').doc(convContext.currentOrderReference).update({
                invoiceImage: invoiceImage.url,
                invoiceImageData: invoiceImage.base64
              }).catch(e => console.error('[INVOICE MIRROR ERROR]:', e.message))
            }

            await axios.post(`${GATEWAY_URL}/send-media`, {
              userId,
              to: normalizedFrom,
              mediaUrl: invoiceImageUrl,
              caption: `Here is your generated invoice 📄 | Ref: ${invoiceRef}`
            }, {
              headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` },
              timeout: 15000
            })
            console.log(`✅ Invoice card sent for reference ${invoiceRef}`)

            // ─── Forward invoice to vendor notification number ───
            const notifyPhone = await getVerifiedNumber(userId)
            if (notifyPhone && notifyPhone !== normalizedFrom.replace('@s.whatsapp.net', '')) {
              try {
                await axios.post(`${GATEWAY_URL}/send-media`, {
                  userId,
                  to: notifyPhone,
                  mediaUrl: invoiceImageUrl,
                  caption: `📄 Invoice for ${merchantName} | ${invoiceRef} | ₦${Number(invoiceAmount).toLocaleString()}`
                }, {
                  headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` },
                  timeout: 15000
                })
                console.log(`✅ Invoice forwarded to vendor: ${notifyPhone}`)
              } catch (forwardErr) {
                console.error('[INVOICE FORWARD ERROR]:', forwardErr.message)
              }
            }
          } catch (mediaErr) {
            console.error('[INVOICE MEDIA SEND ERROR]:', mediaErr.message)
            // Fallback: send the invoice URL as text
            if (invoiceImageUrl) {
              await sendReplyViaGateway(userId, normalizedFrom, `📄 View your invoice here: ${invoiceImageUrl}`)
            }
          }
        })
      }
    } else if (routingDecision.type === 'tool_call') {
      internalExecution = await executeTool(routingDecision.tool, userId, phoneNumber, storeContext.products, convContext)
      definitiveReply = await synthesizeResponse(internalExecution, storeContext.businessName, text, structuralHistory.messages)

      // ─── Send product image if getProductInfo was called and has image ───
      if (routingDecision.tool.function.name === 'getProductInfo' && internalExecution && internalExecution.includes('ImageUrl:')) {
        const imgMatch = internalExecution.match(/ImageUrl: (.+)/)
        const productImageUrl = imgMatch ? imgMatch[1].trim() : ''
        if (productImageUrl && productImageUrl.startsWith('http')) {
          setImmediate(async () => {
            try {
              await axios.post(`${GATEWAY_URL}/send-media`, {
                userId,
                to: normalizedFrom,
                mediaUrl: productImageUrl,
                caption: `Here is the ${convContext.currentProduct || 'product'} 📸`
              }, {
                headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` },
                timeout: 15000
              })
            } catch (imgErr) {
              console.error('[PRODUCT IMAGE SEND ERROR]:', imgErr.message)
            }
          })
        }
      }
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
              'content-type': 'application/json'
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
            status: 'PAID', 
            paidAt: Date.now(),
            accountVerified: accountNumber
          })

          // ─── Mirror status update to flat orders collection ───
          await db.collection('orders').doc(reference).update({
            status: 'confirmed',
            paidAt: Date.now(),
            accountVerified: accountNumber
          }).catch(e => console.error('[ORDER STATUS MIRROR ERROR]:', e.message))

          const cleanPhone = orderData.phoneNumber
          const businessId = docTarget.ref.parent.parent.id
          const amount = orderData.amount
          await db.collection('businesses').doc(businessId).collection('contexts').doc(cleanPhone).update({
            status: 'AWAITING_ADDRESS',
            lastUpdated: Date.now()
          })

          const receiptAlert = `🧾 *TRANSACTION RECEIPT*
----------------------------------------
🛍️ *Product:* ${orderData.product}
💰 *Amount Paid:* ₦${orderData.amount.toLocaleString()}
🆔 *Reference:* ${reference}
🏦 *Paid Via:* ${bankName} (${accountNumber})
📅 *Status:* Payment Confirmed Successfully

Your payment of ₦${amount.toLocaleString()} has cleared successfully! 🎉 Now, boss, abeg make you drop your Full Delivery Address and Contact Phone Number sharp sharp so we fit start packing your items immediately! 📦`

          await sendReplyViaGateway(businessId, `${cleanPhone}@s.whatsapp.net`, receiptAlert)
          console.log(`✅ Receipt dispatched successfully for reference ${reference}`)

          // ─── Alert vendor notification number about payment ───
          const vendorPhone = await getVerifiedNumber(businessId)
          if (vendorPhone) {
            const vendorAlert = `💰 *NEW PAYMENT RECEIVED*
🛍️ Product: ${orderData.product}
👤 Customer: ${cleanPhone}
💵 Amount: ₦${amount.toLocaleString()}
🆔 Reference: ${reference}
📅 Status: PAID — Awaiting delivery address
🏦 Paid via: ${bankName} (${accountNumber})`
            await sendReplyViaGateway(businessId, vendorPhone, vendorAlert)
          }
        }
      } catch (e) {
        console.error('[WEBHOOK FAULT EXCEPTION]:', e.response?.data || e.message)
      }
    }
  })
})

app.get('/health', (req, res) => res.json({ status: 'online', memory: process.memoryUsage().heapUsed / 1024 / 1024 }))

// ============================================================================
// 🪝 PAYOUT CONFIRMATION WEBHOOK (KoraPay calls this on payout completion)
// ============================================================================
app.post('/payout-webhook', async (req, res) => {
  const body = req.body
  res.status(200).json({ success: true })

  setImmediate(async () => {
    if (body.event === 'payout.success' || body.event === 'transfer.success') {
      const ref = body.data?.reference || ''
      const status = body.data?.status === 'success' ? 'success' : 'failed'
      if (ref) {
        try {
          const snapshot = await db.collectionGroup('payouts').where('reference', '==', ref).limit(1).get()
          if (!snapshot.empty) {
            await snapshot.docs[0].ref.update({
              status,
              completedAt: Date.now(),
              message: body.data?.message || ''
            })
            console.log(`✅ Payout ${ref} → ${status}`)
          }
        } catch (e) {
          console.error('[PAYOUT WEBHOOK ERROR]:', e.message)
        }
      }
    }
  })
})

// ============================================================================
// 🖼️ SERVE GENERATED INVOICE IMAGES
// ============================================================================
app.get('/invoice/:filename', (req, res) => {
  const filename = path.basename(req.params.filename) // Prevent path traversal
  const filepath = path.join(INVOICES_DIR, filename)
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Invoice image not found' })
  }
  res.sendFile(filepath)
})

// ============================================================================
// 🧹 INACTIVITY SWEEP & DEAD-DEAL CLEANUP
// ============================================================================
async function processInactivityCleanup(businessId) {
  const executionThreshold = Date.now() - (45 * 60 * 1000) // 45 minutes
  try {
    const contextSnap = await db
      .collection(`businesses/${businessId}/contexts`)
      .where('lastUpdated', '<', executionThreshold)
      .get()

    if (contextSnap.empty) {
      console.log(`🧹 No stale contexts for business ${businessId}`)
      return { cleaned: 0 }
    }

    const batch = db.batch()
    let count = 0
    const abandonedRefs = []

    contextSnap.forEach((doc) => {
      const data = doc.data()
      // Skip AWAITING_ADDRESS contexts — give them 48h instead
      if (data.status === 'AWAITING_ADDRESS') return

      if (data.currentOrderReference && data.status !== 'AWAITING_ADDRESS') {
        batch.update(
          db.doc(`businesses/${businessId}/orders/${data.currentOrderReference}`),
          { status: 'ABANDONED', closedAt: Date.now() }
        )
        abandonedRefs.push(data.currentOrderReference)
      }
      batch.delete(doc.ref)
      count++
    })

    if (count > 0) {
      await batch.commit()
      // Mirror abandoned status to flat orders collection (after batch commit)
      for (const ref of abandonedRefs) {
        try {
          await db.collection('orders').doc(ref).update({
            status: 'cancelled',
            closedAt: Date.now()
          })
        } catch (e) { /* flat doc may not exist */ }
      }
      console.log(`🧹 Cleaned ${count} stale contexts for business ${businessId}`)
    }
    return { cleaned: count }
  } catch (e) {
    console.error('[CLEANUP ERROR]:', e.message)
    return { cleaned: 0, error: e.message }
  }
}

app.get('/cleanup', async (req, res) => {
  try {
    const imagesCleaned = await cleanupOldInvoiceImages()
    const businessId = req.query.businessId
    if (!businessId) {
      // If no specific business, iterate all
      const businessesSnap = await db.collection('businesses').get()
      const results = []
      for (const bizDoc of businessesSnap.docs) {
        const result = await processInactivityCleanup(bizDoc.id)
        results.push({ businessId: bizDoc.id, ...result })
      }
      return res.json({ success: true, imagesCleaned, results })
    }
    const result = await processInactivityCleanup(businessId)
    res.json({ success: true, imagesCleaned, ...result })
  } catch (e) {
    console.error('[CLEANUP ENDPOINT ERROR]:', e.message)
    res.status(500).json({ success: false, error: e.message })
  }
})

app.listen(PORT, () => {
  console.log(`🚀 Dedicated Production Engine Running Inline 4-Step Hook Arrays On Port ${PORT}`)
  // Auto-cleanup old invoice images every 30 minutes
  setInterval(cleanupOldInvoiceImages, 30 * 60 * 1000)
})

module.exports = app

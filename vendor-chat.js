// ============================================================================
// 👤 VENDOR SALES AGENT CHAT + PAYOUT ENGINE
// ============================================================================
// Handles messages from the verified notification number.
// Provides analytics, AI chat, and secure OTP-protected payouts.
// ============================================================================
// Usage: const vendorChat = require('./vendor-chat')(db, sendReplyViaGateway)
// ============================================================================

module.exports = function(db, sendReplyViaGateway) {

const axios = require('axios')
const nodemailer = require('nodemailer')

// ─── Pending payout OTP store ──────────────────────────────────────────────
const pendingPayouts = new Map() // phone -> { step, amount, bankName, accountNumber, accountName, otp, expiresAt, businessId }

// ─── SMTP transporter (lazy init) ──────────────────────────────────────────
let transporter = null
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    })
  }
  return transporter
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

// ─── Send OTP email to vendor ──────────────────────────────────────────────
async function sendOTPEmail(email, otp) {
  try {
    const tm = getTransporter()
    await tm.sendMail({
      from: `"AroMsg Security" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to: email,
      subject: '🔐 Your Payout OTP Code - AroMsg',
      html: `
        <div style="background:#0b0f17;padding:32px;font-family:Arial,sans-serif;">
          <div style="max-width:480px;margin:0 auto;background:#111827;border-radius:16px;padding:32px;border:1px solid rgba(255,255,255,0.1);">
            <h2 style="color:#34d399;margin:0 0 16px;">🔐 Payout Confirmation</h2>
            <p style="color:#9ca3af;font-size:14px;">Use this OTP to confirm your payout request:</p>
            <div style="background:#1e293b;padding:20px;border-radius:12px;text-align:center;margin:16px 0;">
              <span style="font-size:36px;font-weight:bold;color:#38bdf8;letter-spacing:8px;">${otp}</span>
            </div>
            <p style="color:#6b7280;font-size:12px;">This code expires in <strong style="color:#f59e0b;">5 minutes</strong>. Never share this code with anyone.</p>
            <p style="color:#4b5563;font-size:11px;margin-top:24px;">⚡ Powered by AroMsg AI</p>
          </div>
        </div>
      `
    })
    console.log(`📧 OTP email sent to ${email}`)
    return true
  } catch (err) {
    console.error('[OTP EMAIL ERROR]:', err.message)
    return false
  }
}

// ─── Get vendor analytics from Firestore ───────────────────────────────────
async function getVendorAnalytics(db, businessId) {
  try {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000

    const [ordersWeek, ordersMonth, contextsSnap] = await Promise.all([
      db.collection('businesses').doc(businessId).collection('orders')
        .where('createdAt', '>', weekAgo).get(),
      db.collection('businesses').doc(businessId).collection('orders')
        .where('createdAt', '>', monthAgo).get(),
      db.collection('businesses').doc(businessId).collection('contexts').get()
    ])

    const ordersWeekData = ordersWeek.docs.map(d => d.data())
    const ordersMonthData = ordersMonth.docs.map(d => d.data())

    const totalRevenueWeek = ordersWeekData
      .filter(o => o.status === 'PROCESSING_DISPATCH' || o.status === 'PAID')
      .reduce((sum, o) => sum + (o.amount || 0), 0)

    const totalRevenueMonth = ordersMonthData
      .filter(o => o.status === 'PROCESSING_DISPATCH' || o.status === 'PAID')
      .reduce((sum, o) => sum + (o.amount || 0), 0)

    const pendingOrders = ordersMonthData.filter(o => o.status === 'PENDING').length
    const abandonedOrders = ordersMonthData.filter(o => o.status === 'ABANDONED').length
    const totalOrders = ordersMonthData.length

    // Find top product
    const productCounts = {}
    ordersMonthData.forEach(o => {
      if (o.product) productCounts[o.product] = (productCounts[o.product] || 0) + 1
    })
    const topProduct = Object.entries(productCounts).sort((a, b) => b[1] - a[1])[0]

    return {
      totalRevenueWeek,
      totalRevenueMonth,
      totalOrders,
      pendingOrders,
      abandonedOrders,
      activeConversations: contextsSnap.size,
      topProduct: topProduct ? topProduct[0] : 'None yet',
      conversionRate: totalOrders > 0 ? Math.round(((totalOrders - abandonedOrders) / totalOrders) * 100) : 0
    }
  } catch (err) {
    console.error('[ANALYTICS ERROR]:', err.message)
    return null
  }
}

// ─── Resolve bank code from KoraPay ────────────────────────────────────────
async function resolveBankCode(koraSecretKey, bankName) {
  try {
    const res = await axios.get(
      'https://api.korapay.com/merchant/api/v1/misc/banks?countryCode=NG',
      { headers: { Authorization: `Bearer ${koraSecretKey}` }, timeout: 10000 }
    )
    const banks = res.data?.data || []
    const search = bankName.toLowerCase()
    const match = banks.find(b => 
      b.name.toLowerCase().includes(search) || 
      b.slug.toLowerCase().includes(search) ||
      search.includes(b.slug.toLowerCase())
    )
    return match ? match.code : null
  } catch (err) {
    console.error('[BANK RESOLVE ERROR]:', err.message)
    return null
  }
}

// ─── Verify account number via KoraPay ─────────────────────────────────────
async function verifyBankAccount(koraSecretKey, bankCode, accountNumber) {
  try {
    const res = await axios.post(
      'https://api.korapay.com/merchant/api/v1/misc/banks/resolve',
      { bank: bankCode, account: accountNumber, currency: 'NGN' },
      { headers: { Authorization: `Bearer ${koraSecretKey}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    )
    return res.data?.data || null
  } catch {
    return null
  }
}

// ─── Execute KoraPay payout ────────────────────────────────────────────────
async function executeKoraPayout(amount, bankCode, accountNumber, accountName, email, narration) {
  const reference = `KPY-D-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`
  
  try {
    const res = await axios.post(
      'https://api.korapay.com/merchant/api/v1/transactions/disburse',
      {
        reference,
        destination: {
          type: 'bank_account',
          amount: Number(amount),
          currency: 'NGN',
          narration: narration || 'Vendor payout - AroMsg',
          bank_account: { bank: bankCode, account: accountNumber },
          customer: { name: accountName, email: email || 'vendor@aromsg.app' }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.KORAPAY_SECRET_KEY || process.env.KORA_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    )
    return { success: true, reference, data: res.data?.data || res.data }
  } catch (err) {
    console.error('[PAYOUT EXEC ERROR]:', err.response?.data || err.message)
    return { success: false, reference, error: err.response?.data || err.message }
  }
}

// ─── Generate payout receipt image ─────────────────────────────────────────
async function generatePayoutReceipt({ amount, bankName, accountNumber, accountName, reference, businessName, fee }) {
  const sharp = require('sharp')
  const path = require('path')
  const fs = require('fs')
  
  const INVOICES_DIR = path.join(__dirname, 'invoices')
  if (!fs.existsSync(INVOICES_DIR)) fs.mkdirSync(INVOICES_DIR, { recursive: true })

  const safeRef = reference.replace(/[^a-zA-Z0-9_-]/g, '')
  const filename = `payout_${safeRef}.png`
  const filepath = path.join(INVOICES_DIR, filename)

  // Skip if already exists
  if (fs.existsSync(filepath)) return { filename, url: `/invoice/${filename}` }

  const formattedAmount = Number(amount).toLocaleString()
  const formattedFee = Number(fee || 0).toLocaleString()

  const svg = `<svg width="600" height="500" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0b0f17"/>
      <stop offset="100%" style="stop-color:#111827"/>
    </linearGradient>
  </defs>
  <rect width="600" height="500" fill="url(#bg)" rx="16"/>
  <rect x="50" y="40" width="500" height="420" rx="24" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
  <text x="80" y="90" fill="#9ca3af" font-size="16" font-family="Arial, sans-serif" font-weight="bold">${escapeXml(businessName || 'AroMsg')}</text>
  <rect x="400" y="72" width="120" height="28" rx="12" fill="#065f46"/>
  <text x="410" y="91" fill="#34d399" font-size="12" font-family="Arial, sans-serif" font-weight="bold">PAYOUT SENT ✅</text>
  <text x="80" y="150" fill="#6b7280" font-size="14" font-family="Arial, sans-serif">Amount Disbursed</text>
  <text x="80" y="200" fill="#34d399" font-size="42" font-family="Arial, sans-serif" font-weight="bold">₦${escapeXml(formattedAmount)}</text>
  <line x1="80" y1="230" x2="520" y2="230" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
  <rect x="80" y="260" width="440" height="140" rx="16" fill="#111827"/>
  <text x="100" y="295" fill="#9ca3af" font-size="14" font-family="Arial, sans-serif">Bank</text>
  <text x="370" y="295" fill="#ffffff" font-size="14" font-family="Arial, sans-serif" font-weight="bold" text-anchor="end">${escapeXml(bankName)}</text>
  <text x="100" y="325" fill="#9ca3af" font-size="14" font-family="Arial, sans-serif">Account Number</text>
  <text x="370" y="325" fill="#38bdf8" font-size="16" font-family="Arial, sans-serif" font-weight="bold" text-anchor="end">${escapeXml(accountNumber)}</text>
  <text x="100" y="355" fill="#9ca3af" font-size="14" font-family="Arial, sans-serif">Account Name</text>
  <text x="370" y="355" fill="#ffffff" font-size="14" font-family="Arial, sans-serif" text-anchor="end">${escapeXml(accountName)}</text>
  <text x="100" y="385" fill="#9ca3af" font-size="14" font-family="Arial, sans-serif">Fee</text>
  <text x="370" y="385" fill="#f59e0b" font-size="14" font-family="Arial, sans-serif" text-anchor="end">₦${escapeXml(formattedFee)}</text>
  <line x1="80" y1="410" x2="520" y2="410" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
  <text x="100" y="440" fill="#6b7280" font-size="11" font-family="Arial, sans-serif">Ref: ${escapeXml(reference)}</text>
  <text x="520" y="440" fill="#4b5563" font-size="12" font-family="Arial, sans-serif" text-anchor="end">⚡ AroMsg AI</text>
</svg>`

  function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  await sharp(Buffer.from(svg)).png({ quality: 90 }).toFile(filepath)
  console.log(`🧾 Payout receipt generated: ${filename}`)
  return { filename, url: `/invoice/${filename}` }
}

// ─── Save payout record to Firestore ───────────────────────────────────────
async function savePayoutRecord(db, businessId, { reference, amount, bankName, accountNumber, accountName, status, fee }) {
  try {
    await db.collection('businesses').doc(businessId).collection('payouts').doc(reference).set({
      reference,
      amount: Number(amount),
      bankName,
      accountNumber,
      accountName,
      status: status || 'processing',
      fee: Number(fee || 0),
      createdAt: Date.now()
    })
  } catch (err) {
    console.error('[PAYOUT SAVE ERROR]:', err.message)
  }
}

// ─── Handle OTP check (called BEFORE AI) ───────────────────────────────────
async function checkPendingOTP(businessId, phoneNumber, userText) {
  const pending = pendingPayouts.get(phoneNumber)
  if (!pending || pending.step !== 'awaiting_otp') return null
  if (pending.businessId !== businessId) return null
  if (Date.now() > pending.expiresAt) {
    pendingPayouts.delete(phoneNumber)
    return { reply: 'Your OTP has expired. Please request the payout again.', clear: true }
  }

  const trimmed = userText.trim()
  if (trimmed === pending.otp) {
    // OTP correct — execute payout
    pending.step = 'confirmed'

    const result = await executeKoraPayout(
      pending.amount,
      pending.bankCode,
      pending.accountNumber,
      pending.accountName,
      process.env.VENDOR_EMAIL,
      'Vendor payout - AroMsg'
    )

    if (result.success) {
      const fee = result.data?.fee || 25
      await savePayoutRecord(db, businessId, {
        reference: result.reference,
        amount: pending.amount,
        bankName: pending.bankName,
        accountNumber: pending.accountNumber,
        accountName: pending.accountName,
        status: 'processing',
        fee
      })

      // Generate receipt
      const receipt = await generatePayoutReceipt({
        amount: pending.amount,
        bankName: pending.bankName,
        accountNumber: pending.accountNumber,
        accountName: pending.accountName,
        reference: result.reference,
        businessName: pending.businessName || 'Vendor',
        fee
      })

      pendingPayouts.delete(phoneNumber)

      return {
        reply: `✅ Payout of ₦${Number(pending.amount).toLocaleString()} to ${pending.bankName} (${pending.accountNumber}) has been initiated successfully! 🎉\n\nRef: ${result.reference}\nFee: ₦${fee.toLocaleString()}`,
        receipt,
        clear: true
      }
    } else {
      pendingPayouts.delete(phoneNumber)
      return { reply: `❌ Payout failed: ${result.error?.message || 'Unknown error'}. Please try again or contact support.`, clear: true }
    }
  } else {
    return { reply: `❌ Invalid OTP. Please check the code sent to your email and try again. You have ${Math.ceil((pending.expiresAt - Date.now()) / 60000)} minute(s) left.`, clear: false }
  }
}

// ─── Main vendor chat handler ──────────────────────────────────────────────
async function handleVendorChat(businessId, phoneNumber, userText, storeContext, db, sendReply) {
  // Step 1: Check if there's a pending OTP
  const otpResult = await checkPendingOTP(businessId, phoneNumber, userText)
  if (otpResult) {
    if (otpResult.receipt) {
      const baseUrl = `${process.env.BASE_URL || 'http://localhost:3000'}`
      await sendReply(otpResult.reply)
      await sendVendorMedia(businessId, phoneNumber, `${baseUrl}${otpResult.receipt.url}`, 'Your payout receipt 📄')
    } else {
      await sendReply(otpResult.reply)
    }
    return
  }

  // Step 2: Check if we're awaiting bank details
  const pending = pendingPayouts.get(phoneNumber)
  if (pending && pending.step === 'awaiting_bank_details') {
    // Use AI to extract bank details from the vendor's message
    const extracted = await extractBankDetails(userText)
    if (extracted && extracted.accountNumber && extracted.bankName && extracted.accountName) {
      // Resolve bank code
      const bankCode = await resolveBankCode(process.env.KORAPAY_SECRET_KEY || process.env.KORA_SECRET_KEY, extracted.bankName)
      if (!bankCode) {
        await sendReply(`Sorry boss, I couldn't find the bank code for "${extracted.bankName}". Can you check the bank name and drop am again?`)
        return
      }

      // Verify account (optional but good)
      const verified = await verifyBankAccount(process.env.KORAPAY_SECRET_KEY || process.env.KORA_SECRET_KEY, bankCode, extracted.accountNumber)
      const verifiedName = verified?.account_name
      const matchName = verifiedName && verifiedName.toLowerCase().includes(extracted.accountName.toLowerCase())

      // Update pending with bank details
      pending.bankCode = bankCode
      pending.accountNumber = extracted.accountNumber
      pending.accountName = extracted.accountName
      pending.bankName = verified?.bank_name || extracted.bankName
      pending.amount = extracted.amount || pending.amount

      // Generate and send OTP
      const otp = generateOTP()
      pending.otp = otp
      pending.expiresAt = Date.now() + 5 * 60 * 1000
      pending.step = 'awaiting_otp'

      const emailSent = await sendOTPEmail(process.env.VENDOR_EMAIL || 'vendor@aromsg.app', otp)

      if (emailSent) {
        const matchMsg = verifiedName 
          ? matchName 
            ? `\n✅ Account verified: ${verifiedName}`
            : `\n⚠️ Name mismatch: Bank says "${verifiedName}" but you said "${extracted.accountName}". Proceed?`
          : ''

        await sendReply(`I've sent an OTP code to your registered email 📧\n\nPlease check your email and reply with the 6-digit OTP to confirm the payout of ₦${Number(pending.amount).toLocaleString()} to ${pending.bankName} (${extracted.accountNumber}).${matchMsg}\n\n⏳ Code expires in 5 minutes.`)
      } else {
        await sendReply(`❌ I couldn't send the OTP email. Please check your email configuration and try again.`)
        pendingPayouts.delete(phoneNumber)
      }
      return
    } else {
      await sendReply(`Boss, I need your Account Number, Bank Name, and Account Name to process the payout. Drop them like this:\n\nAccount Number: 0123456789\nBank: Access Bank\nAccount Name: John Doe`)
      return
    }
  }

  // Step 3: Check for payout intent
  const payoutIntent = await detectPayoutIntent(userText)
  if (payoutIntent) {
    pendingPayouts.set(phoneNumber, {
      step: 'awaiting_bank_details',
      businessId,
      businessName: storeContext.businessName,
      amount: payoutIntent.amount,
      expiresAt: Date.now() + 10 * 60 * 1000
    })
    // Auto-clean after 10 min
    setTimeout(() => {
      const p = pendingPayouts.get(phoneNumber)
      if (p && p.step === 'awaiting_bank_details') pendingPayouts.delete(phoneNumber)
    }, 10 * 60 * 1000)

    await sendReply(`Alright! I'll process a payout of ₦${Number(payoutIntent.amount).toLocaleString()} for you.\n\nTo proceed, I need your:\n1️⃣ Account Number\n2️⃣ Bank Name\n3️⃣ Account Name\n\nDrop them for me sharp sharp!`)
    return
  }

  // Step 4: Check for analytics intent or general chat
  const analyticsIntent = await detectAnalyticsIntent(userText)
  if (analyticsIntent) {
    const analytics = await getVendorAnalytics(db, businessId)
    if (analytics) {
      const topProd = analytics.topProduct || 'No sales yet'
      await sendReply(`📊 *Sales Summary (Last 7 Days)*\n\n💰 Revenue: ₦${analytics.totalRevenueWeek.toLocaleString()}\n📈 Monthly Revenue: ₦${analytics.totalRevenueMonth.toLocaleString()}\n📦 Total Orders: ${analytics.totalOrders}\n⏳ Pending: ${analytics.pendingOrders}\n❌ Abandoned: ${analytics.abandonedOrders}\n🔄 Conversion Rate: ${analytics.conversionRate}%\n👥 Active Chats: ${analytics.activeConversations}\n🏆 Top Product: ${topProd}\n\nType "payout" if you want to withdraw your funds! 💰`)
    } else {
      await sendReply(`Boss, I couldn't fetch your analytics right now. Abeg try again small.`)
    }
    return
  }

  // Step 5: General AI chat
  await sendReply(await getGeneralAIResponse(userText, storeContext))
}

// ─── AI intent detection helpers ───────────────────────────────────────────
async function detectPayoutIntent(text) {
  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp',
        messages: [
          { role: 'system', content: `You detect if a vendor wants a payout/withdrawal. 
If YES, extract the amount as a number. 
If NO, return null.
Return ONLY valid JSON: {"intent": true/false, "amount": number|null}
Examples:
"Pay me ₦50k" → {"intent":true,"amount":50000}
"Send ₦100,000 to my account" → {"intent":true,"amount":100000}
"I want to withdraw 25k" → {"intent":true,"amount":25000}
"How is sales?" → {"intent":false,"amount":null}
"Good morning" → {"intent":false,"amount":null}` },
          { role: 'user', content: text }
        ],
        temperature: 0.1
      },
      { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }, timeout: 10000 }
    )
    const parsed = JSON.parse(res.data.choices[0]?.message?.content || '{}')
    return parsed.intent ? parsed : null
  } catch {
    // Fallback: simple regex
    const match = text.match(/(\d[\d,]+)\s*k?/i)
    if (match && (text.toLowerCase().includes('payout') || text.toLowerCase().includes('withdraw') || text.toLowerCase().includes('send') || text.toLowerCase().includes('pay'))) {
      const num = parseFloat(match[1].replace(/,/g, ''))
      if (text.includes('k') && !match[1].includes(',')) return { intent: true, amount: num * 1000 }
      return { intent: true, amount: num }
    }
    return null
  }
}

async function detectAnalyticsIntent(text) {
  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp',
        messages: [
          { role: 'system', content: `Detect if the vendor is asking about sales, revenue, orders, or business performance.
Return ONLY JSON: {"analytics": true/false}
Examples:
"How sales today?" → true
"Show my revenue" → true
"How many orders?" → true
"Good morning" → false
"Thanks" → false` },
          { role: 'user', content: text }
        ],
        temperature: 0.1
      },
      { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }, timeout: 10000 }
    )
    const parsed = JSON.parse(res.data.choices[0]?.message?.content || '{}')
    return parsed.analytics
  } catch {
    return false
  }
}

async function extractBankDetails(text) {
  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp',
        messages: [
          { role: 'system', content: `Extract bank account details from the vendor's message.
Return ONLY valid JSON with these fields (null if not found):
{"accountNumber": "string or null", "bankName": "string or null", "accountName": "string or null"}
Examples:
"0123456789, Access Bank, John Doe" → {"accountNumber":"0123456789","bankName":"Access Bank","accountName":"John Doe"}
"Access 0123456789 John" → {"accountNumber":"0123456789","bankName":"Access Bank","accountName":"John"}
"My account is 0123456789 GTBank" → {"accountNumber":"0123456789","bankName":"GTBank","accountName":null}
"Hello" → {"accountNumber":null,"bankName":null,"accountName":null}` },
          { role: 'user', content: text }
        ],
        temperature: 0.1
      },
      { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }, timeout: 10000 }
    )
    return JSON.parse(res.data.choices[0]?.message?.content || '{}')
  } catch {
    return null
  }
}

async function getGeneralAIResponse(userText, storeContext) {
  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp',
        messages: [
          { role: 'system', content: `You are Aro, an AI sales assistant for ${storeContext.businessName || 'a Nigerian business'}. 
You're chatting with the business owner via WhatsApp.
Keep replies short, casual, and helpful (1-3 sentences).
Use natural Nigerian trading English.
You can discuss sales, customers, products, and business operations.
If the owner asks something you can't answer, suggest they check the dashboard.
NEVER make up specific numbers — direct them to analytics if needed.` },
          { role: 'user', content: userText }
        ],
        temperature: 0.5
      },
      { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }, timeout: 15000 }
    )
    return res.data.choices[0]?.message?.content?.trim() || 'Yes boss, I hear you!'
  } catch {
    return 'Yes boss, I hear you!'
  }
}

// ─── Send reply via gateway (uses injected function) ──────────────────────
async function sendVendorReply(businessId, phoneNumber, text) {
  await sendReplyViaGateway(businessId, `${phoneNumber}@s.whatsapp.net`, text)
}

async function sendVendorMedia(businessId, phoneNumber, mediaUrl, caption) {
  try {
    await axios.post(`${process.env.GATEWAY_URL || 'http://localhost:3001'}/send-media`, {
      userId: businessId,
      to: `${phoneNumber}@s.whatsapp.net`,
      mediaUrl,
      caption: caption || ''
    }, {
      headers: { Authorization: `Bearer ${process.env.INTERNAL_API_KEY}` },
      timeout: 15000
    })
  } catch (err) {
    console.error('[VENDOR MEDIA SEND ERROR]:', err.message)
  }
}

return {
  handleVendorChat,
  checkPendingOTP,
  pendingPayouts,
  getVendorAnalytics,
  executeKoraPayout,
  generatePayoutReceipt,
  savePayoutRecord,
  sendVendorReply,
  sendVendorMedia
}

}

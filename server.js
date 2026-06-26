require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MemoryStore = require('memorystore')(session)
const rateLimit = require('express-rate-limit'); 
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
app.set('trust proxy', 1);
const PORT = 3000;

// ===================== CUSTOM ID PREFIX CONFIGURATION =====================
const startId = {
  apikey: 'MTZ',        // Prefix untuk API Key
  invoice: 'INV',       // Prefix untuk Invoice
  withdraw: 'WD',       // Prefix untuk Withdrawal
  transaction: 'TRX'    // Prefix untuk Transaction
};

// ===================== MIDDLEWARE DASAR =====================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false,
  store: new MemoryStore({
      checkPeriod: 86400000
    }),
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ===================== SETUP LIMITER =====================
const Limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 15, 
  handler: (req, res) => {
    req.session.errorMsg = 'Terlalu banyak percobaan login. Silakan coba lagi setelah 5 menit.';
    res.redirect('/login');
  }
});

// ===================== MongoDB =====================
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
  console.log('✅ MongoDB terhubung')
  await seed();
  })
  .catch(err => console.error('❌ MongoDB gagal:', err));

// ===================== CUSTOM ID GENERATOR (8 KARAKTER) =====================
function generateCustomId(prefix) {
  const len = 10 - prefix.length;
  const randomHex = crypto.randomBytes(Math.ceil(len / 2)).toString('hex').substring(0, len);
  return prefix + randomHex;
}

// Generate API Key menggunakan prefix dari startId.apikey
function generateApiKey() {
  return startId.apikey + '_' + crypto.randomUUID().replace(/-/g, '').substring(0, 16);
}

// ===================== MODELS =====================
const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    validate: {
      validator: function(v) {
        return /^[a-zA-Z0-9]+$/.test(v);
      },
      message: 'Username hanya boleh berisi huruf dan angka (tanpa spasi atau simbol)'
    },
    maxlength: [15, 'Username maksimal 15 karakter']
  },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 0 },
  role: { type: String, default: 'user', enum: ['user', 'admin'] },
  suspended: { type: Boolean, default: false },
  ewallet: { type: String, default: '' },
  accountNumber: { type: String, default: '' },
  accountName: { type: String, default: '' },
  resetPasswordToken: String,
  resetPasswordExpires: Date,
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const invoiceSchema = new mongoose.Schema({
  _id: {
    type: String,
    default: () => generateCustomId(startId.invoice)
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  amount: Number,
  fee: Number,
  total: Number,
  trxid: String,
  qris_image: String,
  mutationId: { type: String, default: null },
  expiredAt: Date,
  status: {
    type: String,
    default: 'pending',
    enum: ['pending', 'paid', 'expired']
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});
const Invoice = mongoose.model('Invoice', invoiceSchema);

const transactionSchema = new mongoose.Schema({
  _id: {
    type: String,
    default: () => generateCustomId(startId.transaction)
  },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['deposit', 'withdraw'] },
  amount: Number,
  fee: Number,
  status: String,
  reference: String,
  expiredAt: Date,
  createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

const withdrawSchema = new mongoose.Schema({
  _id: {
    type: String,
    default: () => generateCustomId(startId.withdraw)
  },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  amount: Number,
  fee: Number,
  method: String,
  accountNumber: String,
  accountName: String,
  status: { type: String, default: 'pending', enum: ['pending', 'success', 'rejected'] },
  adminNote: String,
  createdAt: { type: Date, default: Date.now }
});
const Withdrawal = mongoose.model('Withdrawal', withdrawSchema);

const apiKeySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  key: { type: String, unique: true },
  createdAt: { type: Date, default: Date.now }
});
const ApiKey = mongoose.model('ApiKey', apiKeySchema);

const settingSchema = new mongoose.Schema({
  name: { type: String, default: 'Dai Gateway' },
  title: { type: String, default: 'Layanan Payment Gateway' },
  description: { type: String, default: 'Terima pembayaran melalui QRIS Payment untuk Aplikasi atau Platform Bisnis kamu dengan mudah, cepat, dan aman.' },
  channelWhatsApp: { type: String, default: 'https://whatsapp.com/channel/xxxx' },
  apiDomain: String,
  apiKey: String,
  username: String,
  token: String,
  minDeposit: { type: Number, default: 1000 },
  minWithdraw: { type: Number, default: 5000 },
  feeWithdraw: { type: Number, default: 1000 },
  maxFee: { type: Number, default: 500 },
  checkInterval: { type: Number, default: 20 },
  autoCheckEnabled: { type: Boolean, default: true },
  smtpUser: { type: String, default: '' },
  smtpPass: { type: String, default: '' },
  telegramBotToken: { type: String, default: '' },
  telegramAdminChatId: { type: String, default: '' },
  logoUrl: { type: String, default: '' }
});
const Setting = mongoose.model('Setting', settingSchema);

const statsSchema = new mongoose.Schema({
  totalDepositAmount: { type: Number, default: 0 },
  totalDepositFee: { type: Number, default: 0 },
  totalWithdrawAmount: { type: Number, default: 0 },
  totalWithdrawFee: { type: Number, default: 0 },
  totalUsers: { type: Number, default: 0 },
  totalTransactions: { type: Number, default: 0 }
});
const Stats = mongoose.model('Stats', statsSchema);

// ===================== ANTI-DUPLICATE HELPER =====================
async function createWithRetry(Model, data, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await Model.create(data);
    } catch (err) {
      if (err.code === 11000 && attempt < maxRetries - 1) {
        // Duplikasi ID, generate ID baru sesuai Model
        if (Model === Invoice) data._id = generateCustomId(startId.invoice);
        else if (Model === Transaction) data._id = generateCustomId(startId.transaction);
        else if (Model === Withdrawal) data._id = generateCustomId(startId.withdraw);
        else if (Model === ApiKey) data.key = generateApiKey();
        continue;
      }
      throw err;
    }
  }
  throw new Error('Gagal membuat dokumen setelah beberapa kali percobaan (duplicate ID)');
}

// ===================== HELPERS =====================
async function getSettings() {
  let s = await Setting.findOne();
  if (!s) s = await Setting.create({});
  return s;
}

async function getStats() {
  const [depositAgg, withdrawAgg, totalUsers, totalTrx] = await Promise.all([
    Transaction.aggregate([
      { $match: { type: 'deposit', status: 'paid' } },
      { $group: { _id: null, totalAmount: { $sum: '$amount' }, totalFee: { $sum: '$fee' } } }
    ]),
    Transaction.aggregate([
      { $match: { type: 'withdraw', status: 'success' } },
      { $group: { _id: null, totalAmount: { $sum: '$amount' }, totalFee: { $sum: '$fee' } } }
    ]),
    User.countDocuments({ role: 'user' }),
    Transaction.countDocuments()
  ]);

  const dAmount = depositAgg[0]?.totalAmount || 0;
  const dFee = depositAgg[0]?.totalFee || 0;
  const wAmount = withdrawAgg[0]?.totalAmount || 0;
  const wFee = withdrawAgg[0]?.totalFee || 0;

  await Stats.findOneAndUpdate({}, {
    totalDepositAmount: dAmount,
    totalDepositFee: dFee,
    totalWithdrawAmount: wAmount,
    totalWithdrawFee: wFee,
    totalUsers,
    totalTransactions: totalTrx
  }, { upsert: true });

  return {
    totalDepositAmount: dAmount,
    totalDepositFee: dFee,
    totalWithdrawAmount: wAmount,
    totalWithdrawFee: wFee,
    totalUsers,
    totalTransactions: totalTrx
  };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex') === hash;
}

// ===================== TELEGRAM BOT FUNCTIONS =====================
let pollingTimeout = null;
let isPollingActive = false;

function getAdminChatId() {
  return getSettings().then(s => s.telegramAdminChatId || null);
}

async function sendTelegramMessage(chatId, text, replyMarkup) {
  const settings = await getSettings();
  const token = settings.telegramBotToken;
  if (!token || !chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: replyMarkup
    });
  } catch (e) {
    console.error('Telegram sendMessage error:', e.response?.data || e.message);
  }
}

async function deleteMessage(chatId, messageId) {
  const settings = await getSettings();
  const token = settings.telegramBotToken;
  if (!token) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId
    });
  } catch (e) {
    console.error('Telegram deleteMessage error:', e.response?.data || e.message);
  }
}

async function answerCallbackQuery(callbackQueryId, text) {
  const settings = await getSettings();
  const token = settings.telegramBotToken;
  if (!token) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false
    });
  } catch (e) {}
}

const REJECT_REASONS = {
  1: 'Rekening Tidak Valid',
  2: 'Ewallet Tidak Valid',
  3: 'System Maintenance'
};

async function handleCallbackQuery(cb) {
  const data = cb.data;
  if (!data) return;

  const parts = data.split(':');
  const action = parts[0];
  const id = parts[1];
  if (!id) return;

  const wd = await Withdrawal.findById(id);
  const settings = await getSettings();
  if (!wd) {
    await answerCallbackQuery(cb.id, 'Withdrawal tidak ditemukan.');
    return;
  }
  if (wd.status !== 'pending') {
    await answerCallbackQuery(cb.id, 'Withdrawal sudah diproses.');
    return;
  }

  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const user = await User.findById(wd.userId);
  if (!user) {
    await answerCallbackQuery(cb.id, 'User tidak ditemukan.');
    return;
  }

  const timeString = new Date(wd.createdAt).toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).replace(/, /, ' pukul ');

  const userInfoText = (u) =>
    `👤 *Informasi User*\n` +
    `• *User:* ${u.username} (${u.email})\n` +
    `• *Saldo Saat Ini:* Rp ${u.balance.toLocaleString()}\n` +
    `• *E-Wallet:* ${u.ewallet}\n` +
    `• *No. Rek:* \`${u.accountNumber}\`\n` +
    `• *Nama Rek:* ${u.accountName}\n\n`;

  const withdrawInfoText = () =>
    `📤 *Informasi Withdraw*\n` +
    `• *Jumlah:* Rp ${wd.amount.toLocaleString()}\n` +
    `• *Biaya:* Rp ${wd.fee.toLocaleString()}\n` +
    `• *Total Tarik:* Rp ${(wd.amount + wd.fee).toLocaleString()}\n` +
    `• *ID Withdraw:* ${wd._id}\n` +
    `• *Waktu:* ${timeString}\n`;

  const header = `🌐 *Notifikasi - ${settings.name}*\n\n`;

  if (action === 'approve_wd') {
    wd.status = 'success';
    await wd.save();
    await Transaction.updateOne(
      { userId: wd.userId, type: 'withdraw', status: 'pending', reference: { $regex: /^W/ } },
      { status: 'success' }
    );
    await Stats.updateOne({}, { $inc: { totalWithdrawAmount: wd.amount, totalWithdrawFee: wd.fee } });
    await deleteMessage(chatId, messageId);
    await sendTelegramMessage(
      chatId,
      header + userInfoText(user) + withdrawInfoText() + `• *Status:* ✅ Berhasil`
    );
    await answerCallbackQuery(cb.id, 'Withdrawal disetujui.');
  } else if (action === 'reason_wd') {
    const reasonsKeyboard = {
      inline_keyboard: [
        [{ text: '1️⃣ Rekening Tidak Valid', callback_data: `reject_wd:${wd._id}:1` }],
        [{ text: '2️⃣ Ewallet Tidak Valid', callback_data: `reject_wd:${wd._id}:2` }],
        [{ text: '3️⃣ System Maintenance', callback_data: `reject_wd:${wd._id}:3` }],
        [{ text: '🔙 Batal', callback_data: `cancel_wd:${wd._id}` }]
      ]
    };
    try {
      await axios.post(`https://api.telegram.org/bot${settings.telegramBotToken}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text: header + userInfoText(user) + withdrawInfoText() + `\n*Pilih alasan penolakan:*`,
        parse_mode: 'Markdown',
        reply_markup: reasonsKeyboard
      });
    } catch (e) {}
    await answerCallbackQuery(cb.id, 'Pilih alasan penolakan:');
  } else if (action === 'reject_wd') {
    const reasonId = parts[2];
    const reasonText = REJECT_REASONS[reasonId] || 'Ditolak via bot';
    wd.status = 'rejected';
    wd.adminNote = reasonText;
    await wd.save();
    await User.findByIdAndUpdate(wd.userId, { $inc: { balance: wd.amount + wd.fee } });
    const updatedUser = await User.findById(wd.userId);
    await Transaction.updateOne(
      { userId: wd.userId, type: 'withdraw', status: 'pending', reference: { $regex: /^W/ } },
      { status: 'rejected' }
    );
    await deleteMessage(chatId, messageId);
    await sendTelegramMessage(
      chatId,
      header + userInfoText(updatedUser) + withdrawInfoText() +
      `• *Status:* ❌ Ditolak\n📝 Alasan: ${reasonText}\n♻️ Saldo sudah dikembalikan.`
    );
    await answerCallbackQuery(cb.id, 'Withdrawal ditolak, saldo dikembalikan.');
  } else if (action === 'cancel_wd') {
    const origKeyboard = {
      inline_keyboard: [
        [
          { text: '✅ Setujui', callback_data: `approve_wd:${wd._id}` },
          { text: '❌ Tolak', callback_data: `reason_wd:${wd._id}` }
        ]
      ]
    };
    try {
      await axios.post(`https://api.telegram.org/bot${settings.telegramBotToken}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text: header + userInfoText(user) + withdrawInfoText(),
        parse_mode: 'Markdown',
        reply_markup: origKeyboard
      });
    } catch (e) {}
    await answerCallbackQuery(cb.id, 'Dibatalkan.');
  }
}

async function handleTelegramUpdate(update) {
  const settings = await getSettings();
  const adminChatId = settings.telegramAdminChatId;
  if (!adminChatId) return;
  if (update.callback_query) {
    const cb = update.callback_query;
    if (cb.message && cb.message.chat && String(cb.message.chat.id) === String(adminChatId)) {
      await handleCallbackQuery(cb);
    }
  } else if (update.message && update.message.text) {
    const msg = update.message;
    if (String(msg.chat.id) === String(adminChatId)) {
      if (msg.text === '/start') {
        sendTelegramMessage(adminChatId, `Chat ID kamu: ${msg.chat.id}\nUsername: @${msg.chat.username || 'tidak disetel'}\nBot sudah terhubung.`);
      }
    }
  }
}

async function telegramGetUpdates(offset) {
  const settings = await getSettings();
  const token = settings.telegramBotToken;
  if (!token) return [];
  try {
    const res = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`, {
      params: { offset, timeout: 15 },
      timeout: 20000
    });
    if (res.data.ok) return res.data.result;
    else {
      console.error('Telegram getUpdates tidak ok:', res.data);
      return [];
    }
  } catch (e) {
    if (e.response && e.response.status === 409) {
      console.error('Error 409 Conflict terdeteksi, menghentikan polling.');
      stopTelegramPolling();
    } else {
      console.error('Telegram getUpdates error:', e.message);
    }
    return [];
  }
}

function stopTelegramPolling() {
  if (pollingTimeout) {
    clearTimeout(pollingTimeout);
    pollingTimeout = null;
  }
  isPollingActive = false;
}

async function ensureNoWebhook(token) {
  try {
    const infoRes = await axios.get(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    if (infoRes.data.ok && infoRes.data.result.url) {
      console.log('Webhook terdeteksi, menghapus...');
      await axios.get(`https://api.telegram.org/bot${token}/deleteWebhook`);
      console.log('Webhook dihapus.');
    } else {
      console.log('Tidak ada webhook.');
    }
    return true;
  } catch (e) {
    console.error('Gagal menghapus webhook:', e.message);
    return false;
  }
}

async function startTelegramPolling() {
  stopTelegramPolling();
  const settings = await getSettings();
  if (!settings.telegramBotToken) {
    console.log('Token Telegram belum diisi.');
    return;
  }
  if (isPollingActive) {
    console.log('Polling sudah berjalan.');
    return;
  }
  const ok = await ensureNoWebhook(settings.telegramBotToken);
  if (!ok) {
    console.log('Tidak dapat memastikan webhook, polling tidak dimulai.');
    return;
  }
  isPollingActive = true;
  console.log('Polling Telegram dimulai.');
  let offset = 0;
  async function poll() {
    if (!isPollingActive) return;
    const updates = await telegramGetUpdates(offset);
    for (const update of updates) {
      offset = update.update_id + 1;
      await handleTelegramUpdate(update);
    }
    pollingTimeout = setTimeout(poll, 1000);
  }
  poll();
}

// ===================== GLOBAL MIDDLEWARE =====================
app.use(async (req, res, next) => {
  res.locals.user = null;
  if (req.session.userId) {
    try { res.locals.user = await User.findById(req.session.userId).lean(); } catch {}
  }
  res.locals.settings = await getSettings();
  res.locals.error = req.session.errorMsg || null;
  res.locals.success = req.session.successMsg || null;
  delete req.session.errorMsg;
  delete req.session.successMsg;
  next();
});

function isAuth(req, res, next) {
  if (req.session.userId) return next();
  res.redirect('/login');
}

function isAdmin(req, res, next) {
  if (req.session.userRole === 'admin') return next();
  res.redirect('/login')
}

// ===================== SEED ADMIN =====================
async function seed() {
  const ex = await User.findOne({ role: "admin" });
  if (!ex) {
    await User.create({
      username: 'admin',
      email: 'admin@gmail.com', 
      password: hashPassword('admin123'),
      role: 'admin'
    });
    console.log(`🔑 Admin Account Default\nUsername: admin\nPassword: admin123`);
  }
}

// ===================== ROUTES DASHBOARD / AUTH =====================
app.get('/', (req, res) => res.render('home'));
app.get('/home', (req, res) => res.render('home'));
app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect(req.session.userRole === 'admin' ? '/admin/dashboard' : '/dashboard');
  res.render('login');
});
app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect(req.session.userRole === 'admin' ? '/admin/dashboard' : '/dashboard');
  res.render('register');
});

app.post('/login', Limiter, async (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) {
    req.session.errorMsg = 'Harap isi semua field';
    return res.redirect('/login');
  }
  const isEmail = login.includes('@');
  let user;
  if (isEmail) {
    user = await User.findOne({ email: login.toLowerCase() });
    if (user && user.role === 'admin') {
      req.session.errorMsg = 'Admin hanya dapat login menggunakan username';
      return res.redirect('/login');
    }
  } else {
    user = await User.findOne({ username: login.toLowerCase() });
  }
  if (!user || !verifyPassword(password, user.password)) {
    req.session.errorMsg = 'Username/email atau kata sandi salah';
    return res.redirect('/login');
  }
  if (user.suspended) {
    req.session.errorMsg = 'Akun Anda dinonaktifkan';
    return res.redirect('/login');
  }
  req.session.userId = user._id;
  req.session.userRole = user.role;
  if (user.role === 'admin') return res.redirect('/admin/dashboard');
  res.redirect('/dashboard');
});

app.post('/register', Limiter, async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || username.trim().length === 0) {
    req.session.errorMsg = 'Username tidak boleh kosong';
    return res.redirect('/register');
  }
  if (!/^[a-zA-Z0-9]+$/.test(username)) {
    req.session.errorMsg = 'Username hanya boleh berisi huruf dan angka (tanpa spasi atau simbol)';
    return res.redirect('/register');
  }
  if (username.length > 15) {
    req.session.errorMsg = 'Username maksimal 15 karakter';
    return res.redirect('/register');
  }
  try {
    const user = await User.create({ username, email, password: hashPassword(password) });
    await createWithRetry(ApiKey, { userId: user._id, key: generateApiKey() });
    req.session.userId = user._id;
    req.session.userRole = 'user';
    res.redirect('/dashboard');
  } catch (err) {
    if (err.code === 11000) {
      req.session.errorMsg = 'Username atau email sudah terdaftar';
    } else if (err.name === 'ValidationError') {
      req.session.errorMsg = Object.values(err.errors).map(e => e.message).join(', ');
    } else {
      req.session.errorMsg = 'Gagal mendaftar, periksa kembali data Anda';
    }
    res.redirect('/register');
  }
});

// ===================== LUPA PASSWORD =====================
app.get('/forgot-password', (req, res) => {
  if (req.session.userId) return res.redirect(req.session.userRole === 'admin' ? '/admin/dashboard' : '/dashboard');
  res.render('forgot_password');
});

app.post('/forgot-password', Limiter, async (req, res) => {
  const { login } = req.body; 
  if (!login) {
    req.session.errorMsg = 'Harap masukkan email atau username Anda.';
    return res.redirect('/forgot-password');
  }
  try {
    const settings = await getSettings();
    if (!settings.smtpUser || !settings.smtpPass) {
      req.session.errorMsg = 'Fitur pengiriman email belum dikonfigurasi oleh Administrator.';
      return res.redirect('/forgot-password');
    }
    const isEmail = login.includes('@');
    let user;
    if (isEmail) {
      user = await User.findOne({ email: login.toLowerCase() });
    } else {
      user = await User.findOne({ username: login.toLowerCase() });
    }
    if (!user) {
      req.session.errorMsg = 'Akun tidak ditemukan di sistem kami.';
      return res.redirect('/forgot-password');
    }
    if (!user.email) {
      req.session.errorMsg = 'Akun ini tidak memiliki alamat email yang valid.';
      return res.redirect('/forgot-password');
    }
    const token = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = token;
    user.resetPasswordExpires = Date.now() + 30 * 60 * 1000; 
    await user.save();

    const resetLink = `http://${req.headers.host}/reset-password/${token}`;
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: settings.smtpUser,
        pass: settings.smtpPass
      },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000
    });

    await transporter.sendMail({
      to: user.email,
      from: `"${settings.name}" <${settings.smtpUser}>`,
      subject: `Permintaan Reset Password - ${settings.name}`,
      text: `Halo ${user.username},\n\nKami menerima permintaan untuk mengatur ulang kata sandi akun Anda. Silakan salin tautan berikut ke browser Anda:\n${resetLink}\n\nTautan ini hanya berlaku 30 menit.\n\nJika Anda tidak meminta ini, abaikan email ini.`,
      html: `
        <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f9fafb; padding: 40px 20px; margin: 0;">
          <div style="max-width: 500px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; border: 1px solid #f3f4f6; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
            <div style="height: 6px; background-color: #111827; width: 100%;"></div>
            <div style="padding: 40px;">
              <h2 style="color: #111827; font-size: 18px; font-weight: 600; margin-top: 0; margin-bottom: 16px; text-align: center;">
                Reset Password - ${settings.name}
              </h2>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.6; margin-bottom: 24px;">
                Halo <strong style="color: #111827;">${user.username}</strong>,<br><br>
                Kami menerima permintaan untuk mengatur ulang kata sandi akun Anda di <strong>${settings.name}</strong>. Jika ini memang Anda, silakan klik tombol di bawah ini:
              </p>
              <div style="text-align: center; margin-bottom: 30px;">
                <a href="${resetLink}" style="display: inline-block; background-color: #111827; color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; font-size: 15px;">
                  Ganti Password Saya
                </a>
              </div>
              <p style="color: #dc2626; font-size: 13px; font-weight: 600; text-align: center; margin-bottom: 30px; background-color: #fef2f2; padding: 10px; border-radius: 8px;">
                Tautan ini hanya berlaku selama 30 menit.
              </p>
              <div style="border-top: 1px solid #e5e7eb; padding-top: 24px;">
                <p style="color: #6b7280; font-size: 13px; line-height: 1.5; margin: 0;">
                  Jika tombol di atas tidak berfungsi, salin dan tempel URL berikut ke browser Anda:<br>
                  <a href="${resetLink}" style="color: #2563eb; word-break: break-all;">${resetLink}</a>
                </p>
              </div>
            </div>
          </div>
          <div style="text-align: center; max-width: 500px; margin: 24px auto 0;">
            <p style="color: #9ca3af; font-size: 12px; line-height: 1.5; margin-bottom: 10px;">
              Jika Anda tidak merasa membuat permintaan ini, abaikan email ini dengan aman. Kata sandi Anda tidak akan berubah.
            </p>
            <p style="color: #d1d5db; font-size: 12px;">
              &copy; ${new Date().getFullYear()} ${settings.name}. All rights reserved.
            </p>
          </div>
        </div>
      `
    });
    
    req.session.successMsg = `Link reset password telah dikirim ke email Anda yang terdaftar.`;
    res.redirect('/forgot-password');
  } catch (error) {
    console.error('Error Forgot Password:', error);
    req.session.errorMsg = 'Gagal memproses email. Pastikan konfigurasi SMTP di Admin valid.';
    res.redirect('/forgot-password');
  }
});

app.get('/reset-password/:token', async (req, res) => {
  try {
    const user = await User.findOne({ 
      resetPasswordToken: req.params.token, 
      resetPasswordExpires: { $gt: Date.now() } 
    });
    if (!user) {
      req.session.errorMsg = 'Token reset password tidak valid atau sudah kedaluwarsa (berlaku 30 menit).';
      return res.redirect('/forgot-password');
    }
    res.render('reset_password', { token: req.params.token });
  } catch (error) {
    res.redirect('/login');
  }
});

app.post('/reset-password/:token', async (req, res) => {
  try {
    const user = await User.findOne({ 
      resetPasswordToken: req.params.token, 
      resetPasswordExpires: { $gt: Date.now() } 
    });
    if (!user) {
      req.session.errorMsg = 'Token reset password tidak valid atau sudah kedaluwarsa.';
      return res.redirect('/forgot-password');
    }
    const { password, confirmPassword } = req.body;
    if (password !== confirmPassword) {
      req.session.errorMsg = 'Password dan konfirmasi password tidak cocok.';
      return res.redirect(`/reset-password/${req.params.token}`);
    }
    user.password = hashPassword(password);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();
    req.session.successMsg = 'Password berhasil diubah. Silakan login dengan password baru.';
    res.redirect('/login');
  } catch (error) {
    req.session.errorMsg = 'Gagal mereset password.';
    res.redirect(`/reset-password/${req.params.token}`);
  }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// --- Dashboard User ---
app.get('/dashboard', isAuth, async (req, res) => {
  if (req.session.userRole === 'admin') return res.redirect('/admin/dashboard');
  const userId = req.session.userId;
  const user = res.locals.user;
  const totalDeposit = (await Transaction.aggregate([
    { $match: { userId: user._id, type: 'deposit', status: 'paid' } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]))[0]?.total || 0;
  const totalWithdraw = (await Transaction.aggregate([
    { $match: { userId: user._id, type: 'withdraw', status: 'success' } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]))[0]?.total || 0;
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentTrx = await Transaction.find({
    userId: user._id,
    type: 'deposit',
    createdAt: { $gte: oneDayAgo }
  }).sort({ createdAt: -1 }).limit(5).lean();
  const apiKeys = await ApiKey.find({ userId }).lean();
  res.render('dashboard', { user, totalDeposit, totalWithdraw, recentTrx, apiKeys });
});

// --- Profile ---
app.get('/profile', isAuth, (req, res) => res.render('profile'));
app.post('/profile', isAuth, async (req, res) => {
  const { email, newPassword, ewallet, accountNumber, accountName } = req.body;
  try {
    const upd = { email, ewallet, accountNumber, accountName };
    if (newPassword && newPassword.trim()) upd.password = hashPassword(newPassword);
    await User.findByIdAndUpdate(req.session.userId, upd);
    req.session.successMsg = 'Profil berhasil diperbarui';
    res.redirect('/profile');
  } catch (err) {
    if (err.code === 11000) {
      req.session.errorMsg = 'Email sudah digunakan oleh pengguna lain';
    } else {
      req.session.errorMsg = 'Gagal memperbarui profil';
    }
    res.redirect('/profile');
  }
});

app.post('/api/user/api-key/regenerate', isAuth, async (req, res) => {
  await ApiKey.deleteMany({ userId: req.session.userId });
  const key = generateApiKey();
  try {
    await createWithRetry(ApiKey, { userId: req.session.userId, key });
    res.json({ apiKey: key });
  } catch (err) {
    res.status(500).json({ error: 'Gagal membuat API key' });
  }
});

// --- Deposit ---
app.get('/deposit', isAuth, async (req, res) => {
  const settings = res.locals.settings;
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const deposits = await Transaction.find({
    userId: req.session.userId,
    type: 'deposit',
    createdAt: { $gte: oneDayAgo }
  }).sort({ createdAt: -1 }).lean();
  const invoices = await Invoice.find({ userId: req.session.userId }).sort({ createdAt: -1 }).lean();
  res.render('deposit', { deposits, invoices, minDeposit: settings.minDeposit });
});

app.post('/invoice/create', isAuth, async (req, res) => {
  const settings = res.locals.settings;
  const userId = req.session.userId;
  const amount = parseInt(req.body.amount);
  if (isNaN(amount) || amount < settings.minDeposit) {
    req.session.errorMsg = `Minimal deposit adalah Rp ${settings.minDeposit.toLocaleString('id-ID')}`;
    return res.redirect('/deposit');
  }
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const lockedInvoices = await Invoice.find({
      $or: [{ status: 'pending' }, { status: 'paid', createdAt: { $gte: oneDayAgo } }]
    }).select('fee');
    const usedFees = lockedInvoices.map(i => Number(i.fee)).filter(f => !isNaN(f));
    const availableFees = [];
    for (let i = 1; i <= settings.maxFee; i++) {
      if (!usedFees.includes(i)) availableFees.push(i);
    }
    if (availableFees.length === 0) {
      req.session.errorMsg = 'Kode unik deposit sedang penuh. Silakan coba lagi beberapa menit.';
      return res.redirect('/deposit');
    }
    const fee = availableFees[Math.floor(Math.random() * availableFees.length)];
    const total = amount + fee;
    const url = `https://${settings.apiDomain}/?action=createpayment&apikey=${settings.apiKey}&username=${settings.username}&amount=${total}&token=${settings.token}`;
    const resp = await axios.get(url);
    const data = resp.data;
    if (!data.status) throw new Error('Gagal membuat QRIS dari gateway');
    const expiredAt = new Date(Date.now() + 10 * 60 * 1000);
    const invoice = await createWithRetry(Invoice, {
      userId, amount, fee, total,
      trxid: data.result.trxid,
      qris_image: data.result.qris_image,
      expiredAt
    });
    await createWithRetry(Transaction, {
      userId, type: 'deposit', amount, fee,
      status: 'pending',
      reference: invoice._id.toString(),
      expiredAt
    });
    return res.redirect(`/invoice/${invoice._id}`);
  } catch (e) {
    console.error('Create invoice error:', e.response?.data || e.message);
    req.session.errorMsg = 'Gagal membuat invoice deposit. Silakan coba lagi.';
    return res.redirect('/deposit');
  }
});

app.get('/invoice/:id', isAuth, async (req, res) => {
  const inv = await Invoice.findById(req.params.id).lean();
  if (!inv || inv.userId.toString() !== req.session.userId) return res.status(404).send('Tidak ditemukan');
  res.render('invoice_detail', { inv });
});

// --- Withdraw ---
app.get('/withdraw', isAuth, async (req, res) => {
  const settings = res.locals.settings;
  const withdrawals = await Withdrawal.find({ userId: req.session.userId }).sort({ createdAt: -1 }).lean();
  res.render('withdraw', { settings, withdrawals });
});

app.post('/withdraw/request', isAuth, async (req, res) => {
  const settings = res.locals.settings;
  const user = res.locals.user;
  if (!user.ewallet || !user.accountNumber || !user.accountName) {
    req.session.errorMsg = 'Harap lengkapi data E-Wallet di Profil terlebih dahulu.';
    return res.redirect('/withdraw');
  }
  const { amount } = req.body;
  const amt = parseInt(amount);
  const fee = settings.feeWithdraw || 0;
  const totalDeduct = amt + fee;
  if (isNaN(amt) || amt < settings.minWithdraw) {
    req.session.errorMsg = 'Minimal penarikan Rp ' + settings.minWithdraw;
    return res.redirect('/withdraw');
  }
  const updatedUser = await User.findOneAndUpdate(
    { _id: req.session.userId, balance: { $gte: totalDeduct } },
    { $inc: { balance: -totalDeduct } },
    { new: true }
  );
  if (!updatedUser) {
    req.session.errorMsg = 'Saldo tidak cukup (termasuk biaya admin Rp ' + fee.toLocaleString() + ')';
    return res.redirect('/withdraw');
  }
  try {
    const ref = 'W' + Date.now().toString(36).toUpperCase();
    const wd = await createWithRetry(Withdrawal, {
      userId: req.session.userId, amount: amt, fee,
      method: user.ewallet, accountNumber: user.accountNumber, accountName: user.accountName
    });
    await createWithRetry(Transaction, {
      userId: req.session.userId, type: 'withdraw', amount: amt, fee,
      status: 'pending', reference: ref
    });
    const adminChatId = await getAdminChatId();
    if (adminChatId) {
      const userForMsg = await User.findById(req.session.userId);
      const timeString = new Date(wd.createdAt).toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta', day: '2-digit', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      }).replace(/, /, ' pukul ');
      const header = `🌐 *Notifikasi - ${settings.name}*\n\n`;
      const userInfo = `👤 *Informasi User*\n• *User:* ${userForMsg.username} (${userForMsg.email})\n• *Saldo Saat Ini:* Rp ${updatedUser.balance.toLocaleString()}\n• *E-Wallet:* ${user.ewallet}\n• *No. Rek:* \`${user.accountNumber}\`\n• *Nama Rek:* ${user.accountName}\n\n`;
      const withdrawInfo = `📤 Informasi Withdraw\n• *Jumlah:* Rp ${amt.toLocaleString()}\n• *Biaya:* Rp ${fee.toLocaleString()}\n• *Total Penarikan:* Rp ${totalDeduct.toLocaleString()}\n• *Waktu:* ${timeString}\n`;
      const inlineKeyboard = {
        inline_keyboard: [[
          { text: '✅ Setujui', callback_data: `approve_wd:${wd._id}` },
          { text: '❌ Tolak', callback_data: `reason_wd:${wd._id}` }
        ]]
      };
      sendTelegramMessage(adminChatId, header + userInfo + withdrawInfo, inlineKeyboard);
    }
    req.session.successMsg = 'Penarikan berhasil diajukan dan sedang diproses.';
  } catch {
    await User.findByIdAndUpdate(req.session.userId, { $inc: { balance: totalDeduct } });
    req.session.errorMsg = 'Gagal memproses penarikan sistem.';
  }
  res.redirect('/withdraw');
});

// ===================== ADMIN ROUTES =====================
app.get('/admin/dashboard', isAuth, isAdmin, async (req, res) => {
  const stats = await getStats();
  res.render('admin_dashboard', stats);
});

app.get('/admin/users', isAuth, isAdmin, async (req, res) => {
  const search = req.query.search || '';
  const filter = { role: 'user' };
  if (search) {
    filter.$or = [
      { email: { $regex: search, $options: 'i' } },
      { username: { $regex: search, $options: 'i' } }
    ];
  }
  const users = await User.find(filter).sort({ createdAt: -1 }).lean();
  res.render('admin_users', { users, search });
});

app.get('/admin/users/:id/edit', isAuth, isAdmin, async (req, res) => {
  const targetUser = await User.findById(req.params.id).lean();
  if (!targetUser) return res.status(404).send('Tidak ditemukan');
  res.render('admin_user_edit', { users: targetUser });
});

app.post('/admin/users/:id/edit', isAuth, isAdmin, async (req, res) => {
  const { username, email, password, balance, suspended } = req.body;
  if (username) {
    if (!/^[a-zA-Z0-9]+$/.test(username)) {
      req.session.errorMsg = 'Username hanya boleh berisi huruf dan angka (tanpa spasi atau simbol)';
      return res.redirect(`/admin/users/${req.params.id}/edit`);
    }
    if (username.length > 15) {
      req.session.errorMsg = 'Username maksimal 15 karakter';
      return res.redirect(`/admin/users/${req.params.id}/edit`);
    }
  }
  const upd = {
    username: username?.toLowerCase(),
    email,
    balance: parseInt(balance) || 0,
    suspended: suspended === 'on'
  };
  if (!upd.username) delete upd.username;
  if (password && password.trim()) upd.password = hashPassword(password);
  try {
    await User.findByIdAndUpdate(req.params.id, upd, { runValidators: true });
    req.session.successMsg = 'Data pengguna berhasil diperbarui';
    res.redirect('/admin/users');
  } catch (err) {
    if (err.code === 11000) {
      req.session.errorMsg = 'Username atau email sudah digunakan oleh pengguna lain';
    } else if (err.name === 'ValidationError') {
      req.session.errorMsg = Object.values(err.errors).map(e => e.message).join(', ');
    } else {
      req.session.errorMsg = 'Gagal memperbarui data pengguna';
    }
    res.redirect(`/admin/users/${req.params.id}/edit`);
  }
});

app.post('/admin/users/:id/delete', isAuth, isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const userToDelete = await User.findById(userId);
    if (!userToDelete) {
      req.session.errorMsg = 'User tidak ditemukan.';
      return res.redirect('/admin/users');
    }
    if (userToDelete.role === 'admin') {
      req.session.errorMsg = 'Tidak dapat menghapus akun admin.';
      return res.redirect('/admin/users');
    }
    await Invoice.deleteMany({ userId });
    await Transaction.deleteMany({ userId });
    await Withdrawal.deleteMany({ userId });
    await ApiKey.deleteMany({ userId });
    await User.findByIdAndDelete(userId);
    req.session.successMsg = 'User berhasil dihapus beserta seluruh data terkait.';
    res.redirect('/admin/users');
  } catch (err) {
    console.error(err);
    req.session.errorMsg = 'Gagal menghapus user.';
    res.redirect('/admin/users');
  }
});

app.get('/admin/withdraw', isAuth, isAdmin, async (req, res) => {
  const search = req.query.search || '';
  let filter = {};
  if (search) {
    const users = await User.find({
      $or: [ { email: { $regex: search, $options: 'i' } }, { username: { $regex: search, $options: 'i' } } ]
    }).select('_id');
    const userIds = users.map(u => u._id);
    filter = { userId: { $in: userIds } };
  }
  const withdrawals = await Withdrawal.find(filter).populate('userId', 'username email').sort({ createdAt: -1 }).lean();
  res.render('admin_withdraw', { withdrawals, search });
});

app.post('/admin/withdraw/success/:id', isAuth, isAdmin, async (req, res) => {
  const wd = await Withdrawal.findById(req.params.id);
  if (wd && wd.status === 'pending') {
    wd.status = 'success'; await wd.save();
    await Transaction.updateOne(
      { userId: wd.userId, type: 'withdraw', status: 'pending', reference: { $regex: /^W/ } },
      { status: 'success' }
    );
    await Stats.updateOne({}, { $inc: { totalWithdrawAmount: wd.amount, totalWithdrawFee: wd.fee } });
    req.session.successMsg = 'Penarikan berhasil disetujui.';
  }
  res.redirect('/admin/withdraw');
});

app.post('/admin/withdraw/reject/:id', isAuth, isAdmin, async (req, res) => {
  const wd = await Withdrawal.findById(req.params.id);
  if (wd && wd.status === 'pending') {
    wd.status = 'rejected'; wd.adminNote = req.body.note || ''; await wd.save();
    await User.findByIdAndUpdate(wd.userId, { $inc: { balance: wd.amount + wd.fee } });
    await Transaction.updateOne(
      { userId: wd.userId, type: 'withdraw', status: 'pending', reference: { $regex: /^W/ } },
      { status: 'rejected' }
    );
    req.session.successMsg = 'Penarikan ditolak dan saldo dikembalikan.';
  }
  res.redirect('/admin/withdraw');
});

app.get('/admin/transactions', isAuth, isAdmin, async (req, res) => {
  const search = req.query.search || '';
  let filter = {};
  if (search) {
    const users = await User.find({
      $or: [ { email: { $regex: search, $options: 'i' } }, { username: { $regex: search, $options: 'i' } } ]
    }).select('_id');
    const userIds = users.map(u => u._id);
    filter = { $or: [ { userId: { $in: userIds } }, { reference: { $regex: search, $options: 'i' } } ] };
  }
  const transactions = await Transaction.find(filter).populate('userId', 'username email').sort({ createdAt: -1 }).lean();
  res.render('admin_transactions', { transactions, search });
});

app.get('/admin/account', isAuth, isAdmin, async (req, res) => {
  const admin = await User.findById(req.session.userId).lean();
  res.render('admin_account', { admin });
});

app.post('/admin/account', isAuth, isAdmin, async (req, res) => {
  const { username, password, newPassword } = req.body;
  const admin = await User.findById(req.session.userId).lean();
  if (!password || !verifyPassword(password, admin.password)) {
    req.session.errorMsg = 'Password saat ini salah';
    return res.redirect('/admin/account');
  }
  if (username && username !== admin.username) {
    if (!/^[a-zA-Z0-9]+$/.test(username)) {
      req.session.errorMsg = 'Username hanya boleh berisi huruf dan angka (tanpa spasi atau simbol)';
      return res.redirect('/admin/account');
    }
    if (username.length > 15) {
      req.session.errorMsg = 'Username maksimal 15 karakter';
      return res.redirect('/admin/account');
    }
    const exist = await User.findOne({ username: username.toLowerCase(), _id: { $ne: admin._id } });
    if (exist) {
      req.session.errorMsg = 'Username sudah digunakan oleh pengguna lain';
      return res.redirect('/admin/account');
    }
  }
  try {
    const update = {};
    if (username && username !== admin.username) update.username = username.toLowerCase();
    if (newPassword && newPassword.trim()) update.password = hashPassword(newPassword);
    if (Object.keys(update).length > 0) {
      await User.findByIdAndUpdate(req.session.userId, update);
      req.session.successMsg = 'Data akun berhasil diperbarui';
    } else {
      req.session.errorMsg = 'Tidak ada perubahan yang dilakukan';
    }
  } catch (e) {
    req.session.errorMsg = 'Gagal memperbarui akun';
  }
  res.redirect('/admin/account');
});

app.get('/admin/settings', isAuth, isAdmin, async (req, res) => {
  res.render('admin_settings');
});

app.post('/admin/settings', isAuth, isAdmin, async (req, res) => {
  const { name, title, description, apiDomain, apiKey, username, token, minDeposit, minWithdraw, channelWhatsApp, feeWithdraw, maxFee, checkInterval, autoCheckEnabled, smtpUser, smtpPass, telegramBotToken, telegramAdminChatId, logoUrl } = req.body;
  await Setting.updateOne({}, {
    name, title, description, apiDomain, apiKey, username, token,
    minDeposit: parseInt(minDeposit),
    minWithdraw: parseInt(minWithdraw),
    feeWithdraw: parseInt(feeWithdraw),
    maxFee: parseInt(maxFee),
    channelWhatsApp,
    checkInterval: parseInt(checkInterval),
    autoCheckEnabled: autoCheckEnabled === 'on',
    smtpUser, smtpPass,
    telegramBotToken, telegramAdminChatId,
    logoUrl
  });
  startChecker();
  startTelegramPolling();
  req.session.successMsg = 'Pengaturan berhasil diperbarui dan sistem disinkronisasi.';
  res.redirect('/admin/settings');
});

// ===================== PUBLIC API / DOCS =====================
app.get('/docs', async (req, res) => {
  let userApiKey = '';
  if (req.session.userId) {
    const key = await ApiKey.findOne({ userId: req.session.userId });
    if (key) userApiKey = key.key;
  }
  res.render('docs', { userApiKey });
});

async function apiAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key || req.query.apikey;
  if (!apiKey) return res.status(401).json({ error: 'API key diperlukan' });
  const keyDoc = await ApiKey.findOne({ key: apiKey });
  if (!keyDoc) return res.status(401).json({ error: 'API key tidak valid' });
  req.apiUser = keyDoc.userId;
  next();
}

app.get('/api/v1/balance', apiAuth, async (req, res) => {
  const user = await User.findById(req.apiUser);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
  res.json({ balance: user.balance });
});

app.get('/api/v1/invoice', apiAuth, async (req, res) => {
  const settings = await getSettings();
  const amount = parseInt(req.query.amount);
  const userId = req.apiUser;
  if (!amount || isNaN(amount) || amount < settings.minDeposit) {
    return res.status(400).json({ error: `Nominal minimal Rp ${settings.minDeposit}` });
  }
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const lockedInvoices = await Invoice.find({
      $or: [{ status: 'pending' }, { status: 'paid', createdAt: { $gte: oneDayAgo } }]
    }).select('fee');
    const usedFees = lockedInvoices.map(i => Number(i.fee)).filter(f => !isNaN(f));
    const availableFees = [];
    for (let i = 1; i <= settings.maxFee; i++) {
      if (!usedFees.includes(i)) availableFees.push(i);
    }
    if (availableFees.length === 0) {
      return res.status(503).json({ error: 'Kode unik sedang penuh, silakan coba lagi beberapa menit.' });
    }
    const fee = availableFees[Math.floor(Math.random() * availableFees.length)];
    const total = amount + fee;
    const url = `https://${settings.apiDomain}/?action=createpayment&apikey=${settings.apiKey}&username=${settings.username}&amount=${total}&token=${settings.token}`;
    const resp = await axios.get(url);
    const data = resp.data;
    if (!data.status) throw new Error('Gagal membuat pembayaran');
    const expiredAt = new Date(Date.now() + 10 * 60 * 1000);
    const invoice = await createWithRetry(Invoice, {
      userId, amount, fee, total,
      trxid: data.result.trxid,
      qris_image: data.result.qris_image,
      expiredAt
    });
    await createWithRetry(Transaction, {
      userId, type: 'deposit', amount, fee,
      status: 'pending',
      reference: invoice._id.toString(),
      expiredAt
    });
    return res.json({
      success: true,
      invoice_id: invoice._id,
      amount: invoice.amount,
      fee: invoice.fee,
      total: invoice.total,
      qris_image: invoice.qris_image,
      expired_at: invoice.expiredAt
    });
  } catch (e) {
    console.error('API create invoice error:', e.response?.data || e.message);
    return res.status(500).json({ error: 'Gagal membuat invoice' });
  }
});

app.get('/api/v1/invoice/status', apiAuth, async (req, res) => {
  const invoiceId = req.query.id || req.query.invoice_id;
  if (!invoiceId) return res.status(400).json({ error: 'Invoice ID diperlukan' });
  const invoice = await Invoice.findById(invoiceId);
  if (!invoice || invoice.userId.toString() !== req.apiUser.toString()) {
    return res.status(404).json({ error: 'Invoice tidak ditemukan' });
  }
  res.json({
    invoice_id: invoice._id,
    amount: invoice.amount,
    fee: invoice.fee,
    total: invoice.total,
    status: invoice.status,
    qris_image: invoice.qris_image,
    expired_at: invoice.expiredAt,
    created_at: invoice.createdAt
  });
});

// ===================== AUTO MUTASI =====================
let checkerInterval;
async function checkMutasi() {
  try {
    const settings = await getSettings();
    if (!settings.autoCheckEnabled || !settings.apiKey) return;
    
    const pendingInvoices = await Invoice.find({ status: 'pending' });
    const now = new Date();
    
    for (const inv of pendingInvoices) {
      if (now > inv.expiredAt) {
        inv.status = 'expired';
        await inv.save();
        await Transaction.updateOne(
          { reference: inv._id.toString(), type: 'deposit', status: 'pending' },
          { status: 'expired' }
        );
      }
    }
    
    const mutasiUrl = `https://${settings.apiDomain}/?action=mutasiqr&apikey=${settings.apiKey}&username=${settings.username}&token=${settings.token}`;
    const resp = await axios.get(mutasiUrl);
    const data = resp.data;
    
    if (!data.status || !data.result || !data.result.success || !Array.isArray(data.result.results)) return;
    
    const results = data.result.results;
    const usedMutationIds = await Invoice.find({ mutationId: { $ne: null } }).distinct('mutationId');
    const availableMutations = results.filter(tx => tx.status === 'IN' && !usedMutationIds.includes(String(tx.id)));
    
    for (const inv of pendingInvoices) {
      if (inv.status !== 'pending') continue;
      
      const matchedMutation = availableMutations.find(tx => {
        // 1. Cek Nominal
        const nominal = parseInt(String(tx.kredit).replace(/\./g, ''));
        if (nominal !== inv.total) return false;
        
        // 2. PERBAIKAN: Ambil key tanggal dari API
        const rawDateString = tx.tanggal || tx.created_at || tx.createdAt || tx.date || tx.datetime;
        if (!rawDateString) return false;

        let mutationTime;
        
        // 3. PERBAIKAN: Parsing format DD/MM/YYYY HH:mm:ss menjadi valid format Date
        if (rawDateString.includes('/')) {
          const [datePart, timePart] = rawDateString.split(' ');
          const [day, month, year] = datePart.split('/');
          // Ubah ke format ISO (YYYY-MM-DDTHH:mm:ss+07:00) agar zona waktunya akurat ke WIB
          mutationTime = new Date(`${year}-${month}-${day}T${timePart}+07:00`);
        } else {
          mutationTime = new Date(rawDateString);
        }

        if (isNaN(mutationTime.getTime())) return false;
        
        // 4. Cek Jarak Waktu (Maksimal 30 menit)
        const diffMinutes = Math.abs(mutationTime.getTime() - inv.createdAt.getTime()) / 1000 / 60;
        return diffMinutes <= 30;
      });
      
      if (!matchedMutation) continue;
      
      // Jika lolos validasi, eksekusi proses update saldo
      inv.status = 'paid';
      inv.mutationId = String(matchedMutation.id);
      await inv.save();
      
      await User.findByIdAndUpdate(inv.userId, { $inc: { balance: inv.amount } });
      await Transaction.updateOne(
        { reference: inv._id.toString(), type: 'deposit', status: 'pending' },
        { status: 'paid' }
      );
      await Stats.updateOne({}, { $inc: { totalDepositAmount: inv.amount, totalDepositFee: inv.fee, totalTransactions: 1 } });
      
      const index = availableMutations.findIndex(tx => String(tx.id) === String(matchedMutation.id));
      if (index !== -1) availableMutations.splice(index, 1);
      
      const adminChatId = await getAdminChatId();
      if (adminChatId) {
        const user = await User.findById(inv.userId);
        if (user) {
          const timeString = new Date().toLocaleString('id-ID', {
            timeZone: 'Asia/Jakarta', day: '2-digit', month: 'long', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
          });
          const message = `🌐 *Notifikasi - ${settings.name}*\n\n👤 *Informasi User*\n• User: ${user.username} (${user.email})\n• Saldo Saat Ini: Rp ${user.balance.toLocaleString('id-ID')}\n\n💰 *Informasi Deposit*\n• Jumlah: Rp ${inv.amount.toLocaleString('id-ID')}\n• Fee: Rp ${inv.fee.toLocaleString('id-ID')}\n• Total: Rp ${inv.total.toLocaleString('id-ID')}\n• ID Invoice: ${inv._id}\n• Waktu: ${timeString}\n• Status: ✅ Paid`;
          await sendTelegramMessage(adminChatId, message);
        }
      }
    }
  } catch (err) {
    console.error('Mutasi error:', err.response?.data || err.message);
  }
}


async function updateStatsOnStartup() {
  const [depositAgg, withdrawAgg, totalUsers, totalTrx] = await Promise.all([
    Transaction.aggregate([{ $match: { type: 'deposit', status: 'paid' } }, { $group: { _id: null, totalAmount: { $sum: '$amount' }, totalFee: { $sum: '$fee' } } }]),
    Transaction.aggregate([{ $match: { type: 'withdraw', status: 'success' } }, { $group: { _id: null, totalAmount: { $sum: '$amount' }, totalFee: { $sum: '$fee' } } }]),
    User.countDocuments({ role: 'user' }),
    Transaction.countDocuments()
  ]);
  await Stats.deleteMany({});
  await Stats.create({
    totalDepositAmount: depositAgg[0]?.totalAmount || 0,
    totalDepositFee: depositAgg[0]?.totalFee || 0,
    totalWithdrawAmount: withdrawAgg[0]?.totalAmount || 0,
    totalWithdrawFee: withdrawAgg[0]?.totalFee || 0,
    totalUsers,
    totalTransactions: totalTrx
  });
}

function startChecker() {
  if (checkerInterval) clearInterval(checkerInterval);
  getSettings().then(s => {
    if (s.autoCheckEnabled) {
      checkerInterval = setInterval(checkMutasi, s.checkInterval * 1000);
      checkMutasi();
    }
  });
}

setTimeout(async () => {
  await updateStatsOnStartup();
  startChecker();
  startTelegramPolling();
}, 2000);

app.listen(PORT, () => console.log(`🚀 Server berjalan di http://localhost:${PORT}`));
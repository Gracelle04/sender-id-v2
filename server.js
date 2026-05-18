require('dotenv').config();
const express    = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto     = require('crypto');
const XLSX       = require('xlsx');

const app = express();
app.use(cors());
app.use(express.json());

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME     = process.env.DB_NAME     || 'sender_id_db';
const PORT        = process.env.PORT        || 3000;
const JWT_SECRET  = process.env.JWT_SECRET  || 'sender_id_jwt_secret_change_me';
const APP_URL     = process.env.APP_URL     || `http://localhost:${PORT}`;

// ─── CLOUDINARY ───────────────────────────────────────────────────────────────

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true
});

function uploadToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) reject(err); else resolve(result);
    });
    Readable.from(buffer).pipe(stream);
  });
}

async function deleteFromCloudinary(public_id) {
  try { await cloudinary.uploader.destroy(public_id, { resource_type: 'raw' }); }
  catch (e) { console.warn('Cloudinary delete warning:', e.message); }
}

// ─── MULTER ───────────────────────────────────────────────────────────────────

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ─── EMAIL ────────────────────────────────────────────────────────────────────

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

async function sendMail(to, subject, html) {
  if (!process.env.SMTP_USER) {
    console.log(`\n📧 [EMAIL SIMULÉ] À: ${to}\n   Sujet: ${subject}\n   ${html.replace(/<[^>]+>/g,'').trim().slice(0,200)}\n`);
    return;
  }
  await transporter.sendMail({ from: `"Suivi Sender ID" <${process.env.SMTP_USER}>`, to, subject, html });
}

function emailStyle() {
  return `font-family:'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #E5E7EB`;
}

async function sendOTPEmail(email, otp, nom) {
  const html = `<div style="${emailStyle()}">
    <div style="background:#0C447C;padding:28px 32px">
      <div style="color:#fff;font-size:20px;font-weight:700">Suivi Sender ID</div>
      <div style="color:#85B7EB;font-size:13px;margin-top:4px">Afrique Ouest &amp; Centrale</div>
    </div>
    <div style="padding:32px">
      <p style="color:#1C1C1A;font-size:15px;font-weight:600;margin-bottom:8px">Bonjour ${nom || ''} 👋</p>
      <p style="color:#6B6963;font-size:14px;margin-bottom:28px">Voici votre code de connexion. Il est valable <strong>10 minutes</strong>.</p>
      <div style="background:#F5F4F0;border-radius:12px;padding:28px;text-align:center;margin-bottom:28px;border:1.5px solid #D5D2C8">
        <div style="font-size:42px;font-weight:700;letter-spacing:12px;color:#0C447C;font-family:monospace">${otp}</div>
      </div>
      <p style="color:#9C9890;font-size:12px;text-align:center">Si vous n'avez pas demandé ce code, ignorez cet email.</p>
    </div>
  </div>`;
  await sendMail(email, 'Votre code de connexion — Suivi Sender ID', html);
}

async function sendInvitationEmail(email, nom, token, invitePar) {
  const link = `${APP_URL}/activate.html?token=${token}`;
  const html = `<div style="${emailStyle()}">
    <div style="background:#0C447C;padding:28px 32px">
      <div style="color:#fff;font-size:20px;font-weight:700">Suivi Sender ID</div>
      <div style="color:#85B7EB;font-size:13px;margin-top:4px">Afrique Ouest &amp; Centrale</div>
    </div>
    <div style="padding:32px">
      <p style="color:#1C1C1A;font-size:15px;font-weight:600;margin-bottom:8px">Bonjour ${nom} 👋</p>
      <p style="color:#6B6963;font-size:14px;margin-bottom:8px"><strong>${invitePar}</strong> vous a invité(e) à rejoindre l'application <strong>Suivi Sender ID</strong>.</p>
      <p style="color:#6B6963;font-size:14px;margin-bottom:28px">Cliquez sur le bouton ci-dessous pour activer votre compte et définir votre mot de passe. Ce lien est valable <strong>48 heures</strong>.</p>
      <div style="text-align:center;margin-bottom:28px">
        <a href="${link}" style="display:inline-block;background:#0C447C;color:#fff;font-size:15px;font-weight:600;padding:14px 32px;border-radius:8px;text-decoration:none">Activer mon compte →</a>
      </div>
      <p style="color:#9C9890;font-size:12px;text-align:center">Ou copiez ce lien : <a href="${link}" style="color:#378ADD">${link}</a></p>
      <p style="color:#9C9890;font-size:12px;text-align:center;margin-top:12px">Si vous n'attendiez pas cette invitation, ignorez cet email.</p>
    </div>
  </div>`;
  await sendMail(email, `Invitation — Suivi Sender ID`, html);
}

// ─── DB ───────────────────────────────────────────────────────────────────────

let db;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log(`✅ MongoDB connecté — ${DB_NAME}`);
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('otps').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  await db.collection('invitations').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  await db.collection('invitations').createIndex({ token: 1 }, { unique: true });
  await db.collection('activity_logs').createIndex({ timestamp: -1 });
  await db.collection('activity_logs').createIndex({ user_email: 1 });
  await db.collection('agregateurs').createIndex({ nom: 1 });

  // Compte admin par défaut
  const adminExists = await db.collection('users').findOne({ role: 'admin' });
  if (!adminExists) {
    const hash = await bcrypt.hash('Admin1234!', 10);
    await db.collection('users').insertOne({
      email: 'admin@senderid.local', password: hash,
      nom: 'Administrateur', role: 'admin', actif: true, created_at: new Date()
    });
    console.log('👤 Admin créé — admin@senderid.local / Admin1234!');
    console.log('   ⚠️  Changez ce mot de passe dès la première connexion !');
  }
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────

function authRequired(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'Non authentifié' });
  try {
    req.user = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Session expirée, reconnectez-vous' }); }
}

function adminRequired(req, res, next) {
  authRequired(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès admin requis' });
    next();
  });
}

function writeRequired(req, res, next) {
  authRequired(req, res, () => {
    if (req.user.role === 'viewer') return res.status(403).json({ error: 'Accès en lecture seule' });
    next();
  });
}

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────

// Étape 1 — Email + mot de passe → envoie OTP
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
    const user = await db.collection('users').findOne({ email: email.toLowerCase().trim() });
    if (!user || !user.actif) return res.status(401).json({ error: 'Identifiants incorrects' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Identifiants incorrects' });

    // Générer OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    await db.collection('otps').deleteMany({ email: user.email });
    await db.collection('otps').insertOne({
      email: user.email,
      otp: await bcrypt.hash(otp, 6),
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
      created_at: new Date()
    });
    await sendOTPEmail(user.email, otp, user.nom);
    res.json({ success: true, email: user.email });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Étape 2 — Vérifier OTP → JWT
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    const record = await db.collection('otps').findOne({ email: email?.toLowerCase().trim() });
    if (!record || new Date() > record.expires_at) {
      await db.collection('otps').deleteOne({ email: email?.toLowerCase().trim() });
      return res.status(401).json({ error: 'Code expiré ou invalide, recommencez' });
    }
    const ok = await bcrypt.compare(otp, record.otp);
    if (!ok) return res.status(401).json({ error: 'Code incorrect' });
    await db.collection('otps').deleteOne({ _id: record._id });

    const user = await db.collection('users').findOne({ email: email.toLowerCase().trim() });
    const token = jwt.sign(
      { id: user._id.toString(), email: user.email, nom: user.nom, role: user.role },
      JWT_SECRET, { expiresIn: '8h' }
    );
    await logActivity(user, 'login');
    res.json({ success: true, token, user: { email: user.email, nom: user.nom, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Infos utilisateur connecté
app.get('/api/auth/me', authRequired, (req, res) => res.json({ user: req.user }));

// Changer son mot de passe
app.put('/api/auth/password', authRequired, async (req, res) => {
  try {
    const { current, nouveau } = req.body;
    const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) });
    if (!await bcrypt.compare(current, user.password)) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    if (!nouveau || nouveau.length < 8) return res.status(400).json({ error: 'Minimum 8 caractères' });
    await db.collection('users').updateOne({ _id: user._id }, { $set: { password: await bcrypt.hash(nouveau, 10) } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ACTIVATION (lien email) ──────────────────────────────────────────────────

// Vérifier le token d'invitation
app.get('/api/auth/invitation/:token', async (req, res) => {
  try {
    const inv = await db.collection('invitations').findOne({ token: req.params.token });
    if (!inv || new Date() > inv.expires_at) return res.status(404).json({ error: 'Lien invalide ou expiré' });
    res.json({ email: inv.email, nom: inv.nom });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Activer le compte (définir mot de passe)
app.post('/api/auth/activate', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Minimum 8 caractères' });
    const inv = await db.collection('invitations').findOne({ token });
    if (!inv || new Date() > inv.expires_at) return res.status(404).json({ error: 'Lien invalide ou expiré' });

    const hash = await bcrypt.hash(password, 10);
    await db.collection('users').updateOne(
      { email: inv.email },
      { $set: { password: hash, actif: true } }
    );
    await db.collection('invitations').deleteOne({ token });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ADMIN — GESTION UTILISATEURS ────────────────────────────────────────────

app.get('/api/admin/users', adminRequired, async (req, res) => {
  try {
    const users = await db.collection('users')
      .find({}, { projection: { password: 0 } })
      .sort({ created_at: -1 }).toArray();
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Inviter un nouvel utilisateur par email
app.post('/api/admin/invite', adminRequired, async (req, res) => {
  try {
    const { email, nom, role } = req.body;
    if (!email || !nom) return res.status(400).json({ error: 'Email et nom requis' });

    const emailLower = email.toLowerCase().trim();
    const existing = await db.collection('users').findOne({ email: emailLower });
    if (existing) return res.status(409).json({ error: 'Cet email est déjà utilisé' });

    // Créer compte inactif
    await db.collection('users').insertOne({
      email: emailLower, password: '', nom: nom.trim(),
      role: role || 'user', actif: false, created_at: new Date()
    });

    // Créer token d'invitation (48h)
    const token = crypto.randomBytes(32).toString('hex');
    await db.collection('invitations').deleteMany({ email: emailLower });
    await db.collection('invitations').insertOne({
      email: emailLower, nom: nom.trim(), token,
      expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000),
      created_at: new Date()
    });

    await sendInvitationEmail(emailLower, nom.trim(), token, req.user.nom);
    res.json({ success: true });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Cet email existe déjà' });
    res.status(500).json({ error: e.message });
  }
});

// Renvoyer une invitation
app.post('/api/admin/invite/:id/resend', adminRequired, async (req, res) => {
  try {
    const user = await db.collection('users').findOne({ _id: new ObjectId(req.params.id) });
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const token = crypto.randomBytes(32).toString('hex');
    await db.collection('invitations').deleteMany({ email: user.email });
    await db.collection('invitations').insertOne({
      email: user.email, nom: user.nom, token,
      expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000),
      created_at: new Date()
    });
    await sendInvitationEmail(user.email, user.nom, token, req.user.nom);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Modifier un utilisateur
app.put('/api/admin/users/:id', adminRequired, async (req, res) => {
  try {
    const { nom, role, actif } = req.body;
    const update = {};
    if (nom  !== undefined) update.nom  = nom;
    if (role !== undefined) update.role = role;
    if (actif !== undefined) update.actif = actif;
    await db.collection('users').updateOne({ _id: new ObjectId(req.params.id) }, { $set: update });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Supprimer un utilisateur
app.delete('/api/admin/users/:id', adminRequired, async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Impossible de supprimer votre propre compte' });
    await db.collection('users').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PROTECTION /api/* ────────────────────────────────────────────────────────

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth')) return next();
  if (req.path.startsWith('/admin')) return next();
  authRequired(req, res, next);
});

// ─── PAYS ─────────────────────────────────────────────────────────────────────

app.get('/api/pays', async (req, res) => {
  try {
    const pays = await db.collection('pays')
      .find({}, { projection: { nom: 1, countryCode: 1, indicatif: 1, prereqs: 1 } })
      .sort({ nom: 1 }).toArray();
    res.json(pays);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/pays/:id/prereqs', writeRequired, async (req, res) => {
  try {
    await db.collection('pays').updateOne(
      { _id: new ObjectId(req.params.id) }, { $set: { prereqs: req.body } }
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── OPÉRATEURS ───────────────────────────────────────────────────────────────

app.get('/api/operateurs', async (req, res) => {
  try {
    const query = req.query.pays_id ? { pays_id: new ObjectId(req.query.pays_id) } : {};
    const ops = await db.collection('operateurs')
      .find(query, { projection: { nom: 1, mcc: 1, mnc: 1, pays_id: 1, description: 1 } })
      .sort({ nom: 1 }).toArray();
    res.json(ops);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AGRÉGATEURS ──────────────────────────────────────────────────────────────
// Schéma existant : { nom, type_sms, statut, pays_couverts:[{pays:string, operateurs:[]}], notes }

function normStr(s) {
  return (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();
}

app.get('/api/agregateurs', async (req, res) => {
  try {
    let agr = await db.collection('agregateurs')
      .find({}, { projection: { nom: 1, pays_couverts: 1, type_sms: 1, statut: 1, notes: 1 } })
      .sort({ nom: 1 }).toArray();

    // Filtre optionnel par pays
    if (req.query.pays_id) {
      const p = await db.collection('pays').findOne({ _id: new ObjectId(req.query.pays_id) });
      if (p) {
        const nom = normStr(p.nom);
        agr = agr.filter(a => (a.pays_couverts||[]).some(pc => normStr(pc.pays) === nom));
      }
    } else if (req.query.pays) {
      const nom = normStr(req.query.pays);
      agr = agr.filter(a => (a.pays_couverts||[]).some(pc => normStr(pc.pays) === nom));
    }

    res.json(agr);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agregateurs', adminRequired, async (req, res) => {
  try {
    const { nom, pays_noms, type_sms, notes } = req.body;
    if (!nom) return res.status(400).json({ error: 'Nom requis' });
    const doc = {
      nom,
      type_sms: type_sms || 'Local',
      type_fournisseur: 'Agrégateur',
      statut: 'actif',
      pays_couverts: (pays_noms || []).map(p => ({ pays: p, operateurs: [] })),
      notes: notes || '',
      created_at: new Date()
    };
    const result = await db.collection('agregateurs').insertOne(doc);
    res.json({ success: true, id: result.insertedId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/agregateurs/:id', adminRequired, async (req, res) => {
  try {
    const { nom, pays_noms, type_sms, notes } = req.body;
    const update = {};
    if (nom       !== undefined) update.nom           = nom;
    if (type_sms  !== undefined) update.type_sms      = type_sms;
    if (notes     !== undefined) update.notes         = notes;
    if (pays_noms !== undefined) update.pays_couverts = pays_noms.map(p => ({ pays: p, operateurs: [] }));
    await db.collection('agregateurs').updateOne({ _id: new ObjectId(req.params.id) }, { $set: update });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/agregateurs/:id', adminRequired, async (req, res) => {
  try {
    await db.collection('agregateurs').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SENDER IDS ───────────────────────────────────────────────────────────────

app.get('/api/sender-ids', async (req, res) => {
  try {
    const { search, statut, pays_id } = req.query;
    const query = {};
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query['$or'] = [{ nom_client: { $regex: escaped, $options: 'i' } }, { sender_id: { $regex: escaped, $options: 'i' } }];
    }
    if (statut)  query['operateurs.statut'] = statut;
    if (pays_id) query['pays_id'] = new ObjectId(pays_id);
    const data = await db.collection('sender_ids').find(query).sort({ created_at: -1 }).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sender-ids', writeRequired, async (req, res) => {
  try {
    const doc = {
      ...req.body, pays_id: new ObjectId(req.body.pays_id),
      agregateur_id: req.body.agregateur_id ? new ObjectId(req.body.agregateur_id) : null,
      notifie: false, date_notification: null,
      created_at: new Date(), updated_at: new Date(),
      operateurs: (req.body.operateurs || []).map(op => ({
        ...op, operateur_id: op.operateur_id ? new ObjectId(op.operateur_id) : null,
        agregateur_id: op.agregateur_id ? new ObjectId(op.agregateur_id) : null,
        canal: op.canal || 'Direct',
        date_approbation: op.date_approbation ? new Date(op.date_approbation) : null
      }))
    };
    const result = await db.collection('sender_ids').insertOne(doc);
    res.json({ success: true, id: result.insertedId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/sender-ids/:id', writeRequired, async (req, res) => {
  try {
    const update = {
      nom_client: req.body.nom_client, sender_id: req.body.sender_id,
      numero_ticket: req.body.numero_ticket, url_ticket: req.body.url_ticket,
      commentaires: req.body.commentaires,
      date_demande: req.body.date_demande || null,
      date_soumission: req.body.date_soumission || null,
      agregateur_id: req.body.agregateur_id ? new ObjectId(req.body.agregateur_id) : null,
      updated_at: new Date()
    };
    if (req.body.operateurs) {
      update.operateurs = req.body.operateurs.map(op => ({
        ...op, operateur_id: op.operateur_id ? new ObjectId(op.operateur_id) : null,
        agregateur_id: op.agregateur_id ? new ObjectId(op.agregateur_id) : null,
        canal: op.canal || 'Direct',
        date_approbation: op.date_approbation ? new Date(op.date_approbation) : null
      }));
    }
    await db.collection('sender_ids').updateOne({ _id: new ObjectId(req.params.id) }, { $set: update });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/sender-ids/:id/operateur-statut', writeRequired, async (req, res) => {
  try {
    const { operateur_id, statut, date_approbation } = req.body;
    if (!operateur_id) return res.status(400).json({ error: 'operateur_id requis' });
    await db.collection('sender_ids').updateOne(
      { _id: new ObjectId(req.params.id), 'operateurs.operateur_id': new ObjectId(operateur_id) },
      { $set: {
        'operateurs.$.statut': statut,
        'operateurs.$.date_approbation': date_approbation ? new Date(date_approbation) : null,
        updated_at: new Date()
      }}
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/sender-ids/:id/notifier', writeRequired, async (req, res) => {
  try {
    await db.collection('sender_ids').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { notifie: true, date_notification: new Date(), updated_at: new Date() } }
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sender-ids/:id', writeRequired, async (req, res) => {
  try {
    await db.collection('sender_ids').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── STATS ────────────────────────────────────────────────────────────────────

app.get('/api/stats', async (req, res) => {
  try {
    const all = await db.collection('sender_ids').find({}).toArray();
    const APPROVED = ['Approuvé','Approuvé Offnet','Approuvé Partiel'];
    const PENDING  = ['Collecte interne','En cours de traitement',"En attente d'info"];
    const fullyApproved = all.filter(e => e.operateurs?.length > 0 && e.operateurs.every(o => APPROVED.includes(o.statut)));
    const statuts = {}; let pendingOps = 0;
    all.forEach(e => (e.operateurs||[]).forEach(o => {
      statuts[o.statut] = (statuts[o.statut]||0) + 1;
      if (PENDING.includes(o.statut)) pendingOps++;
    }));
    res.json({
      total: all.length, fullyApproved: fullyApproved.length,
      toNotify: fullyApproved.filter(e => !e.notifie).length,
      notified: fullyApproved.filter(e => e.notifie).length,
      pendingOps, statuts
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DOCUMENTS ────────────────────────────────────────────────────────────────

app.get('/api/documents', async (req, res) => {
  try {
    const query = {};
    if (req.query.nom_client) query.nom_client = req.query.nom_client;
    if (req.query.type)       query.type = req.query.type;
    res.json(await db.collection('documents').find(query).sort({ created_at: -1 }).toArray());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/documents', writeRequired, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
    const baseName = req.file.originalname.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const result = await uploadToCloudinary(req.file.buffer, {
      folder: 'sender-id/documents', public_id: `${baseName}_${Date.now()}`, resource_type: 'raw'
    });
    const doc = {
      nom_original: req.body.nom_original || req.file.originalname,
      cloudinary_id: result.public_id, chemin: result.secure_url,
      type: req.body.type || 'Autre', nom_client: req.body.nom_client || '',
      taille: req.file.size, mimetype: req.file.mimetype,
      commentaire: req.body.commentaire || '', created_at: new Date()
    };
    const inserted = await db.collection('documents').insertOne(doc);
    res.json({ success: true, id: inserted.insertedId, doc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/documents/:id', writeRequired, async (req, res) => {
  try {
    const doc = await db.collection('documents').findOne({ _id: new ObjectId(req.params.id) });
    if (doc) {
      if (doc.cloudinary_id) await deleteFromCloudinary(doc.cloudinary_id);
      await db.collection('documents').deleteOne({ _id: new ObjectId(req.params.id) });
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── MODÈLES ──────────────────────────────────────────────────────────────────

app.get('/api/modeles', async (req, res) => {
  try { res.json(await db.collection('modeles').find({}).sort({ created_at: -1 }).toArray()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/modeles', writeRequired, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
    const baseNameM = req.file.originalname.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const result = await uploadToCloudinary(req.file.buffer, {
      folder: 'sender-id/modeles', public_id: `${baseNameM}_${Date.now()}`, resource_type: 'raw'
    });
    const modele = {
      nom: req.body.nom || req.file.originalname, cloudinary_id: result.public_id,
      chemin: result.secure_url, description: req.body.description || '',
      version: req.body.version || 'v1.0', pays: req.body.pays || '',
      taille: req.file.size, mimetype: req.file.mimetype,
      created_at: new Date(), updated_at: new Date()
    };
    const inserted = await db.collection('modeles').insertOne(modele);
    res.json({ success: true, id: inserted.insertedId, modele });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/modeles/:id', writeRequired, async (req, res) => {
  try {
    const m = await db.collection('modeles').findOne({ _id: new ObjectId(req.params.id) });
    if (m) {
      if (m.cloudinary_id) await deleteFromCloudinary(m.cloudinary_id);
      await db.collection('modeles').deleteOne({ _id: new ObjectId(req.params.id) });
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── BULK IMPORT / EXPORT ─────────────────────────────────────────────────────

const BULK_COLS = ['nom_client','sender_id','pays','date_demande','date_soumission','numero_ticket','ticket_url','commentaire'];
const BULK_HEADERS = ['Client *','Sender ID *','Pays *','Date demande (JJ/MM/AAAA)','Date soumission (JJ/MM/AAAA)','N° Ticket','URL Ticket','Commentaire'];

// Télécharger le template Excel (pas d'auth — fichier vide sans données sensibles)
app.get('/api/sender-ids/bulk/template', (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    BULK_HEADERS,
    ['LAfricaMobile','LAFRICAMOB','Sénégal','01/01/2025','15/01/2025','TKT-0001','https://desk.zoho.com/...','Exemple'],
  ]);
  ws['!cols'] = BULK_HEADERS.map((h,i) => ({ wch: [22,18,16,22,22,14,30,30][i] }));
  XLSX.utils.book_append_sheet(wb, ws, 'Sender IDs');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="template_sender_ids.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Parser une date JJ/MM/AAAA ou ISO
function parseDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  const fr = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (fr) return new Date(`${fr[3]}-${fr[2].padStart(2,'0')}-${fr[1].padStart(2,'0')}`);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

// Upload et preview (parse sans insérer)
app.post('/api/sender-ids/bulk/preview', authRequired, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    if (rows.length < 2) return res.status(400).json({ error: 'Fichier vide ou sans données' });

    const pays_list = await db.collection('pays').find({}).toArray();
    const normPays = (n) => (n||'').toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g,'');
    const results = [];

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const client = String(r[0]||'').trim();
      const sid    = String(r[1]||'').trim();
      const pays   = String(r[2]||'').trim();
      if (!client && !sid && !pays) continue; // ligne vide

      const errors = [];
      if (!client) errors.push('Client manquant');
      if (!sid)    errors.push('Sender ID manquant');
      if (!pays)   errors.push('Pays manquant');

      const matchedPays = pays_list.find(p => normPays(p.nom) === normPays(pays));
      if (pays && !matchedPays) errors.push(`Pays introuvable: "${pays}"`);

      results.push({
        row: i + 1,
        nom_client:      client,
        sender_id:       sid,
        pays:            pays,
        pays_id:         matchedPays ? matchedPays._id : null,
        pays_matched:    matchedPays ? matchedPays.nom : null,
        date_demande:    parseDate(r[3]),
        date_soumission: parseDate(r[4]),
        numero_ticket:   String(r[5]||'').trim(),
        ticket_url:      String(r[6]||'').trim(),
        commentaire:     String(r[7]||'').trim(),
        errors,
        valid: errors.length === 0,
      });
    }
    res.json({ total: results.length, valid: results.filter(r=>r.valid).length, rows: results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Confirmer l'import (insérer les lignes valides)
app.post('/api/sender-ids/bulk/import', writeRequired, async (req, res) => {
  try {
    const { rows } = req.body;
    if (!rows?.length) return res.status(400).json({ error: 'Aucune donnée' });
    const valid = rows.filter(r => r.valid);
    if (!valid.length) return res.status(400).json({ error: 'Aucune ligne valide' });
    const docs = valid.map(r => ({
      nom_client:      r.nom_client,
      sender_id:       r.sender_id,
      pays_id:         r.pays_id,
      date_demande:    r.date_demande ? new Date(r.date_demande) : null,
      date_soumission: r.date_soumission ? new Date(r.date_soumission) : null,
      numero_ticket:   r.numero_ticket || null,
      ticket_url:      r.ticket_url || null,
      commentaire:     r.commentaire || null,
      operateurs:      [],
      notifie:         false,
      created_at:      new Date(),
      created_by:      req.user.email,
    }));
    const result = await db.collection('sender_ids').insertMany(docs);
    res.json({ inserted: result.insertedCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── ACTIVITY LOGS ────────────────────────────────────────────────────────────

async function logActivity(user, action, meta = {}) {
  try {
    await db.collection('activity_logs').insertOne({
      user_id:    user.id || user._id?.toString(),
      user_email: user.email,
      user_nom:   user.nom,
      user_role:  user.role,
      action,
      ...meta,
      timestamp: new Date()
    });
  } catch {}
}

// Enregistrer une action (page vue, logout)
app.post('/api/activity/log', authRequired, async (req, res) => {
  const { action, page, duration_ms } = req.body;
  await logActivity(req.user, action, { page, duration_ms });
  res.json({ success: true });
});

// Récupérer les logs (admin uniquement)
app.get('/api/admin/activity', adminRequired, async (req, res) => {
  try {
    const { user_email, date_from, date_to, limit = 200 } = req.query;
    const filter = {};
    if (user_email) filter.user_email = user_email;
    if (date_from || date_to) {
      filter.timestamp = {};
      if (date_from) filter.timestamp.$gte = new Date(date_from);
      if (date_to)   filter.timestamp.$lte = new Date(new Date(date_to).getTime() + 86399999);
    }
    const logs = await db.collection('activity_logs')
      .find(filter).sort({ timestamp: -1 }).limit(parseInt(limit)).toArray();
    const users = await db.collection('users').find({}, { projection: { email: 1, nom: 1 } }).toArray();
    res.json({ logs, users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── STATIC ───────────────────────────────────────────────────────────────────

app.use(express.static('public'));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

connectDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
}).catch(err => { console.error('❌ MongoDB:', err); process.exit(1); });

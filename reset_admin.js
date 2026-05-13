require('dotenv').config();
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

(async () => {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.DB_NAME);

  const hash = await bcrypt.hash('Admin1234!', 10);
  const result = await db.collection('users').updateOne(
    { role: 'admin' },
    { $set: { password: hash, actif: true, email: 'admin@senderid.local' } },
    { upsert: false }
  );

  if (result.matchedCount === 0) {
    await db.collection('users').insertOne({
      email: 'admin@senderid.local', password: hash,
      nom: 'Administrateur', role: 'admin', actif: true, created_at: new Date()
    });
    console.log('✅ Admin créé: admin@senderid.local / Admin1234!');
  } else {
    console.log('✅ Mot de passe admin réinitialisé: admin@senderid.local / Admin1234!');
  }

  await client.close();
})().catch(e => { console.error('❌', e.message); process.exit(1); });

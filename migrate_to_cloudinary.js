/**
 * Script de migration — Fichiers locaux → Cloudinary
 * 
 * Usage : node migrate_to_cloudinary.js
 * 
 * Ce script :
 *  1. Lit tous les documents/modèles en base qui ont encore un chemin local (/uploads/...)
 *  2. Upload chaque fichier vers Cloudinary
 *  3. Met à jour le document MongoDB avec la nouvelle URL Cloudinary
 *  4. (Optionnel) Supprime le fichier local après migration réussie
 */

require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const cloudinary = require('cloudinary').v2;
const fs   = require('fs');
const path = require('path');
const { Readable } = require('stream');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true
});

const MONGODB_URI    = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME        = process.env.DB_NAME     || 'sender_id_db';
const UPLOADS_DIR    = path.join(__dirname, 'uploads');
const DELETE_LOCAL   = process.argv.includes('--delete-local'); // Pass flag to delete local files

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function uploadToCloudinary(filePath, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
    fs.createReadStream(filePath).pipe(stream);
  });
}

function isLocalPath(chemin) {
  return chemin && chemin.startsWith('/uploads/');
}

// ─── MIGRATION ────────────────────────────────────────────────────────────────

async function migrateCollection(db, collectionName, folder) {
  const collection = db.collection(collectionName);
  const docs = await collection.find({}).toArray();

  let migrated = 0, skipped = 0, errors = 0;

  for (const doc of docs) {
    // Skip already migrated (has cloudinary URL)
    if (!isLocalPath(doc.chemin)) {
      skipped++;
      continue;
    }

    // Build local file path
    const filename = doc.nom_fichier || path.basename(doc.chemin);
    const localPath = path.join(UPLOADS_DIR, folder, filename);

    if (!fs.existsSync(localPath)) {
      console.warn(`  ⚠️  Fichier introuvable localement : ${localPath}`);
      errors++;
      continue;
    }

    try {
      const publicId = `sender-id/${folder}/${path.parse(filename).name}`;
      const result = await uploadToCloudinary(localPath, {
        folder:        `sender-id/${folder}`,
        public_id:     publicId,
        resource_type: 'raw',
        use_filename:  false
      });

      // Update MongoDB
      await collection.updateOne(
        { _id: doc._id },
        { $set: {
          chemin:        result.secure_url,
          cloudinary_id: result.public_id
        }}
      );

      console.log(`  ✅ ${doc.nom_original || filename} → ${result.secure_url}`);
      migrated++;

      // Optionally delete local file
      if (DELETE_LOCAL) {
        fs.unlinkSync(localPath);
        console.log(`     🗑️  Fichier local supprimé`);
      }

    } catch (e) {
      console.error(`  ❌ Erreur pour ${filename}: ${e.message}`);
      errors++;
    }
  }

  return { migrated, skipped, errors, total: docs.length };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log('  Migration Cloudinary — Suivi Sender ID');
  console.log('══════════════════════════════════════════════');
  console.log(`  MongoDB  : ${DB_NAME}`);
  console.log(`  Cloud    : ${process.env.CLOUDINARY_CLOUD_NAME}`);
  console.log(`  Suppr.   : ${DELETE_LOCAL ? 'OUI (--delete-local)' : 'NON'}`);
  console.log('──────────────────────────────────────────────');
  console.log('');

  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    console.error('❌ CLOUDINARY_CLOUD_NAME manquant dans .env');
    process.exit(1);
  }

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  console.log('✅ MongoDB connecté\n');

  // ── Documents clients ──
  console.log('📄 Migration : documents clients');
  const docsResult = await migrateCollection(db, 'documents', 'documents');
  console.log(`   → ${docsResult.migrated} migrés, ${docsResult.skipped} déjà OK, ${docsResult.errors} erreurs\n`);

  // ── Modèles ──
  console.log('📋 Migration : modèles de documents');
  const modelesResult = await migrateCollection(db, 'modeles', 'modeles');
  console.log(`   → ${modelesResult.migrated} migrés, ${modelesResult.skipped} déjà OK, ${modelesResult.errors} erreurs\n`);

  // ── Résumé ──
  const totalMigrated = docsResult.migrated + modelesResult.migrated;
  const totalErrors   = docsResult.errors   + modelesResult.errors;

  console.log('══════════════════════════════════════════════');
  console.log(`  ✅ Total migré  : ${totalMigrated} fichiers`);
  console.log(`  ⚠️  Erreurs      : ${totalErrors}`);
  if (!DELETE_LOCAL && totalMigrated > 0) {
    console.log('');
    console.log('  💡 Les fichiers locaux sont conservés.');
    console.log('     Relancez avec --delete-local pour les supprimer');
    console.log('     une fois que vous avez vérifié les URLs Cloudinary.');
  }
  console.log('══════════════════════════════════════════════\n');

  await client.close();
  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Erreur fatale:', err);
  process.exit(1);
});

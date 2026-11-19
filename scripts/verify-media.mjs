import { DatabaseSync } from 'node:sqlite';
import { readConfig } from '../server/core.mjs';
import { verifyMedia } from '../server/media-maintenance.mjs';
const db = new DatabaseSync(process.argv[2] || readConfig().dbPath, { readOnly: true });
try { console.log(JSON.stringify(verifyMedia(db))); } finally { db.close(); }

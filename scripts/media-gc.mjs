import {openDatabase,readConfig} from '../server/core.mjs';
import {collectStaged} from '../server/media-gc.mjs';
const db=openDatabase(readConfig().dbPath);try{console.log(JSON.stringify(collectStaged(db,{days:Number(process.env.STAGED_RETENTION_DAYS)||7,apply:process.argv.includes('--apply')})));}finally{db.close();}

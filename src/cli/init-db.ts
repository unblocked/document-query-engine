import { ensureIndexes, closeDb, getDb } from "../db.js";
import { config } from "../config.js";

/** Connects to MongoDB and creates the engine's indexes. Reports which instance it hit. */
async function main(): Promise<void> {
  console.log(`Connecting to ${config.mongoUri} (db: ${config.mongoDb})…`);
  const db = await getDb();
  await ensureIndexes();
  console.log(`Connected. Initialized database "${db.databaseName}" with indexes.`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

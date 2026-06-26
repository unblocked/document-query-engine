import { MongoClient, type Db, type Collection, type Document } from "mongodb";
import { config } from "./config.js";
import { COLLECTIONS, type CollectionName } from "./models/index.js";
import { USERS_COLLECTION, type UserDoc } from "./models/user.js";

let client: MongoClient | undefined;

/** Connects (lazily, once) and returns the workshop database handle. */
export async function getDb(): Promise<Db> {
  if (!client) {
    client = new MongoClient(config.mongoUri);
    await client.connect();
  }
  return client.db(config.mongoDb);
}

/** Typed collection accessor keyed by the COLLECTIONS map. */
export async function getCollection<T extends Document = Document>(
  name: CollectionName,
): Promise<Collection<T>> {
  const db = await getDb();
  return db.collection<T>(name);
}

/** The user-resolution directory ({login, name}) — used to map names to logins, not NL-queried. */
export async function getUsersCollection(): Promise<Collection<UserDoc>> {
  const db = await getDb();
  return db.collection<UserDoc>(USERS_COLLECTION);
}

/** Closes the shared client. Call at the end of a CLI run. */
export async function closeDb(): Promise<void> {
  await client?.close();
  client = undefined;
}

/**
 * Creates the indexes the query engine relies on. The same fields are surfaced
 * to the LLM as schema hints, so indexed fields and prompt hints stay aligned.
 */
export async function ensureIndexes(): Promise<void> {
  const prs = await getCollection("pull_requests");
  await prs.createIndex({ repo: 1, number: 1 }, { unique: true });
  await prs.createIndex({ "user.login": 1 });
  await prs.createIndex({ state: 1 });
  await prs.createIndex({ merged_at: -1 });
  await prs.createIndex({ created_at: -1 });

  const issues = await getCollection("issues");
  await issues.createIndex({ repo: 1, number: 1 }, { unique: true });
  await issues.createIndex({ "user.login": 1 });
  await issues.createIndex({ state: 1 });
  await issues.createIndex({ created_at: -1 });

  const users = await getUsersCollection();
  await users.createIndex({ login: 1 }, { unique: true });
}

export { COLLECTIONS };

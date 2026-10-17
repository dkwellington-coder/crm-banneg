import "./env";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import pg from "pg";

// Connection settings Prisma's own engine read from the URL; node-postgres does not know them.
const PRISMA_ONLY = ["schema", "pgbouncer", "connection_limit", "pool_timeout", "connect_timeout", "socket_timeout", "statement_cache_size"];
// TLS is set below, so a sslmode in the URL does not turn on certificate checks the Supabase pooler cannot pass
const TLS_PARAMS = ["sslmode", "sslcert", "sslkey", "sslrootcert", "sslaccept", "uselibpqcompat"];

/**
 * Prisma talks to the database through node-postgres. Through the Supabase pooler each query is now
 * one round trip: Prisma's own connection wrapped every query in BEGIN / DEALLOCATE ALL / COMMIT.
 */
export function createPrismaClient(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL não definida.");
  const parsed = new URL(url);
  const schema = parsed.searchParams.get("schema") ?? undefined;
  for (const key of [...PRISMA_ONLY, ...TLS_PARAMS]) parsed.searchParams.delete(key);
  // Local databases (tests, a socket folder in ?host=) have no TLS
  const socketDir = parsed.searchParams.get("host")?.startsWith("/");
  const local = socketDir || ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  const pool = new pg.Pool({
    connectionString: parsed.toString(),
    max: 5,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
    ssl: local ? false : { rejectUnauthorized: false },
    // Raw SQL names tables without the schema. In production the database role (crm_app) already
    // defaults to it, and the Supabase pooler does not take startup options.
    ...(local && schema && { options: `-c search_path=${schema}` }),
  });
  const adapter = new PrismaPg(pool, {
    schema,
    disposeExternalPool: true,
    onPoolError: (err) => console.error("Conexão com o banco caiu (será refeita):", err.message),
  });
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function client() {
  if (globalForPrisma.prisma) return globalForPrisma.prisma;
  const created = createPrismaClient();
  // Production keeps one per instance too; outside it, hot reload reuses the same pool
  globalForPrisma.prisma = created;
  return created;
}

/** Opens the pool on first use, so DATABASE_URL is read when the first query runs (tests set it after importing). */
export const db = new Proxy({} as PrismaClient, {
  get(_, prop) {
    const c = client();
    const value = Reflect.get(c, prop, c);
    return typeof value === "function" ? value.bind(c) : value;
  },
});

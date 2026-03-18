/**
 * @file Database connection setup using Supabase PostgreSQL via postgres.js + Drizzle ORM.
 *
 * Usage:
 *   import { db } from './db';
 *   const rows = await db.select().from(channels);
 */

import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

export const client = postgres(DATABASE_URL);

export const db = drizzle(client, { schema });

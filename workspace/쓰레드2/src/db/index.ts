/**
 * @file Database connection setup using PGlite (local dev) or PostgreSQL (production).
 *
 * Usage:
 *   import { db } from './db';
 *   const rows = await db.select().from(channels);
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from './schema.js';

const DATA_DIR = process.env.DATABASE_URL || './data/pglite';

const client = new PGlite(DATA_DIR);

export const db = drizzle(client, { schema });

export { client };

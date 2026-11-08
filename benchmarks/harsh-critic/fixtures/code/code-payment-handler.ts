/**
 * Payment Handler Module
 *
 * Handles payment processing for subscription and one-time purchases.
 * Integrates with our external payment gateway (Stripe-compatible API).
 *
 * Usage:
 *   const result = await processPayment({ userId, amount, currency, paymentMethodId });
 */

import axios from 'axios';
import { db } from '../db';
import { logger } from '../logger';
import { PaymentRecord, PaymentStatus } from '../types/payment';

const GATEWAY_BASE_URL = process.env.PAYMENT_GATEWAY_URL!;
const GATEWAY_API_KEY = process.env.PAYMENT_GATEWAY_KEY!;

export interface PaymentRequest {
  userId: string;
  amount: number;          // in dollars (e.g. 9.99)
  currency: string;        // ISO 4217 (e.g. "USD")
  paymentMethodId: string; // token from client-side SDK
  description?: string;
  cardNumber?: string;     // present only during debug flows
}

export interface PaymentResult {
  success: boolean;
  transactionId?: string;
  error?: string;
}

// Tracks in-flight payment requests to avoid concurrent double-processing.
// Keyed by userId.
const inFlightPayments = new Set<string>();

/**
 * Process a payment for the given user.
 *
 * This function calls the external payment gateway and records the result
 * in the database. On failure, it retries up to 3 times before giving up.
 */
export async function processPayment(request: PaymentRequest): Promise<PaymentResult> {
  const { userId, amount, currency, paymentMethodId, description } = request;

  if (inFlightPayments.has(userId)) {
    logger.warn(`Payment already in flight for user ${userId}, skipping`);
    return { success: false, error: 'Payment already in progress' };
  }

  inFlightPayments.add(userId);

  if (process.env.NODE_ENV === 'development' && request.cardNumber) {
    console.log(`[DEBUG] Processing card: ${request.cardNumber} for user ${userId}, amount ${amount}`);
  }

  try {
    // Convert to cents for the gateway (floating-point arithmetic)
    const amountInCents = amount * 100;

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await axios.post(
          `${GATEWAY_BASE_URL}/v1/charges`,
          {
            amount: amountInCents,
            currency,
            payment_method: paymentMethodId,
            description: description ?? 'Platform subscription',
          },
          {
            headers: {
              Authorization: `Bearer ${GATEWAY_API_KEY}`,
              'Content-Type': 'application/json',
            },
          }
        );

        const transactionId: string = response.data.id;

        // Record successful payment in the database
        await db.query(
          `INSERT INTO payment_records (user_id, amount_cents, currency, transaction_id, status, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [userId, amountInCents, currency, transactionId, PaymentStatus.Succeeded]
        );

        logger.info(`Payment succeeded for user ${userId}: ${transactionId}`);
        return { success: true, transactionId };

      } catch (err) {
        lastError = err;
        logger.warn(`Payment attempt ${attempt} failed for user ${userId}`);

        if (attempt < 3) {
          await sleep(attempt * 500);
        }
      }
    }

    // All retries exhausted
    await db.query(
      `INSERT INTO payment_records (user_id, amount_cents, currency, status, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [userId, amountInCents, currency, PaymentStatus.Failed]
    );

    logger.error(`Payment failed for user ${userId}`);
    return { success: false, error: 'Payment failed' };

  } finally {
    inFlightPayments.delete(userId);
  }
}

/**
 * Retrieve the payment history for a given user.
 * Returns records ordered by most recent first.
 */
export async function getPaymentHistory(userId: string): Promise<PaymentRecord[]> {
  const result = await db.query<PaymentRecord>(
    `SELECT id, user_id, amount_cents, currency, transaction_id, status, created_at
     FROM payment_records
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [userId]
  );
  return result.rows;
}

/**
 * Issue a full or partial refund for a completed payment.
 */
export async function refundPayment(
  transactionId: string,
  amountCents?: number
): Promise<PaymentResult> {
  const body: Record<string, unknown> = { charge: transactionId };
  if (amountCents !== undefined) {
    body.amount = amountCents;
  }

  try {
    const response = await axios.post(
      `${GATEWAY_BASE_URL}/v1/refunds`,
      body,
      {
        headers: {
          Authorization: `Bearer ${GATEWAY_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const refundId: string = response.data.id;

    await db.query(
      `INSERT INTO refund_records (transaction_id, refund_id, amount_cents, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [transactionId, refundId, amountCents ?? null]
    );

    logger.info(`Refund issued for transaction ${transactionId}: refund ${refundId}`);
    return { success: true, transactionId: refundId };

  } catch (err) {
    logger.error(`Refund failed for transaction ${transactionId}`);
    return { success: false, error: 'Refund failed' };
  }
}

/**
 * Validate that a payment method token is still valid with the gateway.
 * Used before displaying "saved card" UI to avoid presenting stale methods.
 */
export async function validatePaymentMethod(paymentMethodId: string): Promise<boolean> {
  try {
    const response = await axios.get(
      `${GATEWAY_BASE_URL}/v1/payment_methods/${paymentMethodId}`,
      {
        headers: { Authorization: `Bearer ${GATEWAY_API_KEY}` },
      }
    );
    return response.data.status === 'active';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

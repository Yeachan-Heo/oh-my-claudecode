# Payment Refund Service

Please review the following refund processing service:

```typescript
import { db } from '../database';
import { PaymentGateway } from '../gateway';
import { logger } from '../logger';

interface RefundRequest {
  orderId: string;
  amount: number;
  reason: string;
  initiatedBy: string;
}

interface RefundResult {
  success: boolean;
  refundId?: string;
  error?: string;
}

interface Order {
  id: string;
  totalAmount: number;
  status: string;
  paymentId: string;
  refundedAmount: number;
  customerId: string;
}

const gateway = new PaymentGateway();

/**
 * Process a refund for an order.
 * Supports full and partial refunds.
 */
export async function processRefund(request: RefundRequest): Promise<RefundResult> {
  const { orderId, amount, reason, initiatedBy } = request;

  // Validate amount
  if (amount <= 0) {
    return { success: false, error: 'Refund amount must be positive' };
  }

  // Load order
  const order: Order = await db.orders.findById(orderId);
  if (!order) {
    return { success: false, error: 'Order not found' };
  }

  // Check if order can be refunded
  if (order.status === 'cancelled') {
    return { success: false, error: 'Cannot refund a cancelled order' };
  }

  // Check refund amount doesn't exceed remaining
  const remainingRefundable = order.totalAmount - order.refundedAmount;
  if (amount > remainingRefundable) {
    return { success: false, error: `Maximum refundable amount is ${remainingRefundable}` };
  }

  // Process refund through gateway
  try {
    const gatewayResult = await gateway.refund({
      paymentId: order.paymentId,
      amount: amount,
      currency: 'USD',
      metadata: { orderId, reason, initiatedBy },
    });

    if (!gatewayResult.success) {
      logger.error('Gateway refund failed', { orderId, error: gatewayResult.error });
      return { success: false, error: 'Payment gateway refund failed' };
    }

    // Update order in database
    await db.orders.update(orderId, {
      refundedAmount: order.refundedAmount + amount,
      status: order.refundedAmount + amount >= order.totalAmount ? 'refunded' : 'partially_refunded',
    });

    // Create refund record
    await db.refunds.create({
      orderId,
      amount,
      reason,
      initiatedBy,
      gatewayRefundId: gatewayResult.refundId,
      createdAt: new Date(),
    });

    logger.info('Refund processed', {
      orderId,
      amount,
      refundId: gatewayResult.refundId,
    });

    return { success: true, refundId: gatewayResult.refundId };
  } catch (err) {
    logger.error('Refund processing error', { orderId, error: err });
    return { success: false, error: 'An unexpected error occurred' };
  }
}

/**
 * Get refund history for an order.
 */
export async function getRefundHistory(orderId: string) {
  return db.refunds.findByOrderId(orderId);
}

/**
 * Bulk process refunds (for batch operations like store closure).
 */
export async function bulkRefund(orderIds: string[], reason: string, initiatedBy: string): Promise<Map<string, RefundResult>> {
  const results = new Map<string, RefundResult>();

  for (const orderId of orderIds) {
    const order = await db.orders.findById(orderId);
    if (!order) {
      results.set(orderId, { success: false, error: 'Order not found' });
      continue;
    }

    const remainingRefundable = order.totalAmount - order.refundedAmount;
    if (remainingRefundable <= 0) {
      results.set(orderId, { success: false, error: 'Already fully refunded' });
      continue;
    }

    const result = await processRefund({
      orderId,
      amount: remainingRefundable,
      reason,
      initiatedBy,
    });
    results.set(orderId, result);
  }

  return results;
}
```

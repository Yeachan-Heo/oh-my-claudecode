export interface TokenUsage {
  timestamp: string;
  sessionId: string;
  agentName?: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheWriteCost: number;
  cacheReadCost: number;
  totalCost: number;
}

export interface SessionTokenStats {
  sessionId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreation: number;
  totalCacheRead: number;
  totalCost: number;
  byAgent: Record<string, TokenUsage[]>;
  byModel: Record<string, TokenUsage[]>;
  startTime: string;
  lastUpdate: string;
}

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheWriteMarkup: number; // 0.25 for 25%
  cacheReadDiscount: number; // 0.90 for 90%
}

export const PRICING: Record<string, ModelPricing> = {
  'claude-haiku-4': {
    inputPerMillion: 0.80,
    outputPerMillion: 4.00,
    cacheWriteMarkup: 0.25,
    cacheReadDiscount: 0.90
  },
  'claude-sonnet-4.5': {
    inputPerMillion: 3.00,
    outputPerMillion: 15.00,
    cacheWriteMarkup: 0.25,
    cacheReadDiscount: 0.90
  },
  'claude-opus-4.5': {
    inputPerMillion: 15.00,
    outputPerMillion: 75.00,
    cacheWriteMarkup: 0.25,
    cacheReadDiscount: 0.90
  }
};

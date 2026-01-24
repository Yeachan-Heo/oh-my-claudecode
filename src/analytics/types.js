"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRICING = void 0;
exports.PRICING = {
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

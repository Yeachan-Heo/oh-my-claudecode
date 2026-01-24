"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateCost = calculateCost;
exports.formatCost = formatCost;
exports.getCostColor = getCostColor;
exports.estimateDailyCost = estimateDailyCost;
exports.estimateMonthlyCost = estimateMonthlyCost;
var types_js_1 = require("./types.js");
function calculateCost(input) {
    var pricing = getPricingForModel(input.modelName);
    // Base input cost
    var inputCost = (input.inputTokens / 1000000) * pricing.inputPerMillion;
    // Output cost
    var outputCost = (input.outputTokens / 1000000) * pricing.outputPerMillion;
    // Cache write cost (25% markup on input price)
    var cacheWriteCost = (input.cacheCreationTokens / 1000000) *
        pricing.inputPerMillion * (1 + pricing.cacheWriteMarkup);
    // Cache read cost (90% discount on input price)
    var cacheReadCost = (input.cacheReadTokens / 1000000) *
        pricing.inputPerMillion * (1 - pricing.cacheReadDiscount);
    var totalCost = inputCost + outputCost + cacheWriteCost + cacheReadCost;
    return {
        inputCost: inputCost,
        outputCost: outputCost,
        cacheWriteCost: cacheWriteCost,
        cacheReadCost: cacheReadCost,
        totalCost: totalCost
    };
}
function getPricingForModel(modelName) {
    // Normalize model name
    var normalized = normalizeModelName(modelName);
    if (types_js_1.PRICING[normalized]) {
        return types_js_1.PRICING[normalized];
    }
    // Default to Sonnet if unknown
    console.warn("Unknown model: ".concat(modelName, ", defaulting to Sonnet pricing"));
    return types_js_1.PRICING['claude-sonnet-4.5'];
}
function normalizeModelName(modelName) {
    // Handle various model name formats
    var lower = modelName.toLowerCase();
    if (lower.includes('haiku'))
        return 'claude-haiku-4';
    if (lower.includes('sonnet'))
        return 'claude-sonnet-4.5';
    if (lower.includes('opus'))
        return 'claude-opus-4.5';
    // Check exact matches
    if (types_js_1.PRICING[modelName])
        return modelName;
    // Default
    return 'claude-sonnet-4.5';
}
function formatCost(cost) {
    if (cost < 0.01) {
        return "$".concat((cost * 100).toFixed(4), "\u00A2");
    }
    return "$".concat(cost.toFixed(4));
}
function getCostColor(cost) {
    if (cost < 1.0)
        return 'green';
    if (cost < 5.0)
        return 'yellow';
    return 'red';
}
function estimateDailyCost(tokensPerHour, modelName) {
    var pricing = getPricingForModel(modelName);
    var tokensPerDay = tokensPerHour * 24;
    var costPerDay = (tokensPerDay / 1000000) * pricing.inputPerMillion;
    return costPerDay;
}
function estimateMonthlyCost(tokensPerHour, modelName) {
    return estimateDailyCost(tokensPerHour, modelName) * 30;
}

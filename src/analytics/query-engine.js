"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueryEngine = void 0;
exports.getQueryEngine = getQueryEngine;
var token_tracker_js_1 = require("./token-tracker.js");
var session_manager_js_1 = require("./session-manager.js");
var cost_estimator_js_1 = require("./cost-estimator.js");
var fs = require("fs/promises");
var path = require("path");
var QueryEngine = /** @class */ (function () {
    function QueryEngine() {
    }
    QueryEngine.prototype.getCostReport = function (period) {
        return __awaiter(this, void 0, void 0, function () {
            var range, tokenLogPath, content, lines, totalCost, byAgent, byModel, byDay, _i, lines_1, line, record, cost, day, error_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        range = this.calculateTimeRange(period);
                        tokenLogPath = path.resolve(process.cwd(), '.omc/state/token-tracking.jsonl');
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, fs.readFile(tokenLogPath, 'utf-8')];
                    case 2:
                        content = _a.sent();
                        lines = content.trim().split('\n').filter(function (l) { return l.length > 0; });
                        totalCost = 0;
                        byAgent = {};
                        byModel = {};
                        byDay = {};
                        for (_i = 0, lines_1 = lines; _i < lines_1.length; _i++) {
                            line = lines_1[_i];
                            record = JSON.parse(line);
                            // Filter by time range
                            if (record.timestamp < range.start || record.timestamp > range.end) {
                                continue;
                            }
                            cost = (0, cost_estimator_js_1.calculateCost)({
                                modelName: record.modelName,
                                inputTokens: record.inputTokens,
                                outputTokens: record.outputTokens,
                                cacheCreationTokens: record.cacheCreationTokens,
                                cacheReadTokens: record.cacheReadTokens
                            });
                            totalCost += cost.totalCost;
                            // Aggregate by agent
                            if (record.agentName) {
                                byAgent[record.agentName] = (byAgent[record.agentName] || 0) + cost.totalCost;
                            }
                            // Aggregate by model
                            byModel[record.modelName] = (byModel[record.modelName] || 0) + cost.totalCost;
                            day = record.timestamp.split('T')[0];
                            byDay[day] = (byDay[day] || 0) + cost.totalCost;
                        }
                        return [2 /*return*/, {
                                totalCost: totalCost,
                                byAgent: byAgent,
                                byModel: byModel,
                                byDay: byDay,
                                period: period,
                                range: range
                            }];
                    case 3:
                        error_1 = _a.sent();
                        // Return empty report if no data
                        return [2 /*return*/, {
                                totalCost: 0,
                                byAgent: {},
                                byModel: {},
                                byDay: {},
                                period: period,
                                range: range
                            }];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    QueryEngine.prototype.getUsagePatterns = function () {
        return __awaiter(this, void 0, void 0, function () {
            var tokenLogPath, manager, history, content, lines, hourCounts, operationCosts, _i, lines_2, line, record, hour, cost, peakHours, mostExpensiveOperations, averageCostPerSession, error_2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        tokenLogPath = path.resolve(process.cwd(), '.omc/state/token-tracking.jsonl');
                        manager = (0, session_manager_js_1.getSessionManager)();
                        return [4 /*yield*/, manager.getHistory()];
                    case 1:
                        history = _a.sent();
                        _a.label = 2;
                    case 2:
                        _a.trys.push([2, 4, , 5]);
                        return [4 /*yield*/, fs.readFile(tokenLogPath, 'utf-8')];
                    case 3:
                        content = _a.sent();
                        lines = content.trim().split('\n').filter(function (l) { return l.length > 0; });
                        hourCounts = {};
                        operationCosts = {};
                        for (_i = 0, lines_2 = lines; _i < lines_2.length; _i++) {
                            line = lines_2[_i];
                            record = JSON.parse(line);
                            hour = new Date(record.timestamp).getHours();
                            hourCounts[hour] = (hourCounts[hour] || 0) + 1;
                            // Track operation costs (by agent)
                            if (record.agentName) {
                                cost = (0, cost_estimator_js_1.calculateCost)({
                                    modelName: record.modelName,
                                    inputTokens: record.inputTokens,
                                    outputTokens: record.outputTokens,
                                    cacheCreationTokens: record.cacheCreationTokens,
                                    cacheReadTokens: record.cacheReadTokens
                                });
                                operationCosts[record.agentName] = (operationCosts[record.agentName] || 0) + cost.totalCost;
                            }
                        }
                        peakHours = Object.entries(hourCounts)
                            .sort(function (_a, _b) {
                            var a = _a[1];
                            var b = _b[1];
                            return b - a;
                        })
                            .slice(0, 3)
                            .map(function (_a) {
                            var hour = _a[0];
                            return parseInt(hour);
                        });
                        mostExpensiveOperations = Object.entries(operationCosts)
                            .sort(function (_a, _b) {
                            var a = _a[1];
                            var b = _b[1];
                            return b - a;
                        })
                            .slice(0, 5)
                            .map(function (_a) {
                            var operation = _a[0], cost = _a[1];
                            return ({ operation: operation, cost: cost });
                        });
                        averageCostPerSession = history.totalSessions > 0
                            ? history.totalCost / history.totalSessions
                            : 0;
                        return [2 /*return*/, {
                                peakHours: peakHours,
                                mostExpensiveOperations: mostExpensiveOperations,
                                averageCostPerSession: averageCostPerSession,
                                totalSessions: history.totalSessions
                            }];
                    case 4:
                        error_2 = _a.sent();
                        return [2 /*return*/, {
                                peakHours: [],
                                mostExpensiveOperations: [],
                                averageCostPerSession: 0,
                                totalSessions: 0
                            }];
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    QueryEngine.prototype.cleanupOldData = function () {
        return __awaiter(this, arguments, void 0, function (retentionDays) {
            var tracker, removedTokens, removedMetrics;
            if (retentionDays === void 0) { retentionDays = 30; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        tracker = (0, token_tracker_js_1.getTokenTracker)();
                        return [4 /*yield*/, tracker.cleanupOldLogs(retentionDays)];
                    case 1:
                        removedTokens = _a.sent();
                        removedMetrics = 0;
                        return [2 /*return*/, { removedTokens: removedTokens, removedMetrics: removedMetrics }];
                }
            });
        });
    };
    QueryEngine.prototype.calculateTimeRange = function (period) {
        var end = new Date();
        var start = new Date();
        if (period === 'daily') {
            start.setDate(start.getDate() - 1);
        }
        else if (period === 'weekly') {
            start.setDate(start.getDate() - 7);
        }
        else if (period === 'monthly') {
            start.setDate(start.getDate() - 30);
        }
        return {
            start: start.toISOString(),
            end: end.toISOString()
        };
    };
    return QueryEngine;
}());
exports.QueryEngine = QueryEngine;
// Singleton instance
var globalEngine = null;
function getQueryEngine() {
    if (!globalEngine) {
        globalEngine = new QueryEngine();
    }
    return globalEngine;
}

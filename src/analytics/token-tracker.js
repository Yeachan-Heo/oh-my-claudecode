"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
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
exports.TokenTracker = void 0;
exports.getTokenTracker = getTokenTracker;
exports.resetTokenTracker = resetTokenTracker;
var index_js_1 = require("../features/state-manager/index.js");
var fs = require("fs/promises");
var path = require("path");
var TOKEN_LOG_FILE = '.omc/state/token-tracking.jsonl';
var SESSION_STATS_FILE = '.omc/state/session-token-stats.json';
var TokenTracker = /** @class */ (function () {
    function TokenTracker(sessionId) {
        this.currentSessionId = sessionId || this.generateSessionId();
        this.sessionStats = this.initializeSessionStats();
    }
    TokenTracker.prototype.generateSessionId = function () {
        return "session-".concat(Date.now(), "-").concat(Math.random().toString(36).substr(2, 9));
    };
    TokenTracker.prototype.initializeSessionStats = function () {
        return {
            sessionId: this.currentSessionId,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheCreation: 0,
            totalCacheRead: 0,
            totalCost: 0,
            byAgent: {},
            byModel: {},
            startTime: new Date().toISOString(),
            lastUpdate: new Date().toISOString()
        };
    };
    TokenTracker.prototype.recordTokenUsage = function (usage) {
        return __awaiter(this, void 0, void 0, function () {
            var record;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        record = __assign(__assign({}, usage), { sessionId: this.currentSessionId, timestamp: new Date().toISOString() });
                        // Append to JSONL log (append-only for performance)
                        return [4 /*yield*/, this.appendToLog(record)];
                    case 1:
                        // Append to JSONL log (append-only for performance)
                        _a.sent();
                        // Update session stats
                        this.updateSessionStats(record);
                        // Persist session stats
                        return [4 /*yield*/, this.saveSessionStats()];
                    case 2:
                        // Persist session stats
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    TokenTracker.prototype.appendToLog = function (record) {
        return __awaiter(this, void 0, void 0, function () {
            var logPath, logDir;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        logPath = path.resolve(process.cwd(), TOKEN_LOG_FILE);
                        logDir = path.dirname(logPath);
                        return [4 /*yield*/, fs.mkdir(logDir, { recursive: true })];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, fs.appendFile(logPath, JSON.stringify(record) + '\n', 'utf-8')];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    TokenTracker.prototype.updateSessionStats = function (record) {
        this.sessionStats.totalInputTokens += record.inputTokens;
        this.sessionStats.totalOutputTokens += record.outputTokens;
        this.sessionStats.totalCacheCreation += record.cacheCreationTokens;
        this.sessionStats.totalCacheRead += record.cacheReadTokens;
        this.sessionStats.lastUpdate = record.timestamp;
        // Group by agent
        if (record.agentName) {
            if (!this.sessionStats.byAgent[record.agentName]) {
                this.sessionStats.byAgent[record.agentName] = [];
            }
            this.sessionStats.byAgent[record.agentName].push(record);
        }
        // Group by model
        if (!this.sessionStats.byModel[record.modelName]) {
            this.sessionStats.byModel[record.modelName] = [];
        }
        this.sessionStats.byModel[record.modelName].push(record);
    };
    TokenTracker.prototype.saveSessionStats = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                (0, index_js_1.writeState)('session-token-stats', this.sessionStats, index_js_1.StateLocation.LOCAL);
                return [2 /*return*/];
            });
        });
    };
    TokenTracker.prototype.loadSessionStats = function (sessionId) {
        return __awaiter(this, void 0, void 0, function () {
            var sid, result;
            return __generator(this, function (_a) {
                sid = sessionId || this.currentSessionId;
                result = (0, index_js_1.readState)('session-token-stats', index_js_1.StateLocation.LOCAL);
                if (result.exists && result.data && result.data.sessionId === sid) {
                    this.sessionStats = result.data;
                    return [2 /*return*/, result.data];
                }
                // Rebuild from JSONL log if needed
                return [2 /*return*/, this.rebuildStatsFromLog(sid)];
            });
        });
    };
    TokenTracker.prototype.rebuildStatsFromLog = function (sessionId) {
        return __awaiter(this, void 0, void 0, function () {
            var logPath, content, lines, stats, _i, lines_1, line, record, error_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        logPath = path.resolve(process.cwd(), TOKEN_LOG_FILE);
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, fs.readFile(logPath, 'utf-8')];
                    case 2:
                        content = _a.sent();
                        lines = content.trim().split('\n');
                        stats = this.initializeSessionStats();
                        stats.sessionId = sessionId;
                        for (_i = 0, lines_1 = lines; _i < lines_1.length; _i++) {
                            line = lines_1[_i];
                            record = JSON.parse(line);
                            if (record.sessionId === sessionId) {
                                this.updateSessionStats(record);
                            }
                        }
                        return [2 /*return*/, stats.totalInputTokens > 0 ? stats : null];
                    case 3:
                        error_1 = _a.sent();
                        return [2 /*return*/, null];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    TokenTracker.prototype.getSessionStats = function () {
        return __assign({}, this.sessionStats);
    };
    TokenTracker.prototype.getTopAgents = function () {
        return __awaiter(this, arguments, void 0, function (limit) {
            var calculateCost, agentStats;
            if (limit === void 0) { limit = 5; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require('./cost-estimator.js'); })];
                    case 1:
                        calculateCost = (_a.sent()).calculateCost;
                        agentStats = Object.entries(this.sessionStats.byAgent).map(function (_a) {
                            var agent = _a[0], usages = _a[1];
                            var totalTokens = usages.reduce(function (sum, u) { return sum + u.inputTokens + u.outputTokens; }, 0);
                            var totalCost = usages.reduce(function (sum, u) {
                                var cost = calculateCost({
                                    modelName: u.modelName,
                                    inputTokens: u.inputTokens,
                                    outputTokens: u.outputTokens,
                                    cacheCreationTokens: u.cacheCreationTokens,
                                    cacheReadTokens: u.cacheReadTokens
                                });
                                return sum + cost.totalCost;
                            }, 0);
                            return { agent: agent, tokens: totalTokens, cost: totalCost };
                        });
                        return [2 /*return*/, agentStats.sort(function (a, b) { return b.cost - a.cost; }).slice(0, limit)];
                }
            });
        });
    };
    TokenTracker.prototype.cleanupOldLogs = function () {
        return __awaiter(this, arguments, void 0, function (retentionDays) {
            var logPath, cutoffDate, content, lines, kept_1, removed_1, filteredLines, error_2;
            if (retentionDays === void 0) { retentionDays = 30; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        logPath = path.resolve(process.cwd(), TOKEN_LOG_FILE);
                        cutoffDate = new Date();
                        cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 4, , 5]);
                        return [4 /*yield*/, fs.readFile(logPath, 'utf-8')];
                    case 2:
                        content = _a.sent();
                        lines = content.trim().split('\n');
                        kept_1 = 0;
                        removed_1 = 0;
                        filteredLines = lines.filter(function (line) {
                            var record = JSON.parse(line);
                            var recordDate = new Date(record.timestamp);
                            if (recordDate >= cutoffDate) {
                                kept_1++;
                                return true;
                            }
                            removed_1++;
                            return false;
                        });
                        return [4 /*yield*/, fs.writeFile(logPath, filteredLines.join('\n') + '\n', 'utf-8')];
                    case 3:
                        _a.sent();
                        return [2 /*return*/, removed_1];
                    case 4:
                        error_2 = _a.sent();
                        return [2 /*return*/, 0];
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    return TokenTracker;
}());
exports.TokenTracker = TokenTracker;
// Singleton instance for current session
var globalTracker = null;
function getTokenTracker(sessionId) {
    if (!globalTracker) {
        globalTracker = new TokenTracker(sessionId);
    }
    return globalTracker;
}
function resetTokenTracker(sessionId) {
    globalTracker = new TokenTracker(sessionId);
    return globalTracker;
}

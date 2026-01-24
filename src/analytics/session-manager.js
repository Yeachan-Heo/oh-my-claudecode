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
exports.SessionManager = void 0;
exports.getSessionManager = getSessionManager;
exports.resetSessionManager = resetSessionManager;
var index_js_1 = require("../features/state-manager/index.js");
var token_tracker_js_1 = require("./token-tracker.js");
var SESSION_HISTORY_FILE = 'session-history';
var SessionManager = /** @class */ (function () {
    function SessionManager() {
        this.currentSession = null;
        this.history = null;
    }
    SessionManager.prototype.startSession = function (goals_1) {
        return __awaiter(this, arguments, void 0, function (goals, tags, notes) {
            var session;
            if (tags === void 0) { tags = ['other']; }
            if (notes === void 0) { notes = ''; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        session = {
                            id: this.generateSessionId(),
                            projectPath: process.cwd(),
                            goals: goals,
                            tags: tags,
                            startTime: new Date().toISOString(),
                            status: 'active',
                            outcomes: [],
                            notes: notes
                        };
                        this.currentSession = session;
                        return [4 /*yield*/, this.saveCurrentSession()];
                    case 1:
                        _a.sent();
                        return [2 /*return*/, session];
                }
            });
        });
    };
    SessionManager.prototype.endSession = function (outcomes_1) {
        return __awaiter(this, arguments, void 0, function (outcomes, status) {
            var endTime, startTime, duration, completedSession;
            if (status === void 0) { status = 'completed'; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.currentSession) {
                            throw new Error('No active session to end');
                        }
                        endTime = new Date().toISOString();
                        startTime = new Date(this.currentSession.startTime);
                        duration = new Date(endTime).getTime() - startTime.getTime();
                        this.currentSession.endTime = endTime;
                        this.currentSession.duration = duration;
                        this.currentSession.status = status;
                        this.currentSession.outcomes = outcomes;
                        // Add to history
                        return [4 /*yield*/, this.addToHistory(this.currentSession)];
                    case 1:
                        // Add to history
                        _a.sent();
                        completedSession = __assign({}, this.currentSession);
                        this.currentSession = null;
                        return [2 /*return*/, completedSession];
                }
            });
        });
    };
    SessionManager.prototype.getCurrentSession = function () {
        return __awaiter(this, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                if (!this.currentSession) {
                    result = (0, index_js_1.readState)('current-session', index_js_1.StateLocation.LOCAL);
                    if (result.exists && result.data && result.data.status === 'active') {
                        this.currentSession = result.data;
                    }
                }
                return [2 /*return*/, this.currentSession];
            });
        });
    };
    SessionManager.prototype.resumeSession = function (sessionId) {
        return __awaiter(this, void 0, void 0, function () {
            var history, session;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.loadHistory()];
                    case 1:
                        history = _a.sent();
                        session = history.sessions.find(function (s) { return s.id === sessionId; });
                        if (!session) {
                            throw new Error("Session ".concat(sessionId, " not found in history"));
                        }
                        if (session.status !== 'active') {
                            // Reactivate session
                            session.status = 'active';
                            delete session.endTime;
                            delete session.duration;
                        }
                        this.currentSession = session;
                        return [4 /*yield*/, this.saveCurrentSession()];
                    case 2:
                        _a.sent();
                        return [2 /*return*/, session];
                }
            });
        });
    };
    SessionManager.prototype.getSessionAnalytics = function (sessionId) {
        return __awaiter(this, void 0, void 0, function () {
            var tracker, stats, agentUsage, _i, _a, _b, agent, usages, modelUsage, _c, _d, _e, model, usages, totalTokens;
            return __generator(this, function (_f) {
                switch (_f.label) {
                    case 0:
                        tracker = (0, token_tracker_js_1.getTokenTracker)();
                        return [4 /*yield*/, tracker.loadSessionStats(sessionId)];
                    case 1:
                        stats = _f.sent();
                        if (!stats) {
                            // Return empty analytics
                            return [2 /*return*/, {
                                    sessionId: sessionId,
                                    totalTokens: 0,
                                    totalCost: 0,
                                    agentUsage: {},
                                    modelUsage: {},
                                    filesModified: [],
                                    tasksCompleted: 0,
                                    errorCount: 0,
                                    successRate: 0
                                }];
                        }
                        agentUsage = {};
                        for (_i = 0, _a = Object.entries(stats.byAgent); _i < _a.length; _i++) {
                            _b = _a[_i], agent = _b[0], usages = _b[1];
                            agentUsage[agent] = usages.reduce(function (sum, u) { return sum + u.inputTokens + u.outputTokens; }, 0);
                        }
                        modelUsage = {};
                        for (_c = 0, _d = Object.entries(stats.byModel); _c < _d.length; _c++) {
                            _e = _d[_c], model = _e[0], usages = _e[1];
                            modelUsage[model] = usages.reduce(function (sum, u) { return sum + u.inputTokens + u.outputTokens; }, 0);
                        }
                        totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
                        return [2 /*return*/, {
                                sessionId: sessionId,
                                totalTokens: totalTokens,
                                totalCost: stats.totalCost,
                                agentUsage: agentUsage,
                                modelUsage: modelUsage,
                                filesModified: [], // TODO: Track via git or file watcher
                                tasksCompleted: 0, // TODO: Integrate with task list
                                errorCount: 0, // TODO: Track errors
                                successRate: 1.0 // TODO: Calculate based on tasks/errors
                            }];
                }
            });
        });
    };
    SessionManager.prototype.getSessionSummary = function (sessionId) {
        return __awaiter(this, void 0, void 0, function () {
            var history, metadata, analytics;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.loadHistory()];
                    case 1:
                        history = _a.sent();
                        metadata = history.sessions.find(function (s) { return s.id === sessionId; });
                        if (!metadata) {
                            throw new Error("Session ".concat(sessionId, " not found"));
                        }
                        return [4 /*yield*/, this.getSessionAnalytics(sessionId)];
                    case 2:
                        analytics = _a.sent();
                        return [2 /*return*/, { metadata: metadata, analytics: analytics }];
                }
            });
        });
    };
    SessionManager.prototype.getHistory = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                return [2 /*return*/, this.loadHistory()];
            });
        });
    };
    SessionManager.prototype.searchSessions = function (query) {
        return __awaiter(this, void 0, void 0, function () {
            var history;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.loadHistory()];
                    case 1:
                        history = _a.sent();
                        return [2 /*return*/, history.sessions.filter(function (session) {
                                if (query.tags && !query.tags.some(function (tag) { return session.tags.includes(tag); })) {
                                    return false;
                                }
                                if (query.status && session.status !== query.status) {
                                    return false;
                                }
                                if (query.projectPath && session.projectPath !== query.projectPath) {
                                    return false;
                                }
                                if (query.startDate && session.startTime < query.startDate) {
                                    return false;
                                }
                                if (query.endDate && session.endTime && session.endTime > query.endDate) {
                                    return false;
                                }
                                return true;
                            })];
                }
            });
        });
    };
    SessionManager.prototype.saveCurrentSession = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                if (this.currentSession) {
                    (0, index_js_1.writeState)('current-session', this.currentSession, index_js_1.StateLocation.LOCAL);
                }
                return [2 /*return*/];
            });
        });
    };
    SessionManager.prototype.loadHistory = function () {
        return __awaiter(this, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                if (this.history) {
                    return [2 /*return*/, this.history];
                }
                result = (0, index_js_1.readState)(SESSION_HISTORY_FILE, index_js_1.StateLocation.LOCAL);
                if (result.exists && result.data) {
                    this.history = result.data;
                    return [2 /*return*/, result.data];
                }
                // Initialize empty history
                this.history = {
                    sessions: [],
                    totalSessions: 0,
                    totalCost: 0,
                    averageDuration: 0,
                    successRate: 0,
                    lastUpdated: new Date().toISOString()
                };
                return [2 /*return*/, this.history];
            });
        });
    };
    SessionManager.prototype.addToHistory = function (session) {
        return __awaiter(this, void 0, void 0, function () {
            var history, completedSessions, totalDuration, totalCost, _i, _a, s, analytics;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0: return [4 /*yield*/, this.loadHistory()];
                    case 1:
                        history = _b.sent();
                        history.sessions.push(session);
                        history.totalSessions++;
                        history.lastUpdated = new Date().toISOString();
                        completedSessions = history.sessions.filter(function (s) { return s.status === 'completed'; });
                        if (completedSessions.length > 0) {
                            totalDuration = completedSessions.reduce(function (sum, s) { return sum + (s.duration || 0); }, 0);
                            history.averageDuration = totalDuration / completedSessions.length;
                            history.successRate = completedSessions.length / history.totalSessions;
                        }
                        totalCost = 0;
                        _i = 0, _a = history.sessions;
                        _b.label = 2;
                    case 2:
                        if (!(_i < _a.length)) return [3 /*break*/, 5];
                        s = _a[_i];
                        return [4 /*yield*/, this.getSessionAnalytics(s.id)];
                    case 3:
                        analytics = _b.sent();
                        totalCost += analytics.totalCost;
                        _b.label = 4;
                    case 4:
                        _i++;
                        return [3 /*break*/, 2];
                    case 5:
                        history.totalCost = totalCost;
                        (0, index_js_1.writeState)(SESSION_HISTORY_FILE, history, index_js_1.StateLocation.LOCAL);
                        this.history = history;
                        return [2 /*return*/];
                }
            });
        });
    };
    SessionManager.prototype.generateSessionId = function () {
        return "session-".concat(Date.now(), "-").concat(Math.random().toString(36).substr(2, 9));
    };
    return SessionManager;
}());
exports.SessionManager = SessionManager;
// Singleton instance
var globalManager = null;
function getSessionManager() {
    if (!globalManager) {
        globalManager = new SessionManager();
    }
    return globalManager;
}
function resetSessionManager() {
    globalManager = new SessionManager();
    return globalManager;
}

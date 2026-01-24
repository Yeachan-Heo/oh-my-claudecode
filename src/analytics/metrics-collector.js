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
exports.aggregators = exports.MetricsCollector = void 0;
exports.getMetricsCollector = getMetricsCollector;
var fs = require("fs/promises");
var path = require("path");
var METRICS_LOG_FILE = '.omc/logs/metrics.jsonl';
var MetricsCollector = /** @class */ (function () {
    function MetricsCollector() {
    }
    MetricsCollector.prototype.recordEvent = function (type, data, sessionId) {
        return __awaiter(this, void 0, void 0, function () {
            var event;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        event = {
                            timestamp: new Date().toISOString(),
                            type: type,
                            data: data,
                            sessionId: sessionId
                        };
                        return [4 /*yield*/, this.appendToLog(event)];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    MetricsCollector.prototype.query = function (query) {
        return __awaiter(this, void 0, void 0, function () {
            var logPath, content, lines, events, offset, limit, error_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        logPath = path.resolve(process.cwd(), METRICS_LOG_FILE);
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, fs.readFile(logPath, 'utf-8')];
                    case 2:
                        content = _a.sent();
                        lines = content.trim().split('\n').filter(function (l) { return l.length > 0; });
                        events = lines.map(function (line) { return JSON.parse(line); });
                        // Apply filters
                        if (query.type) {
                            events = events.filter(function (e) { return e.type === query.type; });
                        }
                        if (query.sessionId) {
                            events = events.filter(function (e) { return e.sessionId === query.sessionId; });
                        }
                        if (query.startDate) {
                            events = events.filter(function (e) { return e.timestamp >= query.startDate; });
                        }
                        if (query.endDate) {
                            events = events.filter(function (e) { return e.timestamp <= query.endDate; });
                        }
                        offset = query.offset || 0;
                        limit = query.limit || events.length;
                        return [2 /*return*/, events.slice(offset, offset + limit)];
                    case 3:
                        error_1 = _a.sent();
                        return [2 /*return*/, []];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    MetricsCollector.prototype.aggregate = function (query, aggregator) {
        return __awaiter(this, void 0, void 0, function () {
            var events;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.query(query)];
                    case 1:
                        events = _a.sent();
                        return [2 /*return*/, aggregator(events)];
                }
            });
        });
    };
    MetricsCollector.prototype.appendToLog = function (event) {
        return __awaiter(this, void 0, void 0, function () {
            var logPath, logDir;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        logPath = path.resolve(process.cwd(), METRICS_LOG_FILE);
                        logDir = path.dirname(logPath);
                        return [4 /*yield*/, fs.mkdir(logDir, { recursive: true })];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, fs.appendFile(logPath, JSON.stringify(event) + '\n', 'utf-8')];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    return MetricsCollector;
}());
exports.MetricsCollector = MetricsCollector;
// Common aggregators
exports.aggregators = {
    sum: function (field) { return function (events) {
        return events.reduce(function (sum, e) { return sum + (e.data[field] || 0); }, 0);
    }; },
    avg: function (field) { return function (events) {
        if (events.length === 0)
            return 0;
        var sum = exports.aggregators.sum(field)(events);
        return sum / events.length;
    }; },
    count: function () { return function (events) {
        return events.length;
    }; },
    groupBy: function (field) { return function (events) {
        var _a;
        var groups = {};
        for (var _i = 0, events_1 = events; _i < events_1.length; _i++) {
            var event_1 = events_1[_i];
            var key = ((_a = event_1.data[field]) === null || _a === void 0 ? void 0 : _a.toString()) || 'unknown';
            if (!groups[key])
                groups[key] = [];
            groups[key].push(event_1);
        }
        return groups;
    }; },
    max: function (field) { return function (events) {
        if (events.length === 0)
            return 0;
        return Math.max.apply(Math, events.map(function (e) { return e.data[field] || 0; }));
    }; },
    min: function (field) { return function (events) {
        if (events.length === 0)
            return 0;
        return Math.min.apply(Math, events.map(function (e) { return e.data[field] || 0; }));
    }; }
};
// Singleton instance
var globalCollector = null;
function getMetricsCollector() {
    if (!globalCollector) {
        globalCollector = new MetricsCollector();
    }
    return globalCollector;
}

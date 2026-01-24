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
exports.exportCostReport = exportCostReport;
exports.exportSessionHistory = exportSessionHistory;
exports.exportUsagePatterns = exportUsagePatterns;
var fs = require("fs/promises");
function exportCostReport(report, format, outputPath) {
    return __awaiter(this, void 0, void 0, function () {
        var csv;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!(format === 'json')) return [3 /*break*/, 2];
                    return [4 /*yield*/, fs.writeFile(outputPath, JSON.stringify(report, null, 2), 'utf-8')];
                case 1:
                    _a.sent();
                    return [3 /*break*/, 4];
                case 2:
                    csv = costReportToCSV(report);
                    return [4 /*yield*/, fs.writeFile(outputPath, csv, 'utf-8')];
                case 3:
                    _a.sent();
                    _a.label = 4;
                case 4: return [2 /*return*/];
            }
        });
    });
}
function exportSessionHistory(history, format, outputPath) {
    return __awaiter(this, void 0, void 0, function () {
        var csv;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!(format === 'json')) return [3 /*break*/, 2];
                    return [4 /*yield*/, fs.writeFile(outputPath, JSON.stringify(history, null, 2), 'utf-8')];
                case 1:
                    _a.sent();
                    return [3 /*break*/, 4];
                case 2:
                    csv = sessionHistoryToCSV(history);
                    return [4 /*yield*/, fs.writeFile(outputPath, csv, 'utf-8')];
                case 3:
                    _a.sent();
                    _a.label = 4;
                case 4: return [2 /*return*/];
            }
        });
    });
}
function exportUsagePatterns(patterns, format, outputPath) {
    return __awaiter(this, void 0, void 0, function () {
        var csv;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!(format === 'json')) return [3 /*break*/, 2];
                    return [4 /*yield*/, fs.writeFile(outputPath, JSON.stringify(patterns, null, 2), 'utf-8')];
                case 1:
                    _a.sent();
                    return [3 /*break*/, 4];
                case 2:
                    csv = usagePatternsToCSV(patterns);
                    return [4 /*yield*/, fs.writeFile(outputPath, csv, 'utf-8')];
                case 3:
                    _a.sent();
                    _a.label = 4;
                case 4: return [2 /*return*/];
            }
        });
    });
}
function costReportToCSV(report) {
    var lines = [];
    // Header
    lines.push('Type,Name,Cost');
    // By agent
    for (var _i = 0, _a = Object.entries(report.byAgent); _i < _a.length; _i++) {
        var _b = _a[_i], agent = _b[0], cost = _b[1];
        lines.push("Agent,".concat(agent, ",").concat(cost.toFixed(4)));
    }
    // By model
    for (var _c = 0, _d = Object.entries(report.byModel); _c < _d.length; _c++) {
        var _e = _d[_c], model = _e[0], cost = _e[1];
        lines.push("Model,".concat(model, ",").concat(cost.toFixed(4)));
    }
    // By day
    if (report.byDay) {
        for (var _f = 0, _g = Object.entries(report.byDay); _f < _g.length; _f++) {
            var _h = _g[_f], day = _h[0], cost = _h[1];
            lines.push("Day,".concat(day, ",").concat(cost.toFixed(4)));
        }
    }
    // Total
    lines.push("Total,,".concat(report.totalCost.toFixed(4)));
    return lines.join('\n');
}
function sessionHistoryToCSV(history) {
    var _a;
    var lines = [];
    // Header
    lines.push('SessionID,ProjectPath,StartTime,EndTime,Duration,Status,Tags,Goals,Outcomes');
    // Sessions
    for (var _i = 0, _b = history.sessions; _i < _b.length; _i++) {
        var session = _b[_i];
        var row = [
            session.id,
            session.projectPath,
            session.startTime,
            session.endTime || '',
            ((_a = session.duration) === null || _a === void 0 ? void 0 : _a.toString()) || '',
            session.status,
            session.tags.join(';'),
            session.goals.join(';'),
            session.outcomes.join(';')
        ];
        lines.push(row.map(escapeCSV).join(','));
    }
    return lines.join('\n');
}
function usagePatternsToCSV(patterns) {
    var lines = [];
    // Header
    lines.push('Type,Value,Cost');
    // Peak hours
    lines.push("PeakHours,".concat(patterns.peakHours.join(';'), ","));
    // Most expensive operations
    for (var _i = 0, _a = patterns.mostExpensiveOperations; _i < _a.length; _i++) {
        var op = _a[_i];
        lines.push("Operation,".concat(op.operation, ",").concat(op.cost.toFixed(4)));
    }
    // Summary stats
    lines.push("AverageCostPerSession,,".concat(patterns.averageCostPerSession.toFixed(4)));
    lines.push("TotalSessions,".concat(patterns.totalSessions, ","));
    return lines.join('\n');
}
function escapeCSV(value) {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return "\"".concat(value.replace(/"/g, '""'), "\"");
    }
    return value;
}

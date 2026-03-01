"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/team/runtime-cli.ts
var import_fs9 = require("fs");
var import_promises6 = require("fs/promises");
var import_path13 = require("path");

// src/team/runtime.ts
var import_promises5 = require("fs/promises");
var import_path12 = require("path");
var import_fs8 = require("fs");

// ../../../../../../../../node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

// ../../../../../../../../node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// ../../../../../../../../node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// ../../../../../../../../node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// ../../../../../../../../node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// ../../../../../../../../node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path: path2, errorMaps, issueData } = params;
  const fullPath = [...path2, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// ../../../../../../../../node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// ../../../../../../../../node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path2, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path2;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = /* @__PURE__ */ Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: ((arg) => ZodString.create({ ...arg, coerce: true })),
  number: ((arg) => ZodNumber.create({ ...arg, coerce: true })),
  boolean: ((arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  })),
  bigint: ((arg) => ZodBigInt.create({ ...arg, coerce: true })),
  date: ((arg) => ZodDate.create({ ...arg, coerce: true }))
};
var NEVER = INVALID;

// src/interop/shared-state.ts
var import_path = require("path");
var import_fs = require("fs");

// src/lib/atomic-write.ts
var fs = __toESM(require("fs/promises"), 1);
var fsSync = __toESM(require("fs"), 1);
var path = __toESM(require("path"), 1);
var crypto = __toESM(require("crypto"), 1);
function ensureDirSync(dir) {
  if (fsSync.existsSync(dir)) {
    return;
  }
  try {
    fsSync.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code === "EEXIST") {
      return;
    }
    throw err;
  }
}
async function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.${base}.tmp.${crypto.randomUUID()}`);
  let success = false;
  try {
    ensureDirSync(dir);
    const jsonContent = JSON.stringify(data, null, 2);
    const fd = await fs.open(tempPath, "wx", 384);
    try {
      await fd.write(jsonContent, 0, "utf-8");
      await fd.sync();
    } finally {
      await fd.close();
    }
    await fs.rename(tempPath, filePath);
    success = true;
    try {
      const dirFd = await fs.open(dir, "r");
      try {
        await dirFd.sync();
      } finally {
        await dirFd.close();
      }
    } catch {
    }
  } finally {
    if (!success) {
      await fs.unlink(tempPath).catch(() => {
      });
    }
  }
}
function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.${base}.tmp.${crypto.randomUUID()}`);
  let fd = null;
  let success = false;
  try {
    ensureDirSync(dir);
    fd = fsSync.openSync(tempPath, "wx", 384);
    fsSync.writeSync(fd, content, 0, "utf-8");
    fsSync.fsyncSync(fd);
    fsSync.closeSync(fd);
    fd = null;
    fsSync.renameSync(tempPath, filePath);
    success = true;
    try {
      const dirFd = fsSync.openSync(dir, "r");
      try {
        fsSync.fsyncSync(dirFd);
      } finally {
        fsSync.closeSync(dirFd);
      }
    } catch {
    }
  } finally {
    if (fd !== null) {
      try {
        fsSync.closeSync(fd);
      } catch {
      }
    }
    if (!success) {
      try {
        fsSync.unlinkSync(tempPath);
      } catch {
      }
    }
  }
}
function atomicWriteJsonSync(filePath, data) {
  const jsonContent = JSON.stringify(data, null, 2);
  atomicWriteFileSync(filePath, jsonContent);
}

// src/interop/shared-state.ts
var InteropConfigSchema = external_exports.object({
  sessionId: external_exports.string(),
  createdAt: external_exports.string(),
  omcCwd: external_exports.string(),
  omxCwd: external_exports.string().optional(),
  status: external_exports.enum(["active", "completed", "failed"])
});
var SharedTaskSchema = external_exports.object({
  id: external_exports.string(),
  source: external_exports.enum(["omc", "omx"]),
  target: external_exports.enum(["omc", "omx"]),
  type: external_exports.enum(["analyze", "implement", "review", "test", "custom"]),
  description: external_exports.string(),
  context: external_exports.record(external_exports.unknown()).optional(),
  files: external_exports.array(external_exports.string()).optional(),
  createdAt: external_exports.string(),
  status: external_exports.enum(["pending", "in_progress", "completed", "failed"]),
  result: external_exports.string().optional(),
  error: external_exports.string().optional(),
  completedAt: external_exports.string().optional()
});
var SharedMessageSchema = external_exports.object({
  id: external_exports.string(),
  source: external_exports.enum(["omc", "omx"]),
  target: external_exports.enum(["omc", "omx"]),
  content: external_exports.string(),
  metadata: external_exports.record(external_exports.unknown()).optional(),
  timestamp: external_exports.string(),
  read: external_exports.boolean()
});
function getInteropDir(cwd) {
  return (0, import_path.join)(cwd, ".omc", "state", "interop");
}
function addSharedTask(cwd, task) {
  const interopDir = getInteropDir(cwd);
  const fullTask = {
    ...task,
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    status: "pending"
  };
  const taskPath2 = (0, import_path.join)(interopDir, "tasks", `${fullTask.id}.json`);
  const tasksDir = (0, import_path.join)(interopDir, "tasks");
  if (!(0, import_fs.existsSync)(tasksDir)) {
    (0, import_fs.mkdirSync)(tasksDir, { recursive: true });
  }
  atomicWriteJsonSync(taskPath2, fullTask);
  return fullTask;
}
function readSharedTasks(cwd, filter) {
  const tasksDir = (0, import_path.join)(getInteropDir(cwd), "tasks");
  if (!(0, import_fs.existsSync)(tasksDir)) {
    return [];
  }
  const files = (0, import_fs.readdirSync)(tasksDir).filter((f) => f.endsWith(".json"));
  const tasks = [];
  for (const file of files) {
    try {
      const content = (0, import_fs.readFileSync)((0, import_path.join)(tasksDir, file), "utf-8");
      const parsed = SharedTaskSchema.safeParse(JSON.parse(content));
      if (!parsed.success) continue;
      const task = parsed.data;
      if (filter?.source && task.source !== filter.source) continue;
      if (filter?.target && task.target !== filter.target) continue;
      if (filter?.status && task.status !== filter.status) continue;
      tasks.push(task);
    } catch {
    }
  }
  return tasks.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}
function addSharedMessage(cwd, message) {
  const interopDir = getInteropDir(cwd);
  const fullMessage = {
    ...message,
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    read: false
  };
  const messagePath = (0, import_path.join)(interopDir, "messages", `${fullMessage.id}.json`);
  const messagesDir = (0, import_path.join)(interopDir, "messages");
  if (!(0, import_fs.existsSync)(messagesDir)) {
    (0, import_fs.mkdirSync)(messagesDir, { recursive: true });
  }
  atomicWriteJsonSync(messagePath, fullMessage);
  return fullMessage;
}
function readSharedMessages(cwd, filter) {
  const messagesDir = (0, import_path.join)(getInteropDir(cwd), "messages");
  if (!(0, import_fs.existsSync)(messagesDir)) {
    return [];
  }
  const files = (0, import_fs.readdirSync)(messagesDir).filter((f) => f.endsWith(".json"));
  const messages = [];
  for (const file of files) {
    try {
      const content = (0, import_fs.readFileSync)((0, import_path.join)(messagesDir, file), "utf-8");
      const parsed = SharedMessageSchema.safeParse(JSON.parse(content));
      if (!parsed.success) continue;
      const message = parsed.data;
      if (filter?.source && message.source !== filter.source) continue;
      if (filter?.target && message.target !== filter.target) continue;
      if (filter?.unreadOnly && message.read) continue;
      messages.push(message);
    } catch {
    }
  }
  return messages.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}
function markMessageAsRead(cwd, messageId) {
  const messagePath = (0, import_path.join)(getInteropDir(cwd), "messages", `${messageId}.json`);
  if (!(0, import_fs.existsSync)(messagePath)) {
    return false;
  }
  try {
    const content = (0, import_fs.readFileSync)(messagePath, "utf-8");
    const parsed = SharedMessageSchema.safeParse(JSON.parse(content));
    if (!parsed.success) return false;
    const message = parsed.data;
    message.read = true;
    atomicWriteJsonSync(messagePath, message);
    return true;
  } catch {
    return false;
  }
}

// src/interop/omx-team-state.ts
var import_promises = require("fs/promises");
var import_path2 = require("path");
var import_fs2 = require("fs");
var import_crypto = require("crypto");
var OmxWorkerInfoSchema = external_exports.object({
  name: external_exports.string(),
  index: external_exports.number(),
  role: external_exports.string(),
  assigned_tasks: external_exports.array(external_exports.string()),
  pid: external_exports.number().optional(),
  pane_id: external_exports.string().optional()
});
var OmxTeamManifestV2Schema = external_exports.object({
  schema_version: external_exports.literal(2),
  name: external_exports.string(),
  task: external_exports.string(),
  tmux_session: external_exports.string(),
  worker_count: external_exports.number(),
  workers: external_exports.array(OmxWorkerInfoSchema),
  next_task_id: external_exports.number(),
  created_at: external_exports.string()
}).passthrough();
var OmxTeamConfigSchema = external_exports.object({
  name: external_exports.string(),
  task: external_exports.string(),
  agent_type: external_exports.string(),
  worker_count: external_exports.number(),
  max_workers: external_exports.number(),
  workers: external_exports.array(OmxWorkerInfoSchema),
  created_at: external_exports.string(),
  tmux_session: external_exports.string(),
  next_task_id: external_exports.number()
});
function omxStateDir(cwd) {
  return (0, import_path2.join)(cwd, ".omx", "state");
}
function teamDir(teamName, cwd) {
  return (0, import_path2.join)(omxStateDir(cwd), "team", teamName);
}
function mailboxPath(teamName, workerName2, cwd) {
  return (0, import_path2.join)(teamDir(teamName, cwd), "mailbox", `${workerName2}.json`);
}
function taskFilePath(teamName, taskId, cwd) {
  return (0, import_path2.join)(teamDir(teamName, cwd), "tasks", `task-${taskId}.json`);
}
function eventLogPath(teamName, cwd) {
  return (0, import_path2.join)(teamDir(teamName, cwd), "events", "events.ndjson");
}
async function listOmxTeams(cwd) {
  const teamsRoot = (0, import_path2.join)(omxStateDir(cwd), "team");
  if (!(0, import_fs2.existsSync)(teamsRoot)) return [];
  try {
    const entries = await (0, import_promises.readdir)(teamsRoot, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}
async function readOmxTeamConfig(teamName, cwd) {
  const root = teamDir(teamName, cwd);
  if (!(0, import_fs2.existsSync)(root)) return null;
  const manifestPath = (0, import_path2.join)(root, "manifest.v2.json");
  if ((0, import_fs2.existsSync)(manifestPath)) {
    try {
      const raw = await (0, import_promises.readFile)(manifestPath, "utf8");
      const manifestResult = OmxTeamManifestV2Schema.safeParse(JSON.parse(raw));
      if (manifestResult.success) {
        const manifest = manifestResult.data;
        return {
          name: manifest.name,
          task: manifest.task,
          agent_type: manifest.workers?.[0]?.role ?? "executor",
          worker_count: manifest.worker_count,
          max_workers: 20,
          workers: manifest.workers ?? [],
          created_at: manifest.created_at,
          tmux_session: manifest.tmux_session,
          next_task_id: manifest.next_task_id
        };
      }
    } catch {
    }
  }
  const configPath = (0, import_path2.join)(root, "config.json");
  if (!(0, import_fs2.existsSync)(configPath)) return null;
  try {
    const raw = await (0, import_promises.readFile)(configPath, "utf8");
    const configResult = OmxTeamConfigSchema.safeParse(JSON.parse(raw));
    return configResult.success ? configResult.data : null;
  } catch {
    return null;
  }
}
async function readOmxMailbox(teamName, workerName2, cwd) {
  const p = mailboxPath(teamName, workerName2, cwd);
  try {
    if (!(0, import_fs2.existsSync)(p)) return { worker: workerName2, messages: [] };
    const raw = await (0, import_promises.readFile)(p, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.worker !== workerName2 || !Array.isArray(parsed.messages)) {
      return { worker: workerName2, messages: [] };
    }
    return { worker: workerName2, messages: parsed.messages };
  } catch {
    return { worker: workerName2, messages: [] };
  }
}
async function listOmxMailboxMessages(teamName, workerName2, cwd) {
  const mailbox = await readOmxMailbox(teamName, workerName2, cwd);
  return mailbox.messages;
}
async function sendOmxDirectMessage(teamName, fromWorker, toWorker, body, cwd) {
  const msg = {
    message_id: (0, import_crypto.randomUUID)(),
    from_worker: fromWorker,
    to_worker: toWorker,
    body,
    created_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  const mailbox = await readOmxMailbox(teamName, toWorker, cwd);
  mailbox.messages.push(msg);
  const p = mailboxPath(teamName, toWorker, cwd);
  await atomicWriteJson(p, mailbox);
  await appendOmxTeamEvent(
    teamName,
    {
      type: "message_received",
      worker: toWorker,
      task_id: void 0,
      message_id: msg.message_id,
      reason: void 0
    },
    cwd
  );
  return msg;
}
async function broadcastOmxMessage(teamName, fromWorker, body, cwd) {
  const config = await readOmxTeamConfig(teamName, cwd);
  if (!config) throw new Error(`OMX team ${teamName} not found`);
  const delivered = [];
  for (const w of config.workers) {
    if (w.name === fromWorker) continue;
    delivered.push(await sendOmxDirectMessage(teamName, fromWorker, w.name, body, cwd));
  }
  return delivered;
}
async function readOmxTask(teamName, taskId, cwd) {
  const p = taskFilePath(teamName, taskId, cwd);
  if (!(0, import_fs2.existsSync)(p)) return null;
  try {
    const raw = await (0, import_promises.readFile)(p, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const t = parsed;
    if (typeof t.id !== "string" || typeof t.subject !== "string" || typeof t.status !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
async function listOmxTasks(teamName, cwd) {
  const tasksRoot = (0, import_path2.join)(teamDir(teamName, cwd), "tasks");
  if (!(0, import_fs2.existsSync)(tasksRoot)) return [];
  try {
    const files = await (0, import_promises.readdir)(tasksRoot);
    const tasks = [];
    for (const f of files) {
      const m = /^task-(\d+)\.json$/.exec(f);
      if (!m) continue;
      const task = await readOmxTask(teamName, m[1], cwd);
      if (task) tasks.push(task);
    }
    tasks.sort((a, b) => Number(a.id) - Number(b.id));
    return tasks;
  } catch {
    return [];
  }
}
async function appendOmxTeamEvent(teamName, event, cwd) {
  const full = {
    event_id: (0, import_crypto.randomUUID)(),
    team: teamName,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    ...event
  };
  const p = eventLogPath(teamName, cwd);
  await (0, import_promises.mkdir)((0, import_path2.dirname)(p), { recursive: true });
  await (0, import_promises.appendFile)(p, `${JSON.stringify(full)}
`, "utf8");
  return full;
}

// src/interop/mcp-bridge.ts
function getInteropMode(env = process.env) {
  const raw = (env.OMX_OMC_INTEROP_MODE || "off").toLowerCase();
  if (raw === "observe" || raw === "active") {
    return raw;
  }
  return "off";
}
function canUseOmxDirectWriteBridge(env = process.env) {
  const interopEnabled = env.OMX_OMC_INTEROP_ENABLED === "1";
  const toolsEnabled = env.OMC_INTEROP_TOOLS_ENABLED === "1";
  const mode = getInteropMode(env);
  return interopEnabled && toolsEnabled && mode === "active";
}
var interopSendTaskTool = {
  name: "interop_send_task",
  description: "Send a task to the other tool (OMC -> OMX or OMX -> OMC) for execution. The task will be queued in shared state for the target tool to pick up.",
  schema: {
    target: external_exports.enum(["omc", "omx"]).describe("Target tool to send the task to"),
    type: external_exports.enum(["analyze", "implement", "review", "test", "custom"]).describe("Type of task"),
    description: external_exports.string().describe("Task description"),
    context: external_exports.record(external_exports.string(), external_exports.unknown()).optional().describe("Additional context data"),
    files: external_exports.array(external_exports.string()).optional().describe("List of relevant file paths"),
    workingDirectory: external_exports.string().optional().describe("Working directory (defaults to cwd)")
  },
  handler: async (args) => {
    const { target, type, description, context, files, workingDirectory } = args;
    try {
      const cwd = workingDirectory || process.cwd();
      const source = target === "omc" ? "omx" : "omc";
      const task = addSharedTask(cwd, {
        source,
        target,
        type,
        description,
        context,
        files
      });
      return {
        content: [{
          type: "text",
          text: `## Task Sent to ${target.toUpperCase()}

**Task ID:** ${task.id}
**Type:** ${task.type}
**Description:** ${task.description}
**Status:** ${task.status}
**Created:** ${task.createdAt}

` + (task.files ? `**Files:** ${task.files.join(", ")}

` : "") + `The task has been queued for ${target.toUpperCase()} to pick up.`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error sending task: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};
var interopReadResultsTool = {
  name: "interop_read_results",
  description: "Read task results from the shared interop state. Can filter by source tool and status.",
  schema: {
    source: external_exports.enum(["omc", "omx"]).optional().describe("Filter by source tool"),
    status: external_exports.enum(["pending", "in_progress", "completed", "failed"]).optional().describe("Filter by task status"),
    limit: external_exports.number().optional().describe("Maximum number of tasks to return (default: 10)"),
    workingDirectory: external_exports.string().optional().describe("Working directory (defaults to cwd)")
  },
  handler: async (args) => {
    const { source, status, limit = 10, workingDirectory } = args;
    try {
      const cwd = workingDirectory || process.cwd();
      const tasks = readSharedTasks(cwd, {
        source,
        status
      });
      const limitedTasks = tasks.slice(0, limit);
      if (limitedTasks.length === 0) {
        return {
          content: [{
            type: "text",
            text: "## No Tasks Found\n\nNo tasks match the specified filters."
          }]
        };
      }
      const lines = [
        `## Tasks (${limitedTasks.length}${tasks.length > limit ? ` of ${tasks.length}` : ""})
`
      ];
      for (const task of limitedTasks) {
        const statusIcon = task.status === "completed" ? "\u2713" : task.status === "failed" ? "\u2717" : task.status === "in_progress" ? "\u22EF" : "\u25CB";
        lines.push(`### ${statusIcon} ${task.id}`);
        lines.push(`- **Type:** ${task.type}`);
        lines.push(`- **Source:** ${task.source.toUpperCase()} \u2192 **Target:** ${task.target.toUpperCase()}`);
        lines.push(`- **Status:** ${task.status}`);
        lines.push(`- **Description:** ${task.description}`);
        lines.push(`- **Created:** ${task.createdAt}`);
        if (task.files && task.files.length > 0) {
          lines.push(`- **Files:** ${task.files.join(", ")}`);
        }
        if (task.result) {
          lines.push(`- **Result:** ${task.result.slice(0, 200)}${task.result.length > 200 ? "..." : ""}`);
        }
        if (task.error) {
          lines.push(`- **Error:** ${task.error}`);
        }
        if (task.completedAt) {
          lines.push(`- **Completed:** ${task.completedAt}`);
        }
        lines.push("");
      }
      return {
        content: [{
          type: "text",
          text: lines.join("\n")
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error reading tasks: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};
var interopSendMessageTool = {
  name: "interop_send_message",
  description: "Send a message to the other tool for informational purposes or coordination.",
  schema: {
    target: external_exports.enum(["omc", "omx"]).describe("Target tool to send the message to"),
    content: external_exports.string().describe("Message content"),
    metadata: external_exports.record(external_exports.string(), external_exports.unknown()).optional().describe("Additional metadata"),
    workingDirectory: external_exports.string().optional().describe("Working directory (defaults to cwd)")
  },
  handler: async (args) => {
    const { target, content, metadata, workingDirectory } = args;
    try {
      const cwd = workingDirectory || process.cwd();
      const source = target === "omc" ? "omx" : "omc";
      const message = addSharedMessage(cwd, {
        source,
        target,
        content,
        metadata
      });
      return {
        content: [{
          type: "text",
          text: `## Message Sent to ${target.toUpperCase()}

**Message ID:** ${message.id}
**Content:** ${message.content}
**Timestamp:** ${message.timestamp}

The message has been queued for ${target.toUpperCase()}.`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error sending message: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};
var interopReadMessagesTool = {
  name: "interop_read_messages",
  description: "Read messages from the shared interop state. Can filter by source tool and read status.",
  schema: {
    source: external_exports.enum(["omc", "omx"]).optional().describe("Filter by source tool"),
    unreadOnly: external_exports.boolean().optional().describe("Show only unread messages (default: false)"),
    limit: external_exports.number().optional().describe("Maximum number of messages to return (default: 10)"),
    markAsRead: external_exports.boolean().optional().describe("Mark retrieved messages as read (default: false)"),
    workingDirectory: external_exports.string().optional().describe("Working directory (defaults to cwd)")
  },
  handler: async (args) => {
    const { source, unreadOnly = false, limit = 10, markAsRead = false, workingDirectory } = args;
    try {
      const cwd = workingDirectory || process.cwd();
      const messages = readSharedMessages(cwd, {
        source,
        unreadOnly
      });
      const limitedMessages = messages.slice(0, limit);
      if (limitedMessages.length === 0) {
        return {
          content: [{
            type: "text",
            text: "## No Messages Found\n\nNo messages match the specified filters."
          }]
        };
      }
      if (markAsRead) {
        for (const message of limitedMessages) {
          markMessageAsRead(cwd, message.id);
        }
      }
      const lines = [
        `## Messages (${limitedMessages.length}${messages.length > limit ? ` of ${messages.length}` : ""})
`
      ];
      for (const message of limitedMessages) {
        const readIcon = message.read ? "\u2713" : "\u25CB";
        lines.push(`### ${readIcon} ${message.id}`);
        lines.push(`- **From:** ${message.source.toUpperCase()} \u2192 **To:** ${message.target.toUpperCase()}`);
        lines.push(`- **Content:** ${message.content}`);
        lines.push(`- **Timestamp:** ${message.timestamp}`);
        lines.push(`- **Read:** ${message.read ? "Yes" : "No"}`);
        if (message.metadata) {
          lines.push(`- **Metadata:** ${JSON.stringify(message.metadata)}`);
        }
        lines.push("");
      }
      if (markAsRead) {
        lines.push(`
*${limitedMessages.length} message(s) marked as read*`);
      }
      return {
        content: [{
          type: "text",
          text: lines.join("\n")
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error reading messages: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};
var interopListOmxTeamsTool = {
  name: "interop_list_omx_teams",
  description: "List active OMX (oh-my-codex) teams from .omx/state/team/. Shows team names and basic configuration.",
  schema: {
    workingDirectory: external_exports.string().optional().describe("Working directory (defaults to cwd)")
  },
  handler: async (args) => {
    try {
      const cwd = args.workingDirectory || process.cwd();
      const teamNames = await listOmxTeams(cwd);
      if (teamNames.length === 0) {
        return {
          content: [{
            type: "text",
            text: "## No OMX Teams Found\n\nNo active OMX teams detected in .omx/state/team/."
          }]
        };
      }
      const lines = [`## OMX Teams (${teamNames.length})
`];
      for (const name of teamNames) {
        const config = await readOmxTeamConfig(name, cwd);
        if (config) {
          lines.push(`### ${name}`);
          lines.push(`- **Task:** ${config.task}`);
          lines.push(`- **Workers:** ${config.worker_count} (${config.agent_type})`);
          lines.push(`- **Created:** ${config.created_at}`);
          lines.push(`- **Workers:** ${config.workers.map((w) => w.name).join(", ")}`);
          lines.push("");
        } else {
          lines.push(`### ${name} (config not readable)
`);
        }
      }
      return {
        content: [{
          type: "text",
          text: lines.join("\n")
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error listing OMX teams: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};
var interopSendOmxMessageTool = {
  name: "interop_send_omx_message",
  description: "Send a message to an OMX team worker mailbox using the native omx format. Supports direct messages and broadcasts.",
  schema: {
    teamName: external_exports.string().describe("OMX team name"),
    fromWorker: external_exports.string().describe('Sender worker name (e.g., "omc-bridge")'),
    toWorker: external_exports.string().describe("Target worker name (ignored if broadcast=true)"),
    body: external_exports.string().describe("Message body"),
    broadcast: external_exports.boolean().optional().describe("Broadcast to all workers (default: false)"),
    workingDirectory: external_exports.string().optional().describe("Working directory (defaults to cwd)")
  },
  handler: async (args) => {
    try {
      if (!canUseOmxDirectWriteBridge()) {
        return {
          content: [{
            type: "text",
            text: "Direct OMX mailbox writes are disabled. Use broker-mediated team_* MCP path or enable active interop flags explicitly."
          }],
          isError: true
        };
      }
      const cwd = args.workingDirectory || process.cwd();
      if (args.broadcast) {
        const messages = await broadcastOmxMessage(args.teamName, args.fromWorker, args.body, cwd);
        return {
          content: [{
            type: "text",
            text: `## Broadcast Sent to OMX Team: ${args.teamName}

**From:** ${args.fromWorker}
**Recipients:** ${messages.length}
**Message IDs:** ${messages.map((m) => m.message_id).join(", ")}

Message delivered to ${messages.length} worker mailbox(es).`
          }]
        };
      }
      const msg = await sendOmxDirectMessage(args.teamName, args.fromWorker, args.toWorker, args.body, cwd);
      return {
        content: [{
          type: "text",
          text: `## Message Sent to OMX Worker

**Team:** ${args.teamName}
**From:** ${msg.from_worker}
**To:** ${msg.to_worker}
**Message ID:** ${msg.message_id}
**Created:** ${msg.created_at}

Message delivered to ${msg.to_worker}'s mailbox.`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error sending OMX message: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};
var interopReadOmxMessagesTool = {
  name: "interop_read_omx_messages",
  description: "Read messages from an OMX team worker mailbox.",
  schema: {
    teamName: external_exports.string().describe("OMX team name"),
    workerName: external_exports.string().describe("Worker name whose mailbox to read"),
    limit: external_exports.number().optional().describe("Maximum number of messages to return (default: 20)"),
    workingDirectory: external_exports.string().optional().describe("Working directory (defaults to cwd)")
  },
  handler: async (args) => {
    try {
      const cwd = args.workingDirectory || process.cwd();
      const limit = args.limit ?? 20;
      const messages = await listOmxMailboxMessages(args.teamName, args.workerName, cwd);
      if (messages.length === 0) {
        return {
          content: [{
            type: "text",
            text: `## No Messages

No messages in ${args.workerName}'s mailbox for team ${args.teamName}.`
          }]
        };
      }
      const limited = messages.slice(-limit);
      const lines = [
        `## OMX Mailbox: ${args.workerName} @ ${args.teamName} (${limited.length}${messages.length > limit ? ` of ${messages.length}` : ""})
`
      ];
      for (const msg of limited) {
        const deliveredIcon = msg.delivered_at ? "\u2713" : "\u25CB";
        lines.push(`### ${deliveredIcon} ${msg.message_id}`);
        lines.push(`- **From:** ${msg.from_worker}`);
        lines.push(`- **To:** ${msg.to_worker}`);
        lines.push(`- **Body:** ${msg.body.slice(0, 300)}${msg.body.length > 300 ? "..." : ""}`);
        lines.push(`- **Created:** ${msg.created_at}`);
        if (msg.delivered_at) lines.push(`- **Delivered:** ${msg.delivered_at}`);
        lines.push("");
      }
      return {
        content: [{
          type: "text",
          text: lines.join("\n")
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error reading OMX messages: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};
var interopReadOmxTasksTool = {
  name: "interop_read_omx_tasks",
  description: "Read tasks from an OMX team. Can filter by status.",
  schema: {
    teamName: external_exports.string().describe("OMX team name"),
    status: external_exports.enum(["pending", "blocked", "in_progress", "completed", "failed"]).optional().describe("Filter by task status"),
    limit: external_exports.number().optional().describe("Maximum number of tasks to return (default: 20)"),
    workingDirectory: external_exports.string().optional().describe("Working directory (defaults to cwd)")
  },
  handler: async (args) => {
    try {
      const cwd = args.workingDirectory || process.cwd();
      const limit = args.limit ?? 20;
      let tasks = await listOmxTasks(args.teamName, cwd);
      if (args.status) {
        tasks = tasks.filter((t) => t.status === args.status);
      }
      if (tasks.length === 0) {
        return {
          content: [{
            type: "text",
            text: `## No Tasks

No tasks found for OMX team ${args.teamName}${args.status ? ` with status "${args.status}"` : ""}.`
          }]
        };
      }
      const limited = tasks.slice(0, limit);
      const lines = [
        `## OMX Tasks: ${args.teamName} (${limited.length}${tasks.length > limit ? ` of ${tasks.length}` : ""})
`
      ];
      for (const task of limited) {
        const statusIcon = task.status === "completed" ? "\u2713" : task.status === "failed" ? "\u2717" : task.status === "in_progress" ? "\u22EF" : task.status === "blocked" ? "\u2298" : "\u25CB";
        lines.push(`### ${statusIcon} Task ${task.id}: ${task.subject}`);
        lines.push(`- **Status:** ${task.status}`);
        if (task.owner) lines.push(`- **Owner:** ${task.owner}`);
        lines.push(`- **Description:** ${task.description.slice(0, 200)}${task.description.length > 200 ? "..." : ""}`);
        lines.push(`- **Created:** ${task.created_at}`);
        if (task.result) lines.push(`- **Result:** ${task.result.slice(0, 200)}${task.result.length > 200 ? "..." : ""}`);
        if (task.error) lines.push(`- **Error:** ${task.error}`);
        if (task.completed_at) lines.push(`- **Completed:** ${task.completed_at}`);
        lines.push("");
      }
      return {
        content: [{
          type: "text",
          text: lines.join("\n")
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error reading OMX tasks: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};

// src/interop/worker-adapter.ts
var import_path6 = require("path");
var import_promises3 = require("fs/promises");
var import_crypto2 = require("crypto");

// src/team/worker-bootstrap.ts
var import_promises2 = require("fs/promises");
var import_path5 = require("path");

// src/agents/prompt-helpers.ts
var import_fs4 = require("fs");
var import_path4 = require("path");
var import_url2 = require("url");

// src/agents/utils.ts
var import_fs3 = require("fs");
var import_path3 = require("path");
var import_url = require("url");

// src/agents/prompt-helpers.ts
var import_meta = {};
function getPackageDir() {
  try {
    if (import_meta?.url) {
      const __filename = (0, import_url2.fileURLToPath)(import_meta.url);
      const __dirname2 = (0, import_path4.dirname)(__filename);
      return (0, import_path4.join)(__dirname2, "..", "..");
    }
  } catch {
  }
  if (typeof __dirname !== "undefined") {
    return (0, import_path4.join)(__dirname, "..");
  }
  return process.cwd();
}
var _cachedRoles = null;
function getValidAgentRoles() {
  if (_cachedRoles) return _cachedRoles;
  try {
    if (typeof __AGENT_ROLES__ !== "undefined" && Array.isArray(__AGENT_ROLES__) && __AGENT_ROLES__.length > 0) {
      _cachedRoles = __AGENT_ROLES__;
      return _cachedRoles;
    }
  } catch {
  }
  try {
    const agentsDir = (0, import_path4.join)(getPackageDir(), "agents");
    const files = (0, import_fs4.readdirSync)(agentsDir);
    _cachedRoles = files.filter((f) => f.endsWith(".md")).map((f) => (0, import_path4.basename)(f, ".md")).sort();
  } catch (err) {
    console.error("[prompt-injection] CRITICAL: Could not scan agents/ directory for role discovery:", err);
    _cachedRoles = [];
  }
  return _cachedRoles;
}
var VALID_AGENT_ROLES = getValidAgentRoles();
function sanitizePromptContent(content, maxLength = 4e3) {
  if (!content) return "";
  let sanitized = content.length > maxLength ? content.slice(0, maxLength) : content;
  if (sanitized.length > 0) {
    const lastCode = sanitized.charCodeAt(sanitized.length - 1);
    if (lastCode >= 55296 && lastCode <= 56319) {
      sanitized = sanitized.slice(0, -1);
    }
  }
  sanitized = sanitized.replace(/<(\/?)(TASK_SUBJECT)[^>]*>/gi, "[$1$2]");
  sanitized = sanitized.replace(/<(\/?)(TASK_DESCRIPTION)[^>]*>/gi, "[$1$2]");
  sanitized = sanitized.replace(/<(\/?)(INBOX_MESSAGE)[^>]*>/gi, "[$1$2]");
  sanitized = sanitized.replace(/<(\/?)(INSTRUCTIONS)[^>]*>/gi, "[$1$2]");
  sanitized = sanitized.replace(/<(\/?)(SYSTEM)[^>]*>/gi, "[$1$2]");
  return sanitized;
}

// src/team/model-contract.ts
var import_child_process2 = require("child_process");

// src/team/shell-path.ts
var import_child_process = require("child_process");
var _resolved = null;
function resolveShellPath() {
  if (_resolved !== null) return _resolved;
  if (process.platform === "win32") {
    _resolved = process.env.PATH || "";
    return _resolved;
  }
  try {
    const shell = process.env.SHELL || "/bin/sh";
    const result = (0, import_child_process.spawnSync)(shell, ["-ilc", "env"], {
      timeout: 5e3,
      stdio: ["pipe", "pipe", "pipe"]
    });
    if (result.status === 0) {
      const stdout = result.stdout?.toString() ?? "";
      const pathLine = stdout.split("\n").find((l) => l.startsWith("PATH="));
      const path2 = pathLine?.slice(5)?.trim();
      if (path2) {
        _resolved = path2;
        return _resolved;
      }
    }
  } catch {
  }
  _resolved = process.env.PATH || "";
  return _resolved;
}
function resolvedEnv(extra) {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  env[pathKey] = resolveShellPath();
  return { ...env, ...extra };
}

// src/team/team-name.ts
var TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
function validateTeamName(teamName) {
  if (!TEAM_NAME_PATTERN.test(teamName)) {
    throw new Error(
      `Invalid team name: "${teamName}". Team name must match /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.`
    );
  }
  return teamName;
}

// src/team/model-contract.ts
var CONTRACTS = {
  claude: {
    agentType: "claude",
    binary: "claude",
    installInstructions: "Install Claude CLI: https://claude.ai/download",
    buildLaunchArgs(model, extraFlags = []) {
      const args = ["--dangerously-skip-permissions"];
      if (model) args.push("--model", model);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput) {
      return rawOutput.trim();
    }
  },
  codex: {
    agentType: "codex",
    binary: "codex",
    installInstructions: "Install Codex CLI: npm install -g @openai/codex",
    supportsPromptMode: true,
    // Codex accepts prompt as a positional argument (no flag needed):
    //   codex [OPTIONS] [PROMPT]
    buildLaunchArgs(model, extraFlags = []) {
      const args = ["--dangerously-bypass-approvals-and-sandbox"];
      if (model) args.push("--model", model);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput) {
      const lines = rawOutput.trim().split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed.type === "message" && parsed.role === "assistant") {
            return parsed.content ?? rawOutput;
          }
          if (parsed.type === "result" || parsed.output) {
            return parsed.output ?? parsed.result ?? rawOutput;
          }
        } catch {
        }
      }
      return rawOutput.trim();
    }
  },
  gemini: {
    agentType: "gemini",
    binary: "gemini",
    installInstructions: "Install Gemini CLI: npm install -g @google/gemini-cli",
    supportsPromptMode: true,
    promptModeFlag: "-p",
    buildLaunchArgs(model, extraFlags = []) {
      const args = ["--yolo"];
      const effectiveModel = model || "gemini-2.5-pro";
      args.push("--model", effectiveModel);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput) {
      return rawOutput.trim();
    }
  }
};
function getContract(agentType) {
  const contract = CONTRACTS[agentType];
  if (!contract) {
    throw new Error(`Unknown agent type: ${agentType}. Supported: ${Object.keys(CONTRACTS).join(", ")}`);
  }
  return contract;
}
function isCliAvailable(agentType) {
  const contract = getContract(agentType);
  try {
    const result = (0, import_child_process2.spawnSync)(contract.binary, ["--version"], {
      timeout: 5e3,
      shell: true,
      env: resolvedEnv()
    });
    return result.status === 0;
  } catch {
    return false;
  }
}
function validateCliAvailable(agentType) {
  if (!isCliAvailable(agentType)) {
    const contract = getContract(agentType);
    throw new Error(
      `CLI agent '${agentType}' not found. ${contract.installInstructions}`
    );
  }
}
function buildLaunchArgs(agentType, config) {
  return getContract(agentType).buildLaunchArgs(config.model, config.extraFlags);
}
function buildWorkerArgv(agentType, config) {
  validateTeamName(config.teamName);
  const contract = getContract(agentType);
  const args = buildLaunchArgs(agentType, config);
  return [contract.binary, ...args];
}
function getWorkerEnv(teamName, workerName2, agentType) {
  validateTeamName(teamName);
  return {
    OMC_TEAM_WORKER: `${teamName}/${workerName2}`,
    OMC_TEAM_NAME: teamName,
    OMC_WORKER_AGENT_TYPE: agentType
  };
}
function isPromptModeAgent(agentType) {
  const contract = getContract(agentType);
  return !!contract.supportsPromptMode;
}
function getPromptModeArgs(agentType, instruction) {
  const contract = getContract(agentType);
  if (!contract.supportsPromptMode) {
    return [];
  }
  if (contract.promptModeFlag) {
    return [contract.promptModeFlag, instruction];
  }
  return [instruction];
}

// src/team/worker-bootstrap.ts
function generateWorkerOverlay(params) {
  const { teamName, workerName: workerName2, agentType, tasks, bootstrapInstructions } = params;
  const sanitizedTasks = tasks.map((t) => ({
    id: t.id,
    subject: sanitizePromptContent(t.subject),
    description: sanitizePromptContent(t.description)
  }));
  const sentinelPath = `.omc/state/team/${teamName}/workers/${workerName2}/.ready`;
  const heartbeatPath = `.omc/state/team/${teamName}/workers/${workerName2}/heartbeat.json`;
  const inboxPath = `.omc/state/team/${teamName}/workers/${workerName2}/inbox.md`;
  const taskDir = `.omc/state/team/${teamName}/tasks`;
  const donePath = `.omc/state/team/${teamName}/workers/${workerName2}/done.json`;
  const taskList = sanitizedTasks.length > 0 ? sanitizedTasks.map((t) => `- **Task ${t.id}**: ${t.subject}`).join("\n") : "- No tasks assigned yet. Check your inbox for assignments.";
  return `# Team Worker Protocol

## FIRST ACTION REQUIRED
Before doing anything else, write your ready sentinel file:
\`\`\`bash
mkdir -p $(dirname ${sentinelPath}) && touch ${sentinelPath}
\`\`\`

## Identity
- **Team**: ${teamName}
- **Worker**: ${workerName2}
- **Agent Type**: ${agentType}
- **Environment**: OMC_TEAM_WORKER=${teamName}/${workerName2}

## Your Tasks
${taskList}

## Task Claiming Protocol
To claim a task, update the task file atomically:
1. Read task from: ${taskDir}/{taskId}.json
2. Update status to "in_progress", set owner to "${workerName2}"
3. Write back to task file
4. Do the work
5. Update status to "completed", write result to task file

## Communication Protocol
- **Inbox**: Read ${inboxPath} for new instructions
- **Heartbeat**: Update ${heartbeatPath} every few minutes:
  \`\`\`json
  {"workerName":"${workerName2}","status":"working","updatedAt":"<ISO timestamp>","currentTaskId":"<id or null>"}
  \`\`\`

## Task Completion Protocol
When you finish a task (success or failure), write a done signal using a bash command (do NOT use a file-write tool):
\`\`\`bash
mkdir -p $(dirname ${donePath}) && echo '{"taskId":"<id>","status":"completed","summary":"done","completedAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > ${donePath}
\`\`\`
- For failures, replace "completed" with "failed" and "done" with "failed".
- Use "completed" or "failed" only for status. Use "done" or "failed" only for summary.

## Shutdown Protocol
When you see a shutdown request (check .omc/state/team/${teamName}/shutdown.json):
1. Finish your current task if close to completion
2. Write an ACK file: .omc/state/team/${teamName}/workers/${workerName2}/shutdown-ack.json
3. Exit

${bootstrapInstructions ? `## Additional Instructions
${bootstrapInstructions}
` : ""}`;
}
async function composeInitialInbox(teamName, workerName2, content, cwd) {
  const inboxPath = (0, import_path5.join)(cwd, `.omc/state/team/${teamName}/workers/${workerName2}/inbox.md`);
  await (0, import_promises2.mkdir)((0, import_path5.dirname)(inboxPath), { recursive: true });
  await (0, import_promises2.writeFile)(inboxPath, content, "utf-8");
}
async function ensureWorkerStateDir(teamName, workerName2, cwd) {
  const workerDir = (0, import_path5.join)(cwd, `.omc/state/team/${teamName}/workers/${workerName2}`);
  await (0, import_promises2.mkdir)(workerDir, { recursive: true });
  const mailboxDir = (0, import_path5.join)(cwd, `.omc/state/team/${teamName}/mailbox`);
  await (0, import_promises2.mkdir)(mailboxDir, { recursive: true });
  const tasksDir = (0, import_path5.join)(cwd, `.omc/state/team/${teamName}/tasks`);
  await (0, import_promises2.mkdir)(tasksDir, { recursive: true });
}
async function writeWorkerOverlay(params) {
  const { teamName, workerName: workerName2, cwd } = params;
  const overlay = generateWorkerOverlay(params);
  const overlayPath = (0, import_path5.join)(cwd, `.omc/state/team/${teamName}/workers/${workerName2}/AGENTS.md`);
  await (0, import_promises2.mkdir)((0, import_path5.dirname)(overlayPath), { recursive: true });
  await (0, import_promises2.writeFile)(overlayPath, overlay, "utf-8");
  return overlayPath;
}

// src/interop/worker-adapter.ts
async function bridgeBootstrapToOmx(ctx, workerName2, task) {
  if (ctx.interopMode !== "active") return;
  const message = {
    message_id: (0, import_crypto2.randomUUID)(),
    from_worker: "omc-lead",
    to_worker: workerName2,
    body: `## Task Assignment
Task ID: ${task.id}
Subject: ${task.subject}

${task.description}`,
    created_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  const mailboxPath2 = (0, import_path6.join)(
    ctx.cwd,
    ".omx",
    "state",
    "team",
    ctx.teamName,
    "mailbox",
    `${workerName2}.json`
  );
  await (0, import_promises3.mkdir)((0, import_path6.dirname)(mailboxPath2), { recursive: true });
  await atomicWriteJson(mailboxPath2, { worker: workerName2, messages: [message] });
}
async function pollOmxCompletion(ctx, workerName2, taskId) {
  const task = await readOmxTask(ctx.teamName, taskId, ctx.cwd);
  if (!task) return null;
  if (task.status === "completed" || task.status === "failed") {
    const signal = {
      taskId: task.id,
      status: task.status,
      summary: task.result ?? task.error ?? `Task ${task.status}`,
      completedAt: task.completed_at ?? (/* @__PURE__ */ new Date()).toISOString()
    };
    const donePath = (0, import_path6.join)(
      ctx.cwd,
      ".omc",
      "state",
      "team",
      ctx.teamName,
      "workers",
      workerName2,
      "done.json"
    );
    await (0, import_promises3.mkdir)((0, import_path6.dirname)(donePath), { recursive: true });
    await atomicWriteJson(donePath, signal);
    return signal;
  }
  return null;
}

// src/team/tmux-session.ts
var import_child_process3 = require("child_process");
var import_path7 = require("path");
var import_util4 = require("util");
var import_promises4 = __toESM(require("fs/promises"), 1);
var TMUX_SESSION_PREFIX = "omc-team";
var promisifiedExec = (0, import_util4.promisify)(import_child_process3.exec);
var promisifiedExecFile = (0, import_util4.promisify)(import_child_process3.execFile);
function isUnixLikeOnWindows() {
  return process.platform === "win32" && !!(process.env.MSYSTEM || process.env.MINGW_PREFIX);
}
async function tmuxAsync(args) {
  if (args.some((a) => a.includes("#{"))) {
    const escaped = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
    return promisifiedExec(`tmux ${escaped}`);
  }
  return promisifiedExecFile("tmux", args);
}
function getDefaultShell() {
  if (process.platform === "win32" && !isUnixLikeOnWindows()) {
    return process.env.COMSPEC || "cmd.exe";
  }
  return process.env.SHELL || "/bin/bash";
}
function escapeForCmdSet(value) {
  return value.replace(/"/g, '""');
}
function shellNameFromPath(shellPath) {
  const shellName = (0, import_path7.basename)(shellPath.replace(/\\/g, "/"));
  return shellName.replace(/\.(exe|cmd|bat)$/i, "");
}
function shellEscape(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function assertSafeEnvKey(key) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment key: "${key}"`);
  }
}
function getLaunchWords(config) {
  if (config.launchBinary) {
    return [config.launchBinary, ...config.launchArgs ?? []];
  }
  if (config.launchCmd) {
    return [config.launchCmd];
  }
  throw new Error("Missing worker launch command. Provide launchBinary or launchCmd.");
}
function buildWorkerStartCommand(config) {
  const shell = getDefaultShell();
  const launchWords = getLaunchWords(config);
  if (process.platform === "win32" && !isUnixLikeOnWindows()) {
    const envPrefix = Object.entries(config.envVars).map(([k, v]) => {
      assertSafeEnvKey(k);
      return `set "${k}=${escapeForCmdSet(v)}"`;
    }).join(" && ");
    const launch = config.launchBinary ? launchWords.map((part) => `"${escapeForCmdSet(part)}"`).join(" ") : launchWords[0];
    const cmdBody = envPrefix ? `${envPrefix} && ${launch}` : launch;
    return `${shell} /d /s /c "${cmdBody}"`;
  }
  if (config.launchBinary) {
    const envAssignments = Object.entries(config.envVars).map(([key, value]) => {
      assertSafeEnvKey(key);
      return `${key}=${shellEscape(value)}`;
    });
    const shellName2 = shellNameFromPath(shell) || "bash";
    const rcFile2 = process.env.HOME ? `${process.env.HOME}/.${shellName2}rc` : "";
    const script = rcFile2 ? `[ -f ${shellEscape(rcFile2)} ] && . ${shellEscape(rcFile2)}; exec "$@"` : 'exec "$@"';
    return [
      "env",
      ...envAssignments,
      shell,
      "-lc",
      script,
      "--",
      ...launchWords
    ].map(shellEscape).join(" ");
  }
  const envString = Object.entries(config.envVars).map(([k, v]) => {
    assertSafeEnvKey(k);
    return `${k}=${shellEscape(v)}`;
  }).join(" ");
  const shellName = shellNameFromPath(shell) || "bash";
  const rcFile = process.env.HOME ? `${process.env.HOME}/.${shellName}rc` : "";
  const sourceCmd = rcFile ? `[ -f "${rcFile}" ] && source "${rcFile}"; ` : "";
  return `env ${envString} ${shell} -c "${sourceCmd}exec ${launchWords[0]}"`;
}
function validateTmux() {
  try {
    (0, import_child_process3.execSync)("tmux -V", { encoding: "utf-8", timeout: 5e3, stdio: "pipe" });
  } catch {
    throw new Error(
      "tmux is not available. Install it:\n  macOS: brew install tmux\n  Ubuntu/Debian: sudo apt-get install tmux\n  Fedora: sudo dnf install tmux\n  Arch: sudo pacman -S tmux"
    );
  }
}
function sanitizeName(name) {
  const sanitized = name.replace(/[^a-zA-Z0-9-]/g, "");
  if (sanitized.length === 0) {
    throw new Error(`Invalid name: "${name}" contains no valid characters (alphanumeric or hyphen)`);
  }
  if (sanitized.length < 2) {
    throw new Error(`Invalid name: "${name}" too short after sanitization (minimum 2 characters)`);
  }
  return sanitized.slice(0, 50);
}
async function createTeamSession(teamName, workerCount, cwd) {
  const { execFile: execFile2 } = await import("child_process");
  const { promisify: promisify2 } = await import("util");
  const execFileAsync = promisify2(execFile2);
  let sessionAndWindow = "";
  let leaderPaneId = "";
  if (!process.env.TMUX) {
    validateTmux();
    const sName = `${TMUX_SESSION_PREFIX}-${sanitizeName(teamName)}`;
    try {
      (0, import_child_process3.execFileSync)("tmux", ["kill-session", "-t", sName], { stdio: "pipe", timeout: 5e3 });
    } catch {
    }
    const newArgs = ["new-session", "-d", "-s", sName, "-x", "200", "-y", "50"];
    if (cwd) newArgs.push("-c", cwd);
    (0, import_child_process3.execFileSync)("tmux", newArgs, { stdio: "pipe", timeout: 5e3 });
    const paneResult = await tmuxAsync([
      "display-message",
      "-t",
      sName,
      "-p",
      "#{pane_id}"
    ]);
    leaderPaneId = paneResult.stdout.trim();
    if (!leaderPaneId || !/^%\d+$/.test(leaderPaneId)) {
      throw new Error(`Failed to resolve pane ID for auto-created tmux session "${sName}"`);
    }
    sessionAndWindow = sName;
  } else {
    const envPaneIdRaw = (process.env.TMUX_PANE ?? "").trim();
    const envPaneId = /^%\d+$/.test(envPaneIdRaw) ? envPaneIdRaw : "";
    leaderPaneId = envPaneId;
    if (envPaneId) {
      try {
        const targetedContextResult = await execFileAsync("tmux", [
          "display-message",
          "-p",
          "-t",
          envPaneId,
          "#S:#I"
        ]);
        sessionAndWindow = targetedContextResult.stdout.trim();
      } catch {
        sessionAndWindow = "";
        leaderPaneId = "";
      }
    }
    if (!sessionAndWindow || !leaderPaneId) {
      const contextResult = await tmuxAsync([
        "display-message",
        "-p",
        "#S:#I #{pane_id}"
      ]);
      const contextLine = contextResult.stdout.trim();
      const contextMatch = contextLine.match(/^(\S+)\s+(%\d+)$/);
      if (!contextMatch) {
        throw new Error(`Failed to resolve tmux context: "${contextLine}"`);
      }
      sessionAndWindow = contextMatch[1];
      leaderPaneId = contextMatch[2];
    }
  }
  const teamTarget = sessionAndWindow;
  const resolvedSessionName = teamTarget.split(":")[0];
  const workerPaneIds = [];
  if (workerCount <= 0) {
    try {
      await execFileAsync("tmux", ["set-option", "-t", resolvedSessionName, "mouse", "on"]);
    } catch {
    }
    try {
      await execFileAsync("tmux", ["select-pane", "-t", leaderPaneId]);
    } catch {
    }
    await new Promise((r) => setTimeout(r, 300));
    return { sessionName: teamTarget, leaderPaneId, workerPaneIds };
  }
  for (let i = 0; i < workerCount; i++) {
    const splitTarget = i === 0 ? leaderPaneId : workerPaneIds[i - 1];
    const splitType = i === 0 ? "-h" : "-v";
    const splitResult = await tmuxAsync([
      "split-window",
      splitType,
      "-t",
      splitTarget,
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-c",
      cwd
    ]);
    const paneId = splitResult.stdout.split("\n")[0]?.trim();
    if (paneId) {
      workerPaneIds.push(paneId);
    }
  }
  try {
    await execFileAsync("tmux", ["select-layout", "-t", teamTarget, "main-vertical"]);
  } catch {
  }
  try {
    const widthResult = await tmuxAsync([
      "display-message",
      "-p",
      "-t",
      teamTarget,
      "#{window_width}"
    ]);
    const width = parseInt(widthResult.stdout.trim(), 10);
    if (Number.isFinite(width) && width >= 40) {
      const half = String(Math.floor(width / 2));
      await execFileAsync("tmux", ["set-window-option", "-t", teamTarget, "main-pane-width", half]);
      await execFileAsync("tmux", ["select-layout", "-t", teamTarget, "main-vertical"]);
    }
  } catch {
  }
  try {
    await execFileAsync("tmux", ["set-option", "-t", resolvedSessionName, "mouse", "on"]);
  } catch {
  }
  try {
    await execFileAsync("tmux", ["select-pane", "-t", leaderPaneId]);
  } catch {
  }
  await new Promise((r) => setTimeout(r, 300));
  return { sessionName: teamTarget, leaderPaneId, workerPaneIds };
}
async function spawnWorkerInPane(sessionName, paneId, config) {
  const { execFile: execFile2 } = await import("child_process");
  const { promisify: promisify2 } = await import("util");
  const execFileAsync = promisify2(execFile2);
  validateTeamName(config.teamName);
  const startCmd = buildWorkerStartCommand(config);
  await execFileAsync("tmux", [
    "send-keys",
    "-t",
    paneId,
    "-l",
    startCmd
  ]);
  await execFileAsync("tmux", ["send-keys", "-t", paneId, "Enter"]);
}
function normalizeTmuxCapture(value) {
  return value.replace(/\r/g, "").replace(/\s+/g, " ").trim();
}
async function capturePaneAsync(paneId, execFileAsync) {
  try {
    const result = await execFileAsync("tmux", ["capture-pane", "-t", paneId, "-p", "-S", "-80"]);
    return result.stdout;
  } catch {
    return "";
  }
}
function paneHasTrustPrompt(captured) {
  const lines = captured.split("\n").map((l) => l.replace(/\r/g, "").trim()).filter((l) => l.length > 0);
  const tail = lines.slice(-12);
  const hasQuestion = tail.some((l) => /Do you trust the contents of this directory\?/i.test(l));
  const hasChoices = tail.some((l) => /Yes,\s*continue|No,\s*quit|Press enter to continue/i.test(l));
  return hasQuestion && hasChoices;
}
function paneHasActiveTask(captured) {
  const lines = captured.split("\n").map((l) => l.replace(/\r/g, "").trim()).filter((l) => l.length > 0);
  const tail = lines.slice(-40);
  if (tail.some((l) => /esc to interrupt/i.test(l))) return true;
  if (tail.some((l) => /\bbackground terminal running\b/i.test(l))) return true;
  return false;
}
function paneLooksReady(captured) {
  const lines = captured.split("\n").map((line) => line.replace(/\r/g, "").trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  const tail = lines.slice(-20);
  const hasPrompt = tail.some((line) => /^\s*[›>❯]\s*/u.test(line));
  if (hasPrompt) return true;
  const hasCodexHint = tail.some(
    (line) => /\bgpt-[\w.-]+\b/i.test(line) || /\b\d+% left\b/i.test(line)
  );
  return hasCodexHint;
}
function paneTailContainsLiteralLine(captured, text) {
  return normalizeTmuxCapture(captured).includes(normalizeTmuxCapture(text));
}
async function paneInCopyMode(paneId, execFileAsync) {
  try {
    const result = await tmuxAsync(["display-message", "-t", paneId, "-p", "#{pane_in_mode}"]);
    return result.stdout.trim() === "1";
  } catch {
    return false;
  }
}
function shouldAttemptAdaptiveRetry(args) {
  if (process.env.OMX_TEAM_AUTO_INTERRUPT_RETRY === "0") return false;
  if (args.retriesAttempted >= 1) return false;
  if (args.paneInCopyMode) return false;
  if (!args.paneBusy) return false;
  if (typeof args.latestCapture !== "string") return false;
  if (!paneTailContainsLiteralLine(args.latestCapture, args.message)) return false;
  if (paneHasActiveTask(args.latestCapture)) return false;
  if (!paneLooksReady(args.latestCapture)) return false;
  return true;
}
async function sendToWorker(_sessionName, paneId, message) {
  if (message.length > 200) {
    console.warn(`[tmux-session] sendToWorker: message truncated to 200 chars`);
    message = message.slice(0, 200);
  }
  try {
    const { execFile: execFile2 } = await import("child_process");
    const { promisify: promisify2 } = await import("util");
    const execFileAsync = promisify2(execFile2);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const sendKey = async (key) => {
      await execFileAsync("tmux", ["send-keys", "-t", paneId, key]);
    };
    if (await paneInCopyMode(paneId, execFileAsync)) {
      return false;
    }
    const initialCapture = await capturePaneAsync(paneId, execFileAsync);
    const paneBusy = paneHasActiveTask(initialCapture);
    if (paneHasTrustPrompt(initialCapture)) {
      await sendKey("C-m");
      await sleep(120);
      await sendKey("C-m");
      await sleep(200);
    }
    await execFileAsync("tmux", ["send-keys", "-t", paneId, "-l", "--", message]);
    await sleep(150);
    const submitRounds = 6;
    for (let round = 0; round < submitRounds; round++) {
      await sleep(100);
      if (round === 0 && paneBusy) {
        await sendKey("Tab");
        await sleep(80);
        await sendKey("C-m");
      } else {
        await sendKey("C-m");
        await sleep(200);
        await sendKey("C-m");
      }
      await sleep(140);
      const checkCapture = await capturePaneAsync(paneId, execFileAsync);
      if (!paneTailContainsLiteralLine(checkCapture, message)) return true;
      await sleep(140);
    }
    if (await paneInCopyMode(paneId, execFileAsync)) {
      return false;
    }
    const finalCapture = await capturePaneAsync(paneId, execFileAsync);
    const paneModeBeforeAdaptiveRetry = await paneInCopyMode(paneId, execFileAsync);
    if (shouldAttemptAdaptiveRetry({
      paneBusy,
      latestCapture: finalCapture,
      message,
      paneInCopyMode: paneModeBeforeAdaptiveRetry,
      retriesAttempted: 0
    })) {
      if (await paneInCopyMode(paneId, execFileAsync)) {
        return false;
      }
      await sendKey("C-u");
      await sleep(80);
      if (await paneInCopyMode(paneId, execFileAsync)) {
        return false;
      }
      await execFileAsync("tmux", ["send-keys", "-t", paneId, "-l", "--", message]);
      await sleep(120);
      for (let round = 0; round < 4; round++) {
        await sendKey("C-m");
        await sleep(180);
        await sendKey("C-m");
        await sleep(140);
        const retryCapture = await capturePaneAsync(paneId, execFileAsync);
        if (!paneTailContainsLiteralLine(retryCapture, message)) return true;
      }
    }
    if (await paneInCopyMode(paneId, execFileAsync)) {
      return false;
    }
    await sendKey("C-m");
    await sleep(120);
    await sendKey("C-m");
    return true;
  } catch {
    return false;
  }
}
async function isWorkerAlive(paneId) {
  try {
    const { execFile: execFile2 } = await import("child_process");
    const { promisify: promisify2 } = await import("util");
    const execFileAsync = promisify2(execFile2);
    const result = await tmuxAsync([
      "display-message",
      "-t",
      paneId,
      "-p",
      "#{pane_dead}"
    ]);
    return result.stdout.trim() === "0";
  } catch {
    return false;
  }
}
async function killTeamSession(sessionName, workerPaneIds, leaderPaneId) {
  const { execFile: execFile2 } = await import("child_process");
  const { promisify: promisify2 } = await import("util");
  const execFileAsync = promisify2(execFile2);
  if (sessionName.includes(":")) {
    if (!workerPaneIds?.length) return;
    for (const id of workerPaneIds) {
      if (id === leaderPaneId) continue;
      try {
        await execFileAsync("tmux", ["kill-pane", "-t", id]);
      } catch {
      }
    }
    return;
  }
  try {
    await execFileAsync("tmux", ["kill-session", "-t", sessionName]);
  } catch {
  }
}

// src/team/task-file-ops.ts
var import_fs7 = require("fs");
var import_path11 = require("path");

// src/utils/paths.ts
var import_path8 = require("path");
var import_fs5 = require("fs");
var import_os = require("os");
var STALE_THRESHOLD_MS = 24 * 60 * 60 * 1e3;

// src/team/fs-utils.ts
var import_fs6 = require("fs");
var import_path9 = require("path");
function ensureDirWithMode(dirPath, mode = 448) {
  if (!(0, import_fs6.existsSync)(dirPath)) (0, import_fs6.mkdirSync)(dirPath, { recursive: true, mode });
}
function safeRealpath(p) {
  try {
    return (0, import_fs6.realpathSync)(p);
  } catch {
    const parent = (0, import_path9.dirname)(p);
    const name = (0, import_path9.basename)(p);
    try {
      return (0, import_path9.resolve)((0, import_fs6.realpathSync)(parent), name);
    } catch {
      return (0, import_path9.resolve)(p);
    }
  }
}
function validateResolvedPath(resolvedPath, expectedBase) {
  const absResolved = safeRealpath(resolvedPath);
  const absBase = safeRealpath(expectedBase);
  const rel = (0, import_path9.relative)(absBase, absResolved);
  if (rel.startsWith("..") || (0, import_path9.resolve)(absBase, rel) !== absResolved) {
    throw new Error(`Path traversal detected: "${resolvedPath}" escapes base "${expectedBase}"`);
  }
}

// src/team/state-paths.ts
var import_path10 = require("path");
var TeamPaths = {
  root: (teamName) => `.omc/state/team/${teamName}`,
  config: (teamName) => `.omc/state/team/${teamName}/config.json`,
  shutdown: (teamName) => `.omc/state/team/${teamName}/shutdown.json`,
  tasks: (teamName) => `.omc/state/team/${teamName}/tasks`,
  taskFile: (teamName, taskId) => `.omc/state/team/${teamName}/tasks/${taskId}.json`,
  workers: (teamName) => `.omc/state/team/${teamName}/workers`,
  workerDir: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}`,
  heartbeat: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/heartbeat.json`,
  inbox: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/inbox.md`,
  outbox: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/outbox.jsonl`,
  ready: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/.ready`,
  overlay: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/AGENTS.md`,
  shutdownAck: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/shutdown-ack.json`,
  done: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/done.json`,
  mailbox: (teamName, workerName2) => `.omc/state/team/${teamName}/mailbox/${workerName2}.jsonl`
};
function getTaskStoragePath(cwd, teamName, taskId) {
  if (taskId !== void 0) {
    return (0, import_path10.join)(cwd, TeamPaths.taskFile(teamName, taskId));
  }
  return (0, import_path10.join)(cwd, TeamPaths.tasks(teamName));
}

// src/team/task-file-ops.ts
var DEFAULT_STALE_LOCK_MS = 3e4;
function isPidAlive(pid) {
  if (pid <= 0 || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "EPERM") return true;
    return false;
  }
}
function acquireTaskLock(teamName, taskId, opts) {
  const staleLockMs = opts?.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const dir = canonicalTasksDir(teamName, opts?.cwd);
  ensureDirWithMode(dir);
  const lockPath = (0, import_path11.join)(dir, `${sanitizeTaskId(taskId)}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = (0, import_fs7.openSync)(lockPath, import_fs7.constants.O_CREAT | import_fs7.constants.O_EXCL | import_fs7.constants.O_WRONLY, 384);
      const payload = JSON.stringify({
        pid: process.pid,
        workerName: opts?.workerName ?? "",
        timestamp: Date.now()
      });
      (0, import_fs7.writeSync)(fd, payload, null, "utf-8");
      return { fd, path: lockPath };
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
        if (attempt === 0 && isLockStale(lockPath, staleLockMs)) {
          try {
            (0, import_fs7.unlinkSync)(lockPath);
          } catch {
          }
          continue;
        }
        return null;
      }
      throw err;
    }
  }
  return null;
}
function releaseTaskLock(handle) {
  try {
    (0, import_fs7.closeSync)(handle.fd);
  } catch {
  }
  try {
    (0, import_fs7.unlinkSync)(handle.path);
  } catch {
  }
}
async function withTaskLock(teamName, taskId, fn, opts) {
  const handle = acquireTaskLock(teamName, taskId, opts);
  if (!handle) return null;
  try {
    return await fn();
  } finally {
    releaseTaskLock(handle);
  }
}
function isLockStale(lockPath, staleLockMs) {
  try {
    const stat = (0, import_fs7.statSync)(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < staleLockMs) return false;
    try {
      const raw = (0, import_fs7.readFileSync)(lockPath, "utf-8");
      const payload = JSON.parse(raw);
      if (payload.pid && isPidAlive(payload.pid)) return false;
    } catch {
    }
    return true;
  } catch {
    return false;
  }
}
function sanitizeTaskId(taskId) {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new Error(`Invalid task ID: "${taskId}" contains unsafe characters`);
  }
  return taskId;
}
function canonicalTasksDir(teamName, cwd) {
  const root = cwd ?? process.cwd();
  const dir = getTaskStoragePath(root, sanitizeName(teamName));
  validateResolvedPath(dir, (0, import_path11.join)(root, ".omc", "state", "team"));
  return dir;
}

// src/team/runtime.ts
function workerName(index) {
  return `worker-${index + 1}`;
}
function stateRoot(cwd, teamName) {
  validateTeamName(teamName);
  return (0, import_path12.join)(cwd, `.omc/state/team/${teamName}`);
}
async function writeJson(filePath, data) {
  await (0, import_promises5.mkdir)((0, import_path12.join)(filePath, ".."), { recursive: true });
  await (0, import_promises5.writeFile)(filePath, JSON.stringify(data, null, 2), "utf-8");
}
async function readJsonSafe(filePath) {
  try {
    const content = await (0, import_promises5.readFile)(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    try {
      const content = await (0, import_promises5.readFile)(filePath, "utf-8");
      if (content.includes('"')) return null;
      const recovered = content.replace(/\\/g, '"');
      return JSON.parse(recovered);
    } catch {
      return null;
    }
  }
}
function parseWorkerIndex(workerNameValue) {
  const match = workerNameValue.match(/^worker-(\d+)$/);
  if (!match) return 0;
  const parsed = Number.parseInt(match[1], 10) - 1;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
function isOmxInteropWorker(runtime, workerNameValue) {
  const wConfig = runtime.config.workerInteropConfigs?.find((c) => c.workerName === workerNameValue);
  return wConfig?.interopMode === "omx";
}
function buildAdapterContext(runtime) {
  const mode = getInteropMode();
  if (mode === "off") return null;
  return { lead: "omc", teamName: runtime.teamName, cwd: runtime.cwd, interopMode: mode };
}
function taskPath(root, taskId) {
  return (0, import_path12.join)(root, "tasks", `${taskId}.json`);
}
async function writePanesTrackingFileIfPresent(runtime) {
  const jobId = process.env.OMC_JOB_ID;
  const omcJobsDir = process.env.OMC_JOBS_DIR;
  if (!jobId || !omcJobsDir) return;
  const panesPath = (0, import_path12.join)(omcJobsDir, `${jobId}-panes.json`);
  const tempPath = `${panesPath}.tmp`;
  await (0, import_promises5.writeFile)(
    tempPath,
    JSON.stringify({ paneIds: [...runtime.workerPaneIds], leaderPaneId: runtime.leaderPaneId }),
    "utf-8"
  );
  await (0, import_promises5.rename)(tempPath, panesPath);
}
async function readTask(root, taskId) {
  return readJsonSafe(taskPath(root, taskId));
}
async function writeTask(root, task) {
  await writeJson(taskPath(root, task.id), task);
}
async function markTaskInProgress(root, taskId, owner, teamName, cwd) {
  const result = await withTaskLock(teamName, taskId, async () => {
    const task = await readTask(root, taskId);
    if (!task || task.status !== "pending") return false;
    task.status = "in_progress";
    task.owner = owner;
    task.assignedAt = (/* @__PURE__ */ new Date()).toISOString();
    await writeTask(root, task);
    return true;
  }, { cwd });
  return result ?? false;
}
async function resetTaskToPending(root, taskId) {
  const task = await readTask(root, taskId);
  if (!task) return;
  task.status = "pending";
  task.owner = null;
  task.assignedAt = void 0;
  await writeTask(root, task);
}
async function markTaskFromDone(root, taskId, status, summary) {
  const task = await readTask(root, taskId);
  if (!task) return;
  task.status = status;
  task.result = summary;
  task.summary = summary;
  if (status === "completed") {
    task.completedAt = (/* @__PURE__ */ new Date()).toISOString();
  } else {
    task.failedAt = (/* @__PURE__ */ new Date()).toISOString();
  }
  await writeTask(root, task);
}
async function markTaskFailedDeadPane(root, taskId, workerNameValue) {
  const task = await readTask(root, taskId);
  if (!task) return;
  task.status = "failed";
  task.owner = workerNameValue;
  task.summary = `Worker pane died before done.json was written (${workerNameValue})`;
  task.result = task.summary;
  task.failedAt = (/* @__PURE__ */ new Date()).toISOString();
  await writeTask(root, task);
}
async function nextPendingTaskIndex(runtime) {
  const root = stateRoot(runtime.cwd, runtime.teamName);
  for (let i = 0; i < runtime.config.tasks.length; i++) {
    const task = await readTask(root, String(i + 1));
    if (task?.status === "pending") return i;
  }
  return null;
}
async function notifyPaneWithRetry(sessionName, paneId, message, maxAttempts = 6, retryDelayMs = 350) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await sendToWorker(sessionName, paneId, message)) {
      return true;
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  return false;
}
async function allTasksTerminal(runtime) {
  const root = stateRoot(runtime.cwd, runtime.teamName);
  for (let i = 0; i < runtime.config.tasks.length; i++) {
    const task = await readTask(root, String(i + 1));
    if (!task) return false;
    if (task.status !== "completed" && task.status !== "failed") return false;
  }
  return true;
}
function buildInitialTaskInstruction(teamName, workerName2, task, taskId) {
  const donePath = `.omc/state/team/${teamName}/workers/${workerName2}/done.json`;
  const doneDir = `.omc/state/team/${teamName}/workers/${workerName2}`;
  return [
    `## Initial Task Assignment`,
    `Task ID: ${taskId}`,
    `Worker: ${workerName2}`,
    `Subject: ${task.subject}`,
    ``,
    task.description,
    ``,
    `When complete, write done signal using a bash command (do NOT use a file-write tool):`,
    "```bash",
    `mkdir -p ${doneDir} && echo '{"taskId":"${taskId}","status":"completed","summary":"done","completedAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > ${donePath}`,
    "```",
    ``,
    `IMPORTANT: Execute ONLY the task assigned to you in this inbox. After writing done.json, exit immediately. Do not read from the task directory or claim other tasks.`
  ].join("\n");
}
async function startTeam(config) {
  const { teamName, agentTypes, tasks, cwd } = config;
  validateTeamName(teamName);
  for (const agentType of [...new Set(agentTypes)]) {
    validateCliAvailable(agentType);
  }
  const root = stateRoot(cwd, teamName);
  await (0, import_promises5.mkdir)((0, import_path12.join)(root, "tasks"), { recursive: true });
  await (0, import_promises5.mkdir)((0, import_path12.join)(root, "mailbox"), { recursive: true });
  await writeJson((0, import_path12.join)(root, "config.json"), config);
  for (let i = 0; i < tasks.length; i++) {
    const taskId = String(i + 1);
    await writeJson((0, import_path12.join)(root, "tasks", `${taskId}.json`), {
      id: taskId,
      subject: tasks[i].subject,
      description: tasks[i].description,
      status: "pending",
      owner: null,
      result: null,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  const workerNames = [];
  for (let i = 0; i < tasks.length; i++) {
    const wName = workerName(i);
    workerNames.push(wName);
    const agentType = agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? "claude";
    await ensureWorkerStateDir(teamName, wName, cwd);
    await writeWorkerOverlay({
      teamName,
      workerName: wName,
      agentType,
      tasks: tasks.map((t, idx) => ({ id: String(idx + 1), subject: t.subject, description: t.description })),
      cwd
    });
  }
  const session = await createTeamSession(teamName, 0, cwd);
  const runtime = {
    teamName,
    sessionName: session.sessionName,
    leaderPaneId: session.leaderPaneId,
    config,
    workerNames,
    workerPaneIds: session.workerPaneIds,
    // initially empty []
    activeWorkers: /* @__PURE__ */ new Map(),
    cwd
  };
  const maxConcurrentWorkers = agentTypes.length;
  for (let i = 0; i < maxConcurrentWorkers; i++) {
    const taskIndex = await nextPendingTaskIndex(runtime);
    if (taskIndex == null) break;
    await spawnWorkerForTask(runtime, workerName(i), taskIndex);
  }
  runtime.stopWatchdog = watchdogCliWorkers(runtime, 1e3);
  return runtime;
}
async function monitorTeam(teamName, cwd, workerPaneIds) {
  validateTeamName(teamName);
  const monitorStartedAt = Date.now();
  const root = stateRoot(cwd, teamName);
  const taskScanStartedAt = Date.now();
  const taskCounts = { pending: 0, inProgress: 0, completed: 0, failed: 0 };
  try {
    const { readdir: readdir2 } = await import("fs/promises");
    const taskFiles = await readdir2((0, import_path12.join)(root, "tasks"));
    for (const f of taskFiles.filter((f2) => f2.endsWith(".json"))) {
      const task = await readJsonSafe((0, import_path12.join)(root, "tasks", f));
      if (task?.status === "pending") taskCounts.pending++;
      else if (task?.status === "in_progress") taskCounts.inProgress++;
      else if (task?.status === "completed") taskCounts.completed++;
      else if (task?.status === "failed") taskCounts.failed++;
    }
  } catch {
  }
  const listTasksMs = Date.now() - taskScanStartedAt;
  const workerScanStartedAt = Date.now();
  const workers = [];
  const deadWorkers = [];
  for (let i = 0; i < workerPaneIds.length; i++) {
    const wName = `worker-${i + 1}`;
    const paneId = workerPaneIds[i];
    const alive = await isWorkerAlive(paneId);
    const heartbeatPath = (0, import_path12.join)(root, "workers", wName, "heartbeat.json");
    const heartbeat = await readJsonSafe(heartbeatPath);
    let stalled = false;
    if (heartbeat?.updatedAt) {
      const age = Date.now() - new Date(heartbeat.updatedAt).getTime();
      stalled = age > 6e4;
    }
    const status = {
      workerName: wName,
      alive,
      paneId,
      currentTaskId: heartbeat?.currentTaskId,
      lastHeartbeat: heartbeat?.updatedAt,
      stalled
    };
    workers.push(status);
    if (!alive) deadWorkers.push(wName);
  }
  const workerScanMs = Date.now() - workerScanStartedAt;
  let phase = "executing";
  if (taskCounts.inProgress === 0 && taskCounts.pending > 0 && taskCounts.completed === 0) {
    phase = "planning";
  } else if (taskCounts.failed > 0 && taskCounts.pending === 0 && taskCounts.inProgress === 0) {
    phase = "fixing";
  } else if (taskCounts.completed > 0 && taskCounts.pending === 0 && taskCounts.inProgress === 0 && taskCounts.failed === 0) {
    phase = "completed";
  }
  return {
    teamName,
    phase,
    workers,
    taskCounts,
    deadWorkers,
    monitorPerformance: {
      listTasksMs,
      workerScanMs,
      totalMs: Date.now() - monitorStartedAt
    }
  };
}
function watchdogCliWorkers(runtime, intervalMs) {
  let tickInFlight = false;
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;
  const unresponsiveCounts = /* @__PURE__ */ new Map();
  const UNRESPONSIVE_KILL_THRESHOLD = 3;
  const tick = async () => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      const workers = [...runtime.activeWorkers.entries()];
      if (workers.length === 0) return;
      const root = stateRoot(runtime.cwd, runtime.teamName);
      const adapterCtx = buildAdapterContext(runtime);
      if (adapterCtx) {
        await Promise.all(
          workers.filter(([wName]) => isOmxInteropWorker(runtime, wName)).map(([wName, active]) => pollOmxCompletion(adapterCtx, wName, active.taskId).catch(() => null))
        );
      }
      const [doneSignals, aliveResults] = await Promise.all([
        Promise.all(workers.map(([wName]) => {
          const donePath = (0, import_path12.join)(root, "workers", wName, "done.json");
          return readJsonSafe(donePath);
        })),
        Promise.all(workers.map(([, active]) => isWorkerAlive(active.paneId)))
      ]);
      for (let i = 0; i < workers.length; i++) {
        const [wName, active] = workers[i];
        const donePath = (0, import_path12.join)(root, "workers", wName, "done.json");
        const signal = doneSignals[i];
        if (signal) {
          unresponsiveCounts.delete(wName);
          await markTaskFromDone(root, signal.taskId || active.taskId, signal.status, signal.summary);
          try {
            const { unlink: unlink2 } = await import("fs/promises");
            await unlink2(donePath);
          } catch {
          }
          await killWorkerPane(runtime, wName, active.paneId);
          if (!await allTasksTerminal(runtime)) {
            const nextTaskIndexValue = await nextPendingTaskIndex(runtime);
            if (nextTaskIndexValue != null) {
              await spawnWorkerForTask(runtime, wName, nextTaskIndexValue);
            }
          }
          continue;
        }
        const alive = aliveResults[i];
        if (!alive) {
          unresponsiveCounts.delete(wName);
          await markTaskFailedDeadPane(root, active.taskId, wName);
          await killWorkerPane(runtime, wName, active.paneId);
          if (!await allTasksTerminal(runtime)) {
            const nextTaskIndexValue = await nextPendingTaskIndex(runtime);
            if (nextTaskIndexValue != null) {
              await spawnWorkerForTask(runtime, wName, nextTaskIndexValue);
            }
          }
          continue;
        }
        const heartbeatPath = (0, import_path12.join)(root, "workers", wName, "heartbeat.json");
        const heartbeat = await readJsonSafe(heartbeatPath);
        const isStalled = heartbeat?.updatedAt ? Date.now() - new Date(heartbeat.updatedAt).getTime() > 6e4 : false;
        if (isStalled) {
          const count = (unresponsiveCounts.get(wName) ?? 0) + 1;
          unresponsiveCounts.set(wName, count);
          if (count < UNRESPONSIVE_KILL_THRESHOLD) {
            console.warn(`[watchdog] worker ${wName} unresponsive (${count}/${UNRESPONSIVE_KILL_THRESHOLD}), task ${active.taskId}`);
          } else {
            console.warn(`[watchdog] worker ${wName} unresponsive ${count} consecutive ticks \u2014 killing and reassigning task ${active.taskId}`);
            unresponsiveCounts.delete(wName);
            await markTaskFailedDeadPane(root, active.taskId, wName);
            await killWorkerPane(runtime, wName, active.paneId);
            if (!await allTasksTerminal(runtime)) {
              const nextTaskIndexValue = await nextPendingTaskIndex(runtime);
              if (nextTaskIndexValue != null) {
                await spawnWorkerForTask(runtime, wName, nextTaskIndexValue);
              }
            }
          }
        } else {
          unresponsiveCounts.delete(wName);
        }
      }
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      console.warn("[watchdog] tick error:", err);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(`[watchdog] ${consecutiveFailures} consecutive failures \u2014 marking team as failed`);
        try {
          const root = stateRoot(runtime.cwd, runtime.teamName);
          await writeJson((0, import_path12.join)(root, "watchdog-failed.json"), {
            failedAt: (/* @__PURE__ */ new Date()).toISOString(),
            consecutiveFailures,
            lastError: err instanceof Error ? err.message : String(err)
          });
        } catch {
        }
        clearInterval(intervalId);
      }
    } finally {
      tickInFlight = false;
    }
  };
  const intervalId = setInterval(() => {
    tick();
  }, intervalMs);
  return () => clearInterval(intervalId);
}
async function spawnWorkerForTask(runtime, workerNameValue, taskIndex) {
  const root = stateRoot(runtime.cwd, runtime.teamName);
  const taskId = String(taskIndex + 1);
  const task = runtime.config.tasks[taskIndex];
  if (!task) return "";
  const marked = await markTaskInProgress(root, taskId, workerNameValue, runtime.teamName, runtime.cwd);
  if (!marked) return "";
  const { execFile: execFile2 } = await import("child_process");
  const { promisify: promisify2 } = await import("util");
  const execFileAsync = promisify2(execFile2);
  const splitTarget = runtime.workerPaneIds.length === 0 ? runtime.leaderPaneId : runtime.workerPaneIds[runtime.workerPaneIds.length - 1];
  const splitType = runtime.workerPaneIds.length === 0 ? "-h" : "-v";
  const splitResult = await execFileAsync("tmux", [
    "split-window",
    splitType,
    "-t",
    splitTarget,
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-c",
    runtime.cwd
  ]);
  const paneId = splitResult.stdout.split("\n")[0]?.trim();
  if (!paneId) return "";
  const workerIndex = parseWorkerIndex(workerNameValue);
  const agentType = runtime.config.agentTypes[workerIndex % runtime.config.agentTypes.length] ?? runtime.config.agentTypes[0] ?? "claude";
  const usePromptMode = isPromptModeAgent(agentType);
  const instruction = buildInitialTaskInstruction(runtime.teamName, workerNameValue, task, taskId);
  await composeInitialInbox(runtime.teamName, workerNameValue, instruction, runtime.cwd);
  const relInboxPath = `.omc/state/team/${runtime.teamName}/workers/${workerNameValue}/inbox.md`;
  const envVars = getWorkerEnv(runtime.teamName, workerNameValue, agentType);
  const [launchBinary, ...launchArgs] = buildWorkerArgv(agentType, {
    teamName: runtime.teamName,
    workerName: workerNameValue,
    cwd: runtime.cwd
  });
  if (usePromptMode) {
    const promptArgs = getPromptModeArgs(agentType, `Read and execute your task from: ${relInboxPath}`);
    launchArgs.push(...promptArgs);
  }
  const paneConfig = {
    teamName: runtime.teamName,
    workerName: workerNameValue,
    envVars,
    launchBinary,
    launchArgs,
    cwd: runtime.cwd
  };
  await spawnWorkerInPane(runtime.sessionName, paneId, paneConfig);
  runtime.workerPaneIds.push(paneId);
  runtime.activeWorkers.set(workerNameValue, { paneId, taskId, spawnedAt: Date.now() });
  try {
    await execFileAsync("tmux", ["select-layout", "-t", runtime.sessionName, "main-vertical"]);
  } catch {
  }
  try {
    await writePanesTrackingFileIfPresent(runtime);
  } catch {
  }
  if (!usePromptMode) {
    await new Promise((r) => setTimeout(r, 4e3));
    if (agentType === "gemini") {
      const confirmed = await notifyPaneWithRetry(runtime.sessionName, paneId, "1");
      if (!confirmed) {
        await killWorkerPane(runtime, workerNameValue, paneId);
        await resetTaskToPending(root, taskId);
        throw new Error(`worker_notify_failed:${workerNameValue}:trust-confirm`);
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    const notified = await notifyPaneWithRetry(
      runtime.sessionName,
      paneId,
      `Read and execute your task from: ${relInboxPath}`
    );
    if (!notified) {
      await killWorkerPane(runtime, workerNameValue, paneId);
      await resetTaskToPending(root, taskId);
      throw new Error(`worker_notify_failed:${workerNameValue}:initial-inbox`);
    }
  }
  if (isOmxInteropWorker(runtime, workerNameValue)) {
    const ctx = buildAdapterContext(runtime);
    if (ctx) {
      await bridgeBootstrapToOmx(ctx, workerNameValue, { id: taskId, subject: task.subject, description: task.description });
    }
  }
  return paneId;
}
async function killWorkerPane(runtime, workerNameValue, paneId) {
  try {
    const { execFile: execFile2 } = await import("child_process");
    const { promisify: promisify2 } = await import("util");
    const execFileAsync = promisify2(execFile2);
    await execFileAsync("tmux", ["kill-pane", "-t", paneId]);
  } catch {
  }
  const paneIndex = runtime.workerPaneIds.indexOf(paneId);
  if (paneIndex >= 0) {
    runtime.workerPaneIds.splice(paneIndex, 1);
  }
  runtime.activeWorkers.delete(workerNameValue);
  try {
    await writePanesTrackingFileIfPresent(runtime);
  } catch {
  }
}
async function shutdownTeam(teamName, sessionName, cwd, timeoutMs = 3e4, workerPaneIds, leaderPaneId) {
  const root = stateRoot(cwd, teamName);
  await writeJson((0, import_path12.join)(root, "shutdown.json"), {
    requestedAt: (/* @__PURE__ */ new Date()).toISOString(),
    teamName
  });
  const configData = await readJsonSafe((0, import_path12.join)(root, "config.json"));
  const CLI_AGENT_TYPES = /* @__PURE__ */ new Set(["claude", "codex", "gemini"]);
  const agentTypes = configData?.agentTypes ?? [];
  const isCliWorkerTeam = agentTypes.length > 0 && agentTypes.every((t) => CLI_AGENT_TYPES.has(t));
  if (!isCliWorkerTeam) {
    const deadline = Date.now() + timeoutMs;
    const workerCount = configData?.workerCount ?? 0;
    const expectedAcks = Array.from({ length: workerCount }, (_, i) => `worker-${i + 1}`);
    while (Date.now() < deadline && expectedAcks.length > 0) {
      for (const wName of [...expectedAcks]) {
        const ackPath = (0, import_path12.join)(root, "workers", wName, "shutdown-ack.json");
        if ((0, import_fs8.existsSync)(ackPath)) {
          expectedAcks.splice(expectedAcks.indexOf(wName), 1);
        }
      }
      if (expectedAcks.length > 0) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  const interopMode = getInteropMode();
  if (interopMode !== "off" && configData?.workerInteropConfigs) {
    const omxWorkers = configData.workerInteropConfigs.filter((c) => c.interopMode === "omx");
    for (const wConfig of omxWorkers) {
      try {
        await appendOmxTeamEvent(teamName, {
          type: "worker_stopped",
          worker: wConfig.workerName,
          task_id: void 0
        }, cwd);
      } catch {
      }
    }
  }
  await killTeamSession(sessionName, workerPaneIds, leaderPaneId);
  try {
    await (0, import_promises5.rm)(root, { recursive: true, force: true });
  } catch {
  }
}

// src/team/runtime-cli.ts
async function writePanesFile(jobId, paneIds, leaderPaneId) {
  const omcJobsDir = process.env.OMC_JOBS_DIR;
  if (!jobId || !omcJobsDir) return;
  const panesPath = (0, import_path13.join)(omcJobsDir, `${jobId}-panes.json`);
  await (0, import_promises6.writeFile)(
    panesPath + ".tmp",
    JSON.stringify({ paneIds: [...paneIds], leaderPaneId })
  );
  await (0, import_promises6.rename)(panesPath + ".tmp", panesPath);
}
function collectTaskResults(stateRoot2) {
  const tasksDir = (0, import_path13.join)(stateRoot2, "tasks");
  try {
    const files = (0, import_fs9.readdirSync)(tasksDir).filter((f) => f.endsWith(".json"));
    return files.map((f) => {
      try {
        const raw = (0, import_fs9.readFileSync)((0, import_path13.join)(tasksDir, f), "utf-8");
        const task = JSON.parse(raw);
        return {
          taskId: task.id ?? f.replace(".json", ""),
          status: task.status ?? "unknown",
          summary: task.result ?? task.summary ?? ""
        };
      } catch {
        return { taskId: f.replace(".json", ""), status: "unknown", summary: "" };
      }
    });
  } catch {
    return [];
  }
}
async function main() {
  const startTime = Date.now();
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const rawInput = Buffer.concat(chunks).toString("utf-8").trim();
  let input;
  try {
    input = JSON.parse(rawInput);
  } catch (err) {
    process.stderr.write(`[runtime-cli] Failed to parse stdin JSON: ${err}
`);
    process.exit(1);
  }
  const missing = [];
  if (!input.teamName) missing.push("teamName");
  if (!input.agentTypes || !Array.isArray(input.agentTypes) || input.agentTypes.length === 0) missing.push("agentTypes");
  if (!input.tasks || !Array.isArray(input.tasks) || input.tasks.length === 0) missing.push("tasks");
  if (!input.cwd) missing.push("cwd");
  if (missing.length > 0) {
    process.stderr.write(`[runtime-cli] Missing required fields: ${missing.join(", ")}
`);
    process.exit(1);
  }
  const {
    teamName,
    agentTypes,
    tasks,
    cwd,
    pollIntervalMs = 5e3
  } = input;
  const workerCount = input.workerCount ?? agentTypes.length;
  const stateRoot2 = (0, import_path13.join)(cwd, `.omc/state/team/${teamName}`);
  const config = {
    teamName,
    workerCount,
    agentTypes,
    tasks,
    cwd
  };
  let runtime = null;
  let finalStatus = "failed";
  let pollActive = true;
  function exitCodeFor(status) {
    return status === "completed" ? 0 : 1;
  }
  async function doShutdown(status) {
    pollActive = false;
    finalStatus = status;
    if (runtime?.stopWatchdog) {
      runtime.stopWatchdog();
    }
    const taskResults = collectTaskResults(stateRoot2);
    if (runtime) {
      try {
        await shutdownTeam(
          runtime.teamName,
          runtime.sessionName,
          runtime.cwd,
          2e3,
          runtime.workerPaneIds,
          runtime.leaderPaneId
        );
      } catch (err) {
        process.stderr.write(`[runtime-cli] shutdownTeam error: ${err}
`);
      }
    }
    const duration = (Date.now() - startTime) / 1e3;
    const output = {
      status: finalStatus,
      teamName,
      taskResults,
      duration,
      workerCount
    };
    process.stdout.write(JSON.stringify(output) + "\n");
    process.exit(exitCodeFor(status));
  }
  process.on("SIGINT", () => {
    process.stderr.write("[runtime-cli] Received SIGINT, shutting down...\n");
    doShutdown("failed").catch(() => process.exit(1));
  });
  process.on("SIGTERM", () => {
    process.stderr.write("[runtime-cli] Received SIGTERM, shutting down...\n");
    doShutdown("failed").catch(() => process.exit(1));
  });
  try {
    runtime = await startTeam(config);
  } catch (err) {
    process.stderr.write(`[runtime-cli] startTeam failed: ${err}
`);
    process.exit(1);
  }
  const jobId = process.env.OMC_JOB_ID;
  try {
    await writePanesFile(jobId, runtime.workerPaneIds, runtime.leaderPaneId);
  } catch (err) {
    process.stderr.write(`[runtime-cli] Failed to persist pane IDs: ${err}
`);
  }
  while (pollActive) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    if (!pollActive) break;
    let snap;
    try {
      snap = await monitorTeam(teamName, cwd, runtime.workerPaneIds);
    } catch (err) {
      process.stderr.write(`[runtime-cli] monitorTeam error: ${err}
`);
      continue;
    }
    try {
      await writePanesFile(jobId, runtime.workerPaneIds, runtime.leaderPaneId);
    } catch (err) {
      process.stderr.write(`[runtime-cli] Failed to persist pane IDs: ${err}
`);
    }
    process.stderr.write(
      `[runtime-cli] phase=${snap.phase} pending=${snap.taskCounts.pending} inProgress=${snap.taskCounts.inProgress} completed=${snap.taskCounts.completed} failed=${snap.taskCounts.failed} dead=${snap.deadWorkers.length} monitorMs=${snap.monitorPerformance.totalMs} tasksMs=${snap.monitorPerformance.listTasksMs} workerMs=${snap.monitorPerformance.workerScanMs}
`
    );
    if (snap.phase === "completed") {
      await doShutdown("completed");
      return;
    }
    const allWorkersDead = runtime.workerPaneIds.length > 0 && snap.deadWorkers.length === runtime.workerPaneIds.length;
    const hasOutstandingWork = snap.taskCounts.pending + snap.taskCounts.inProgress > 0;
    const deadWorkerFailure = allWorkersDead && hasOutstandingWork;
    const fixingWithNoWorkers = snap.phase === "fixing" && allWorkersDead;
    if (deadWorkerFailure || fixingWithNoWorkers) {
      process.stderr.write(`[runtime-cli] Failure detected: deadWorkerFailure=${deadWorkerFailure} fixingWithNoWorkers=${fixingWithNoWorkers}
`);
      await doShutdown("failed");
      return;
    }
  }
}
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[runtime-cli] Fatal error: ${err}
`);
    process.exit(1);
  });
}

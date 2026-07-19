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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/cli/claude-md-coordinator.ts
var claude_md_coordinator_exports = {};
__export(claude_md_coordinator_exports, {
  CLAUDE_MD_COORDINATOR_SCHEMA_VERSION: () => CLAUDE_MD_COORDINATOR_SCHEMA_VERSION,
  runClaudeMdCoordinator: () => runClaudeMdCoordinator,
  runClaudeMdCoordinatorHandshake: () => runClaudeMdCoordinatorHandshake
});
module.exports = __toCommonJS(claude_md_coordinator_exports);
var import_node_crypto2 = require("node:crypto");
var import_node_fs = require("node:fs");
var import_node_path2 = require("node:path");

// src/installer/claude-md-transaction.ts
var import_node_crypto = require("node:crypto");
var nodeFs = __toESM(require("node:fs"), 1);
var nativePath = __toESM(require("node:path"), 1);
var import_node_path = require("node:path");

// src/installer/claude-md-analysis.ts
var import_crypto = require("crypto");

// src/installer/legacy-claude-md-corpus.ts
var LEGACY_CLAUDE_MD_VARIANTS = [
  {
    "id": "legacy-01",
    "markerless": true,
    "sourceCommit": "bdeb2d6723d7236804043bd004fc0e38f39f4a3e",
    "gitBlobSha": "6f005ea35251641fe38428e4a94614d5197fdca0",
    "rawByteLength": 16177,
    "rawSha256": "287d4091749263fc4a646321f6586ad9080c34b8c78503c47f17dabd12a28f77",
    "lineCount": 411,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "For migration guides from earlier versions, see the [Migration Guide](https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/MIGRATION.md).",
    "normalizedSha256": "287d4091749263fc4a646321f6586ad9080c34b8c78503c47f17dabd12a28f77"
  },
  {
    "id": "legacy-02",
    "markerless": true,
    "sourceCommit": "02152c6b2fe77f77f265ec728d93d73d155f53b7",
    "gitBlobSha": "95112588b50ba00c2c98d07079995e42041f47ed",
    "rawByteLength": 15427,
    "rawSha256": "b052a9b9be4aeb4bcd012839e212332213100d24d565ca57f0d7f128e6fe7477",
    "lineCount": 395,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "For migration guides from earlier versions, see the [Migration Guide](https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/MIGRATION.md).",
    "normalizedSha256": "b052a9b9be4aeb4bcd012839e212332213100d24d565ca57f0d7f128e6fe7477"
  },
  {
    "id": "legacy-03",
    "markerless": true,
    "sourceCommit": "b5acd0defda7541eaff095a0b648dfd2f1f7e4fc",
    "gitBlobSha": "b66ec4a761bcbdd7414537b38f186450cfef8d50",
    "rawByteLength": 31385,
    "rawSha256": "e7f081c220adf8e57f1c0bbc97ab6c7caa8b928bb02c95fa7306db3c64f1ad6e",
    "lineCount": 718,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "For migration guides from earlier versions, see the [Migration Guide](https://raw.githubusercontent.com/Yeachan-Heo/oh-my-claudecode/main/docs/MIGRATION.md).",
    "normalizedSha256": "e7f081c220adf8e57f1c0bbc97ab6c7caa8b928bb02c95fa7306db3c64f1ad6e"
  },
  {
    "id": "legacy-04",
    "markerless": true,
    "sourceCommit": "b43d6a8f197c3d61ad3191f0ca653c2e22b07fdf",
    "gitBlobSha": "b1e5de1548f33460cf099add7a5fab92e21407bc",
    "rawByteLength": 31355,
    "rawSha256": "29392870c7a6b6f06f93f2877cae448825498bb5e438c81b0dad3c96b8fc2ac5",
    "lineCount": 720,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "For migration guides from earlier versions, see [MIGRATION.md](./MIGRATION.md).",
    "normalizedSha256": "29392870c7a6b6f06f93f2877cae448825498bb5e438c81b0dad3c96b8fc2ac5"
  },
  {
    "id": "legacy-05",
    "markerless": true,
    "sourceCommit": "a15fc4698c5955a4182b3a2040a4448722738e46",
    "gitBlobSha": "c75cd527a6fd5aa4c3a7351207b7d5ae05845a57",
    "rawByteLength": 28705,
    "rawSha256": "b046b3b3cb97b347386fff48f4d84e5af64e5f4194b676e04369012f91bb23f4",
    "lineCount": 680,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "For migration guides from earlier versions, see [MIGRATION.md](./MIGRATION.md).",
    "normalizedSha256": "b046b3b3cb97b347386fff48f4d84e5af64e5f4194b676e04369012f91bb23f4"
  },
  {
    "id": "legacy-06",
    "markerless": true,
    "sourceCommit": "f49f819e49daa01fcad3c89c12b2456e831914cc",
    "gitBlobSha": "020424a846f5e6a3c9c4a811ed25513bff06bfc6",
    "rawByteLength": 28702,
    "rawSha256": "e2f01b2570ef9a8f0ca2ed5b33352fa1f35126c4061583e8799b13729fa13610",
    "lineCount": 680,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "For migration guides from earlier versions, see [MIGRATION.md](./MIGRATION.md).",
    "normalizedSha256": "e2f01b2570ef9a8f0ca2ed5b33352fa1f35126c4061583e8799b13729fa13610"
  },
  {
    "id": "legacy-07",
    "markerless": true,
    "sourceCommit": "fd6e2e7ffc4acde3907f51775ede7265b1eecbf2",
    "gitBlobSha": "f2346c49597d0f916df4f2259cd4faf3b459526e",
    "rawByteLength": 27585,
    "rawSha256": "e7137b0f9fb77753b782910834c8ca23ad2db83d8942f14868be7eccbaa462ed",
    "lineCount": 659,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "For migration guides from earlier versions, see [MIGRATION.md](./MIGRATION.md).",
    "normalizedSha256": "e7137b0f9fb77753b782910834c8ca23ad2db83d8942f14868be7eccbaa462ed"
  },
  {
    "id": "legacy-08",
    "markerless": true,
    "sourceCommit": "e17dc15bb079853634ab07f6d52ec0051a8cd74f",
    "gitBlobSha": "9b19d53d59f3ef74d1dcabf0ddcc9a59ee8ae362",
    "rawByteLength": 22415,
    "rawSha256": "8354f803febe3ee1c4fc719596ebb1aa096bb3f8b344dcd640ac1c792445aad9",
    "lineCount": 576,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "For migration guides from earlier versions, see [MIGRATION.md](./MIGRATION.md).",
    "normalizedSha256": "8354f803febe3ee1c4fc719596ebb1aa096bb3f8b344dcd640ac1c792445aad9"
  },
  {
    "id": "legacy-09",
    "markerless": true,
    "sourceCommit": "43d5d23d451407ab21e3dd6e773000adbe3e3898",
    "gitBlobSha": "afbf9cb292277822b14f4a85d9d9713f58e15056",
    "rawByteLength": 23138,
    "rawSha256": "f78fe8182ba2bb94b345477f25fe5da8b10950f486d97dfe08c5cf4725a923a7",
    "lineCount": 583,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "For migration guides from earlier versions, see [MIGRATION.md](./MIGRATION.md).",
    "normalizedSha256": "f78fe8182ba2bb94b345477f25fe5da8b10950f486d97dfe08c5cf4725a923a7"
  },
  {
    "id": "legacy-10",
    "markerless": true,
    "sourceCommit": "8ac463d8f7494a8e917514a6e809d00b1eb9bfae",
    "gitBlobSha": "7d38a2de5a03ca903953e8c6689197bbb19760ca",
    "rawByteLength": 22700,
    "rawSha256": "7590ed845e49d05d772ecbc3de4b0ae1a20fd4d026ad5572b647ca665c3da128",
    "lineCount": 576,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "**New in 3.x:** Autopilot mode provides the ultimate hands-off experience.",
    "normalizedSha256": "7590ed845e49d05d772ecbc3de4b0ae1a20fd4d026ad5572b647ca665c3da128"
  },
  {
    "id": "legacy-11",
    "markerless": true,
    "sourceCommit": "7afe03dc55f7e7e30716c7ea4dd359b16f93c074",
    "gitBlobSha": "dc02bf3798451a2e32b3fe96c90996946c5d6cc3",
    "rawByteLength": 20714,
    "rawSha256": "44dcb8243c81521372e5b05ed4a6c2070a70eab2cac463c77fdde729432428b8",
    "lineCount": 534,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "**New in 3.x:** Autopilot mode provides the ultimate hands-off experience.",
    "normalizedSha256": "44dcb8243c81521372e5b05ed4a6c2070a70eab2cac463c77fdde729432428b8"
  },
  {
    "id": "legacy-12",
    "markerless": true,
    "sourceCommit": "27201fc2a157cf2827a51940b8997070507ea2a3",
    "gitBlobSha": "36eb3effcfacdf96a14073584f16661c5f1bee36",
    "rawByteLength": 17783,
    "rawSha256": "4fc8628543dbea375e0108cc44ed3cd7243b757d1a2ac58cb0086984b8f6a119",
    "lineCount": 457,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "**New in 3.x:** Autopilot mode provides the ultimate hands-off experience.",
    "normalizedSha256": "4fc8628543dbea375e0108cc44ed3cd7243b757d1a2ac58cb0086984b8f6a119"
  },
  {
    "id": "legacy-13",
    "markerless": true,
    "sourceCommit": "07dbb711ba8483e6fc14b7b2320fae27bf7a0df3",
    "gitBlobSha": "4903c785e15eb94fa23d5f0cb2fd8ecd81bb8d46",
    "rawByteLength": 17324,
    "rawSha256": "ac274106313706b880e2f2d98d7dd9d264dfe86bba8c27fd421c0702c15abdfd",
    "lineCount": 457,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "**New in 3.x:** Autopilot mode provides the ultimate hands-off experience.",
    "normalizedSha256": "ac274106313706b880e2f2d98d7dd9d264dfe86bba8c27fd421c0702c15abdfd"
  },
  {
    "id": "legacy-14",
    "markerless": true,
    "sourceCommit": "0e219bd7789f5984ceb0c566f802805aeb6db668",
    "gitBlobSha": "091f7a4d33130d22e285304f144dfc135cdd6b05",
    "rawByteLength": 16487,
    "rawSha256": "bdf21db37ead6784352d1f8e82129b82080f84a48ab86bdc2db78c6d79d7ec3b",
    "lineCount": 431,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "**New in 3.x:** Autopilot mode provides the ultimate hands-off experience.",
    "normalizedSha256": "bdf21db37ead6784352d1f8e82129b82080f84a48ab86bdc2db78c6d79d7ec3b"
  },
  {
    "id": "legacy-15",
    "markerless": true,
    "sourceCommit": "0326c0594a9317365e79673fa6caa960b78377aa",
    "gitBlobSha": "7e600225d358a942728949681e450c403b80af3f",
    "rawByteLength": 16142,
    "rawSha256": "fd53d1ee2ee96ade4372e00a21b0bcf079c1d46d9ba0e5a599f0eb2c8fddb2a0",
    "lineCount": 424,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "**New in 3.x:** Autopilot mode provides the ultimate hands-off experience.",
    "normalizedSha256": "fd53d1ee2ee96ade4372e00a21b0bcf079c1d46d9ba0e5a599f0eb2c8fddb2a0"
  },
  {
    "id": "legacy-16",
    "markerless": true,
    "sourceCommit": "5828da7b6d00f66a5f2f728970ee0b9ca776a732",
    "gitBlobSha": "9f90998867fb3a971466b72e2592ad1a947dd5f2",
    "rawByteLength": 15709,
    "rawSha256": "684738ecf9ecbe7273f06b0935ad22f01ec622fdd933add02276b078e97b29c4",
    "lineCount": 417,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "**New in 3.x:** Autopilot mode provides the ultimate hands-off experience.",
    "normalizedSha256": "684738ecf9ecbe7273f06b0935ad22f01ec622fdd933add02276b078e97b29c4"
  },
  {
    "id": "legacy-17",
    "markerless": true,
    "sourceCommit": "57572e8f6e4b570e83d3101224ea5d72886b4a1a",
    "gitBlobSha": "60f2190848864b76528e01e4ebd9416de6067369",
    "rawByteLength": 14811,
    "rawSha256": "f50ebdb7bf4753ee2d14d403feda4b734c55039c3cbad211c3e8bde4c54e2d39",
    "lineCount": 386,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "**New in 3.x:** Autopilot mode provides the ultimate hands-off experience.",
    "normalizedSha256": "f50ebdb7bf4753ee2d14d403feda4b734c55039c3cbad211c3e8bde4c54e2d39"
  },
  {
    "id": "legacy-18",
    "markerless": true,
    "sourceCommit": "9e9cb94f71055201328225d4ed328de9be50ea57",
    "gitBlobSha": "26a56e555af397c7ea499181bacbdfde888896b9",
    "rawByteLength": 11440,
    "rawSha256": "32ed686cf8a071bafab679e196590160a7add0757918bf332a2455bca97eb2f9",
    "lineCount": 304,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "The difference? You don't NEED them anymore. Everything auto-activates.",
    "normalizedSha256": "32ed686cf8a071bafab679e196590160a7add0757918bf332a2455bca97eb2f9"
  },
  {
    "id": "legacy-19",
    "markerless": true,
    "sourceCommit": "67b45e50bfdcedab2c31ef60d01c8c9d75ee79ee",
    "gitBlobSha": "466569ea48771fe398fa35608c910f54da571a7f",
    "rawByteLength": 11440,
    "rawSha256": "393c02f244aa1033d542e1b0d1ae17a9188eedd23ae262c3d69d1ca0676d3710",
    "lineCount": 304,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "The difference? You don't NEED them anymore. Everything auto-activates.",
    "normalizedSha256": "393c02f244aa1033d542e1b0d1ae17a9188eedd23ae262c3d69d1ca0676d3710"
  },
  {
    "id": "legacy-20",
    "markerless": true,
    "sourceCommit": "5a6bded9938ea72f39b0933b50173f3dd3ce41aa",
    "gitBlobSha": "97b83b327b7474bf7bd4746ad528ed0ed46ef40d",
    "rawByteLength": 10818,
    "rawSha256": "1b164df10e9a1f621288a501592470206e2af7ec10a13f85ca5faef22418d6cc",
    "lineCount": 292,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "The difference? You don't NEED them anymore. Everything auto-activates.",
    "normalizedSha256": "1b164df10e9a1f621288a501592470206e2af7ec10a13f85ca5faef22418d6cc"
  },
  {
    "id": "legacy-21",
    "markerless": true,
    "sourceCommit": "4f3681f1de1d387bb5f1a701dc4cafa32f70628d",
    "gitBlobSha": "173a9c8d542d3d3ccdb0b0335d1847237cc28352",
    "rawByteLength": 10767,
    "rawSha256": "5001bd4e3be7801b26e2961f11ea237719a098b624ed20c9767763aee3958b3a",
    "lineCount": 292,
    "terminalEolPolicy": "required",
    "openingLine": "# oh-my-claudecode - Intelligent Multi-Agent Orchestration",
    "finalLine": "The difference? You don't NEED them anymore. Everything auto-activates.",
    "normalizedSha256": "5001bd4e3be7801b26e2961f11ea237719a098b624ed20c9767763aee3958b3a"
  },
  {
    "id": "legacy-22",
    "markerless": true,
    "sourceCommit": "e960af71a657f12acd799ff0dfdca63af7f59914",
    "gitBlobSha": "1e5adf8fc013c62d186aa7e04556570fa3ab174f",
    "rawByteLength": 10593,
    "rawSha256": "10b25b39ce0b54aed1738c8821de5e99ec981d48cec7f9991c3aa9e3bdc871bf",
    "lineCount": 281,
    "terminalEolPolicy": "required",
    "openingLine": "# OMC Multi-Agent System",
    "finalLine": "**If ANY checkbox is unchecked, CONTINUE WORKING.**",
    "normalizedSha256": "10b25b39ce0b54aed1738c8821de5e99ec981d48cec7f9991c3aa9e3bdc871bf"
  },
  {
    "id": "legacy-23",
    "markerless": true,
    "sourceCommit": "3a02feb187f1185fc51379a84ad001b114ac12af",
    "gitBlobSha": "3a564f00865a58147f3dfed367275bc161d8f52c",
    "rawByteLength": 10545,
    "rawSha256": "26acc3a11d964e3d10e993dab81597c6670612aee795c2345cf233a6e47c446e",
    "lineCount": 281,
    "terminalEolPolicy": "required",
    "openingLine": "# OMC Multi-Agent System",
    "finalLine": "**If ANY checkbox is unchecked, CONTINUE WORKING.**",
    "normalizedSha256": "26acc3a11d964e3d10e993dab81597c6670612aee795c2345cf233a6e47c446e"
  },
  {
    "id": "legacy-24",
    "markerless": true,
    "sourceCommit": "fc67f6becf94274d5d90960cc3b569f1a599a86a",
    "gitBlobSha": "c01f0039651c1f409a4392d1ec06cad9be6904ef",
    "rawByteLength": 16006,
    "rawSha256": "c52efae4e552bb609d1981fb2be5e43094e47d67234c55be5fee2cf2fea402a5",
    "lineCount": 429,
    "terminalEolPolicy": "required",
    "openingLine": "# Sisyphus Multi-Agent System",
    "finalLine": "The boulder does not stop until it reaches the summit.",
    "normalizedSha256": "c52efae4e552bb609d1981fb2be5e43094e47d67234c55be5fee2cf2fea402a5"
  },
  {
    "id": "legacy-25",
    "markerless": true,
    "sourceCommit": "bec423db11e0f42fbf5564cf4491632910ccb4ca",
    "gitBlobSha": "294d680147912fc43ab5ac0a2f1b1245b9335fa9",
    "rawByteLength": 14558,
    "rawSha256": "cfc8b1ba385478df53b7e563796f46fc7559bb586a3f0bff1bc3ac3a023a0c02",
    "lineCount": 388,
    "terminalEolPolicy": "required",
    "openingLine": "# Sisyphus Multi-Agent System",
    "finalLine": "The boulder does not stop until it reaches the summit.",
    "normalizedSha256": "cfc8b1ba385478df53b7e563796f46fc7559bb586a3f0bff1bc3ac3a023a0c02"
  },
  {
    "id": "legacy-26",
    "markerless": true,
    "sourceCommit": "d1fb3661a04b9dd4732a843433ca8145241a3b14",
    "gitBlobSha": "62706f8b0e5e1461d402584fe445e0d5e33ade39",
    "rawByteLength": 12497,
    "rawSha256": "473dfa3d90e77e3c230eb8b7b40f5fe20efdb0074d6980eaae403c986b1f697e",
    "lineCount": 296,
    "terminalEolPolicy": "required",
    "openingLine": "# Sisyphus Multi-Agent System",
    "finalLine": "The boulder does not stop until it reaches the summit.",
    "normalizedSha256": "473dfa3d90e77e3c230eb8b7b40f5fe20efdb0074d6980eaae403c986b1f697e"
  },
  {
    "id": "legacy-27",
    "markerless": true,
    "sourceCommit": "7d430e24cb86bbf64797acb02859912d430a90f7",
    "gitBlobSha": "e96516c9b67ba05c15ec107414deac6e7385f1ce",
    "rawByteLength": 9452,
    "rawSha256": "5952359db681ac7c7049f7336d1f80d1378a1f9b2673ebe748a20ae4f6bac12f",
    "lineCount": 222,
    "terminalEolPolicy": "required",
    "openingLine": "# Sisyphus Multi-Agent System",
    "finalLine": "The boulder does not stop until it reaches the summit.",
    "normalizedSha256": "5952359db681ac7c7049f7336d1f80d1378a1f9b2673ebe748a20ae4f6bac12f"
  },
  {
    "id": "legacy-28",
    "markerless": true,
    "sourceCommit": "ca3cae5354ed69a95b2d698e88f75082f281feed",
    "gitBlobSha": "30932adbdce0785044f8c5658aa738d15607e1f9",
    "rawByteLength": 8602,
    "rawSha256": "9a3b6b770209537568fc7677e14b830d9ba3beeefddf18ad8c7d92705d296035",
    "lineCount": 220,
    "terminalEolPolicy": "required",
    "openingLine": "# Sisyphus Multi-Agent System",
    "finalLine": "The boulder does not stop until it reaches the summit.",
    "normalizedSha256": "9a3b6b770209537568fc7677e14b830d9ba3beeefddf18ad8c7d92705d296035"
  },
  {
    "id": "legacy-29",
    "markerless": true,
    "sourceCommit": "962663164b6a56b9c15085361e8a8fc24f94cca3",
    "gitBlobSha": "df2cf2ed833ed36c09602db1e528d06ba965308e",
    "rawByteLength": 6968,
    "rawSha256": "81bbc6ca37b886205e4d0648654fefeed28684d8671ad527c45905cb703974be",
    "lineCount": 168,
    "terminalEolPolicy": "required",
    "openingLine": "# Sisyphus Multi-Agent System",
    "finalLine": "The boulder does not stop until it reaches the summit.",
    "normalizedSha256": "81bbc6ca37b886205e4d0648654fefeed28684d8671ad527c45905cb703974be"
  }
];

// src/installer/claude-md-analysis.ts
function decodeClaudeMdUtf8(bytes, path) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`Invalid UTF-8: ${path}`);
  }
}
var OMC_START_MARKER = "<!-- OMC:START -->";
var OMC_END_MARKER = "<!-- OMC:END -->";
function emptyCounters() {
  return { lineVisits: 0, parserSteps: 0, candidateWindows: 0, bytesHashed: 0 };
}
function hasBareCarriageReturn(content) {
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\r" && content[index + 1] !== "\n") return true;
  }
  return false;
}
function parseClaudeMdLines(content) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < content.length; ) {
    if (content[index] !== "\n") {
      index += 1;
      continue;
    }
    const contentEnd = index > start && content[index - 1] === "\r" ? index - 1 : index;
    lines.push({ start, contentEnd, eolEnd: index + 1, text: content.slice(start, contentEnd), eol: contentEnd === index ? "\n" : "\r\n" });
    start = index + 1;
    index += 1;
  }
  if (start < content.length) lines.push({ start, contentEnd: content.length, eolEnd: content.length, text: content.slice(start), eol: "" });
  return lines;
}
function outsideRanges(length, managedRanges) {
  const result = [];
  let cursor = 0;
  for (const range of managedRanges) {
    if (cursor < range.start) result.push({ start: cursor, end: range.start });
    cursor = range.end;
  }
  if (cursor < length) result.push({ start: cursor, end: length });
  return result;
}
function parseClaudeMdMarkers(content) {
  const counters = emptyCounters();
  const lines = parseClaudeMdLines(content);
  counters.lineVisits = lines.length;
  counters.parserSteps = lines.length;
  const diagnostics = [];
  if (hasBareCarriageReturn(content)) diagnostics.push("bare-carriage-return");
  const pairs = [];
  let open;
  let sawMarker = false;
  for (const line of lines) {
    if (line.text !== OMC_START_MARKER && line.text !== OMC_END_MARKER) continue;
    sawMarker = true;
    counters.parserSteps += 2;
    if (line.text === OMC_START_MARKER) {
      if (open) diagnostics.push("nested-or-duplicate-start");
      else open = line;
    } else if (!open) {
      diagnostics.push("unmatched-end");
    } else {
      pairs.push({ start: open.start, contentStart: open.eolEnd, contentEnd: line.start, end: line.eolEnd });
      open = void 0;
    }
  }
  if (open) diagnostics.push("unmatched-start");
  if (diagnostics.length > 0) return { state: "corrupt", lines, managedRanges: [], outsideRanges: [{ start: 0, end: content.length }], diagnostics, counters };
  if (!sawMarker) return { state: "none", lines, managedRanges: [], outsideRanges: content.length ? [{ start: 0, end: content.length }] : [], diagnostics, counters };
  return { state: "complete", lines, managedRanges: pairs, outsideRanges: outsideRanges(content.length, pairs), diagnostics, counters };
}
function normalizedWindow(lines, start, count) {
  let value = "";
  for (let index = start; index < start + count; index += 1) {
    const line = lines[index];
    value += line.text;
    if (line.eol) value += "\n";
  }
  return value;
}
function analyzeLegacyClaudeMd(content) {
  const markers = parseClaudeMdMarkers(content);
  const counters = { ...markers.counters };
  if (markers.state === "corrupt") return { markers, exactMatches: [], manualFindings: [], counters };
  const variantsByOpening = /* @__PURE__ */ new Map();
  for (const variant of LEGACY_CLAUDE_MD_VARIANTS) {
    const variants = variantsByOpening.get(variant.openingLine) ?? [];
    variants.push(variant);
    variantsByOpening.set(variant.openingLine, variants);
  }
  const rawMatches = [];
  const manuals = [];
  let lineCursor = 0;
  for (const segment of markers.outsideRanges) {
    while (lineCursor < markers.lines.length && markers.lines[lineCursor].eolEnd <= segment.start) lineCursor += 1;
    const segmentStart = lineCursor;
    while (lineCursor < markers.lines.length && markers.lines[lineCursor].eolEnd <= segment.end) lineCursor += 1;
    const segmentLines = markers.lines.slice(segmentStart, lineCursor);
    counters.lineVisits += segmentLines.length;
    for (let start = 0; start < segmentLines.length; start += 1) {
      const candidates = variantsByOpening.get(segmentLines[start].text);
      if (!candidates) continue;
      let exactAtStart = false;
      for (const variant of candidates) {
        const last = segmentLines[start + variant.lineCount - 1];
        if (!last || last.text !== variant.finalLine) continue;
        if (variant.terminalEolPolicy === "required" && !last.eol) continue;
        if (variant.terminalEolPolicy === "forbidden" && last.eol) continue;
        const normalized = normalizedWindow(segmentLines, start, variant.lineCount);
        counters.candidateWindows += 1;
        const bytes = Buffer.byteLength(normalized, "utf8");
        counters.bytesHashed += bytes;
        const digest = (0, import_crypto.createHash)("sha256").update(normalized, "utf8").digest("hex");
        if (digest === variant.normalizedSha256) {
          rawMatches.push({ start: segmentLines[start].start, end: last.eolEnd, variantId: variant.id });
          exactAtStart = true;
        }
      }
      if (!exactAtStart && candidates.length > 0) {
        const longest = Math.max(...candidates.map((variant) => variant.lineCount));
        const endLine = segmentLines[Math.min(segmentLines.length - 1, start + longest - 1)];
        manuals.push({ start: segmentLines[start].start, end: endLine.eolEnd, reason: "legacy-opening-line-without-exact-identity" });
      }
    }
  }
  const sameStart = /* @__PURE__ */ new Map();
  for (const match of rawMatches) {
    const current = sameStart.get(match.start);
    if (!current || match.end > current.end) sameStart.set(match.start, match);
  }
  const sorted = [...sameStart.values()].sort((left, right) => left.start - right.start || right.end - left.end);
  const accepted = [];
  for (let index = 0; index < sorted.length; ) {
    let end = sorted[index].end;
    let cursor = index + 1;
    while (cursor < sorted.length && sorted[cursor].start < end) {
      end = Math.max(end, sorted[cursor].end);
      cursor += 1;
    }
    if (cursor === index + 1) accepted.push(sorted[index]);
    else manuals.push({ start: sorted[index].start, end, reason: "overlapping-exact-candidates" });
    index = cursor;
  }
  const exactRanges = accepted.map((match) => ({ start: match.start, end: match.end }));
  const manualFindings = manuals.filter((manual) => !exactRanges.some((exact) => manual.start >= exact.start && manual.end <= exact.end));
  return { markers, exactMatches: accepted, manualFindings, counters };
}
function removeClaudeMdRanges(content, ranges) {
  const ordered = [...ranges].sort((left, right) => right.start - left.start || right.end - left.end);
  let result = content;
  let previousStart = content.length + 1;
  for (const range of ordered) {
    if (range.start < 0 || range.end < range.start || range.end > content.length || range.end > previousStart) {
      throw new Error("Claude MD ranges must be disjoint source ranges");
    }
    result = result.slice(0, range.start) + result.slice(range.end);
    previousStart = range.start;
  }
  return result;
}

// src/installer/claude-md-transaction.ts
var CLAUDE_MD_IMPORT_START = "<!-- OMC:IMPORT:START -->";
var CLAUDE_MD_IMPORT_END = "<!-- OMC:IMPORT:END -->";
var CLAUDE_MD_IMPORT_BLOCK = `${CLAUDE_MD_IMPORT_START}
@CLAUDE-omc.md
${CLAUDE_MD_IMPORT_END}
`;
var defaultFs = nodeFs;
function message(error) {
  return error instanceof Error ? error.message : String(error);
}
function publicOperation(operation) {
  return { path: operation.path, type: operation.type, existedBefore: operation.existedBefore };
}
function failure(request, code, error, phase, path) {
  return { ok: false, exitCode: code, mode: request.mode, operations: [], completedOperations: [], backups: [], createdPaths: [], deletedPaths: [], mutatedPaths: [], removedRanges: [], removedVariants: [], warnings: [], error, failedPhase: phase, failedPath: path, rollback: [], tempCleanup: [] };
}
function decodeClaudeMdUtf82(bytes, path) {
  return decodeClaudeMdUtf8(bytes, path);
}
function isStrictChildPath(root, candidate, path = nativePath) {
  if (/^(?:\\\\|\/\/)[?.](?:\\|\/)/.test(root) || /^(?:\\\\|\/\/)[?.](?:\\|\/)/.test(candidate)) return false;
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  const rel = path.relative(normalizedRoot, normalizedCandidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${nativePath.sep}`) && !rel.startsWith("../") && !rel.startsWith("..\\") && !path.isAbsolute(rel);
}
function validateRootedRegularFile(root, path, allowAbsent = true, fs = defaultFs) {
  const normalizedRoot = nativePath.resolve(root);
  const normalizedPath = nativePath.resolve(path);
  if (!isStrictChildPath(root, path)) {
    if (normalizedRoot === normalizedPath) throw new Error(`Not a regular file: ${normalizedPath}`);
    throw new Error(`Path escapes root: ${path}`);
  }
  if (!fs.existsSync(normalizedPath)) {
    if (allowAbsent) return normalizedPath;
    throw new Error(`Missing path: ${normalizedPath}`);
  }
  const stat = fs.lstatSync(normalizedPath);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${normalizedPath}`);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${normalizedPath}`);
  return normalizedPath;
}
function cleanCanonical(source) {
  const markers = parseClaudeMdMarkers(source);
  if (markers.state === "corrupt") throw new Error(`Canonical source has corrupt OMC markers: ${markers.diagnostics.join(", ")}`);
  if (markers.state !== "complete" || markers.managedRanges.length !== 1) throw new Error("Canonical source missing required OMC markers or does not contain exactly one complete managed block");
  const range = markers.managedRanges[0];
  return source.slice(range.contentStart, range.contentEnd).replace(/\r?\n$/, "");
}
function renderManaged(canonical, version) {
  const body = cleanCanonical(canonical).replace(/<!-- OMC:VERSION:[^\s]*? -->\r?\n?/g, "");
  return `${OMC_START_MARKER}
${version ? `<!-- OMC:VERSION:${version} -->
` : ""}${body}
${OMC_END_MARKER}
`;
}
function importRanges(content) {
  const lines = parseClaudeMdMarkers(content).lines;
  const ranges = [];
  for (let index = 0; index + 2 < lines.length; index += 1) {
    if (lines[index].text === CLAUDE_MD_IMPORT_START && lines[index + 1].text === "@CLAUDE-omc.md" && lines[index + 2].text === CLAUDE_MD_IMPORT_END) {
      ranges.push({ start: lines[index].start, end: lines[index + 2].eolEnd });
      index += 2;
    }
  }
  return ranges;
}
function generatedHeaderRanges(markers) {
  const generatedHeaders = /* @__PURE__ */ new Set(["<!-- User customizations -->", "<!-- User customizations (recovered from corrupted markers) -->"]);
  const ranges = [];
  for (let index = 1; index < markers.lines.length; index += 1) {
    const header = markers.lines[index];
    const separator = markers.lines[index - 1];
    if (!generatedHeaders.has(header.text) || separator.text !== "") continue;
    if (markers.managedRanges.some((range) => range.end === separator.start)) {
      ranges.push({ start: separator.start, end: header.eolEnd });
    }
  }
  return ranges;
}
function cleanedExisting(content) {
  const analysis = analyzeLegacyClaudeMd(content);
  if (analysis.markers.state === "corrupt") throw new Error(`Existing CLAUDE.md has corrupt OMC markers: ${analysis.markers.diagnostics.join(", ")}`);
  const imports = importRanges(content).filter((range) => analysis.markers.outsideRanges.some((outside) => range.start >= outside.start && range.end <= outside.end));
  const ranges = [...analysis.markers.managedRanges, ...analysis.exactMatches, ...imports, ...generatedHeaderRanges(analysis.markers)];
  return { content: removeClaudeMdRanges(content, ranges), ranges, variants: analysis.exactMatches.map((match) => match.variantId) };
}
function mergeForOverwrite(existing, canonical, version) {
  const managed = renderManaged(canonical, version);
  if (existing === null) return { content: managed, ranges: [], variants: [] };
  const cleaned = cleanedExisting(existing);
  return { content: cleaned.content.length === 0 ? managed : `${managed}
<!-- User customizations -->
${cleaned.content}`, ranges: cleaned.ranges, variants: cleaned.variants };
}
function exclusiveVerifiedBackup(state, fs) {
  const directory = (0, import_node_path.dirname)(state.path);
  const stem = `${(0, import_node_path.basename)(state.path)}.backup.${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}`;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const backup = `${directory}/${stem}.${(0, import_node_crypto.randomBytes)(12).toString("hex")}`;
    try {
      const fd = fs.openSync(backup, "wx", 384);
      try {
        fs.writeFileSync(fd, state.bytes);
      } finally {
        fs.closeSync(fd);
      }
      if (!fs.readFileSync(backup).equals(state.bytes)) throw new Error(`Backup readback mismatch: ${backup}`);
      return backup;
    } catch (error) {
      try {
        fs.unlinkSync(backup);
      } catch {
      }
      if (attempt === 15) throw error;
    }
  }
  throw new Error("Unable to create backup");
}
function atomicWrite(operation, fs) {
  const directory = (0, import_node_path.dirname)(operation.path);
  fs.mkdirSync(directory, { recursive: true });
  operation.tempPath = `${directory}/.${(0, import_node_path.basename)(operation.path)}.omc-tmp-${(0, import_node_crypto.randomBytes)(12).toString("hex")}`;
  fs.writeFileSync(operation.tempPath, operation.bytes, { flag: "wx", mode: 384 });
  fs.renameSync(operation.tempPath, operation.path);
  operation.tempPath = void 0;
}
function cleanupTemps(operations, result, fs) {
  for (const operation of operations) if (operation.tempPath) {
    const tempPath = operation.tempPath;
    try {
      fs.rmSync(tempPath, { force: true });
      result.tempCleanup.push({ path: tempPath, ok: true });
    } catch (error) {
      result.tempCleanup.push({ path: tempPath, ok: false, error: message(error) });
    }
  }
}
function executeClaudeMdTransaction(request) {
  const fs = request.fs ?? defaultFs;
  let root;
  let sourcePath;
  try {
    root = (0, import_node_path.resolve)(request.root);
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Invalid transaction root: ${root}`);
    sourcePath = validateRootedRegularFile(request.sourceRoot ?? root, request.source, !request.sourceBytes, fs);
  } catch (error) {
    return failure(request, 3, message(error), "validation");
  }
  const main2 = (0, import_node_path.resolve)(root, "CLAUDE.md");
  const companion = (0, import_node_path.resolve)(root, "CLAUDE-omc.md");
  try {
    validateRootedRegularFile(root, main2, true, fs);
    if (request.mode !== "local") validateRootedRegularFile(root, companion, true, fs);
    const canonical = decodeClaudeMdUtf82(request.sourceBytes ?? fs.readFileSync(sourcePath), sourcePath);
    const mainBytes = fs.existsSync(main2) ? fs.readFileSync(main2) : void 0;
    const companionBytes = fs.existsSync(companion) ? fs.readFileSync(companion) : void 0;
    const mainText = mainBytes ? decodeClaudeMdUtf82(mainBytes, main2) : null;
    if (companionBytes) decodeClaudeMdUtf82(companionBytes, companion);
    const overwrite = request.mode === "global-preserve" ? { content: "", ranges: [], variants: [] } : mergeForOverwrite(mainText, canonical, request.version);
    const preserve = mainText === null ? { content: "", ranges: [], variants: [] } : request.mode === "global-preserve" ? cleanedExisting(mainText) : { content: "", ranges: [], variants: [] };
    if (request.mode !== "local" && companionBytes && parseClaudeMdMarkers(decodeClaudeMdUtf82(companionBytes, companion)).state === "corrupt") throw new Error("Existing companion has corrupt OMC markers");
    const operations = [];
    if (request.mode === "local") operations.push({ path: main2, type: "write", existedBefore: !!mainBytes, bytes: Buffer.from(overwrite.content, "utf8") });
    else if (request.mode === "global-overwrite") {
      operations.push({ path: main2, type: "write", existedBefore: !!mainBytes, bytes: Buffer.from(overwrite.content, "utf8") });
      if (companionBytes) operations.push({ path: companion, type: "delete", existedBefore: true });
    } else {
      const imports = mainText === null ? [] : importRanges(mainText);
      const mainIsAlreadyOwned = imports.length > 0 && preserve.ranges.length === imports.length;
      const mainContent = mainIsAlreadyOwned && mainBytes !== void 0 ? mainBytes : Buffer.from(`${preserve.content}${preserve.content.length ? "\n\n" : ""}${CLAUDE_MD_IMPORT_BLOCK}`, "utf8");
      operations.push({ path: companion, type: "write", existedBefore: !!companionBytes, bytes: Buffer.from(renderManaged(canonical, request.version), "utf8") });
      operations.push({ path: main2, type: "write", existedBefore: !!mainBytes, bytes: mainContent });
    }
    const effectiveOperations = operations.filter((operation) => {
      if (operation.type === "delete") return operation.existedBefore;
      const existingBytes = operation.path === main2 ? mainBytes : companionBytes;
      const plannedBytes = operation.bytes;
      if (plannedBytes === void 0) throw new Error(`Missing write bytes: ${operation.path}`);
      return existingBytes === void 0 || !plannedBytes.equals(existingBytes);
    });
    const states = new Map(effectiveOperations.map((operation) => [operation.path, { path: operation.path, existedBefore: operation.existedBefore, bytes: operation.path === main2 ? mainBytes : companionBytes }]));
    const appliedMainCleanup = effectiveOperations.some((operation) => operation.path === main2);
    const result = { ok: false, exitCode: 0, mode: request.mode, operations: effectiveOperations.map(publicOperation), completedOperations: [], backups: [], createdPaths: [], deletedPaths: [], mutatedPaths: [], removedRanges: appliedMainCleanup ? request.mode === "global-preserve" ? preserve.ranges : overwrite.ranges : [], removedVariants: appliedMainCleanup ? request.mode === "global-preserve" ? preserve.variants : overwrite.variants : [], warnings: [], rollback: [], tempCleanup: [] };
    try {
      for (const state of states.values()) if (state.existedBefore) {
        state.backupPath = exclusiveVerifiedBackup(state, fs);
        result.backups.push(state.backupPath);
      }
    } catch (error) {
      result.exitCode = 4;
      result.error = message(error);
      result.failedPhase = "backup";
      return result;
    }
    try {
      for (const operation of effectiveOperations) {
        if (operation.type === "write") atomicWrite(operation, fs);
        else fs.unlinkSync(operation.path);
        result.completedOperations.push(publicOperation(operation));
        result.mutatedPaths.push(operation.path);
        if (!operation.existedBefore && operation.type === "write") result.createdPaths.push(operation.path);
        if (operation.type === "delete") result.deletedPaths.push(operation.path);
      }
      result.ok = true;
      result.exitCode = 0;
      return result;
    } catch (error) {
      result.error = message(error);
      result.failedPhase = "mutation";
      result.failedPath = effectiveOperations.find((operation) => !result.completedOperations.some((done) => done.path === operation.path))?.path;
      const rollbackOperations = [];
      for (const operation of [...result.completedOperations].reverse()) {
        const state = states.get(operation.path);
        try {
          if (state.existedBefore) {
            const rollbackOperation = { path: state.path, type: "write", existedBefore: true, bytes: state.bytes };
            rollbackOperations.push(rollbackOperation);
            atomicWrite(rollbackOperation, fs);
          } else if (fs.existsSync(state.path)) fs.unlinkSync(state.path);
          result.rollback.push({ path: state.path, ok: true });
        } catch (rollbackError) {
          result.failedPhase = "rollback";
          result.failedPath = state.path;
          result.rollback.push({ path: state.path, ok: false, error: message(rollbackError) });
        }
      }
      cleanupTemps([...effectiveOperations, ...rollbackOperations], result, fs);
      result.exitCode = result.rollback.every((item) => item.ok) && result.tempCleanup.every((item) => item.ok) ? 5 : 6;
      return result;
    }
  } catch (error) {
    return failure(request, 3, message(error), "validation");
  }
}

// src/cli/claude-md-coordinator.ts
var CLAUDE_MD_COORDINATOR_SCHEMA_VERSION = 1;
var COMPILED_ENGINE_VERSION = true ? "4.15.6" : "";
var COMPILED_SOURCE_SHA256 = true ? "e3f8b38cb0e1e6d443e723ec6b22887aa1bdb364a62055b8d946a9de2e05ec58" : "";
function runClaudeMdCoordinatorHandshake() {
  if (!COMPILED_ENGINE_VERSION || !COMPILED_SOURCE_SHA256) {
    return { exitCode: 2, response: coordinatorError(2, "Coordinator build handshake is unavailable") };
  }
  return { exitCode: 0, response: { schemaVersion: CLAUDE_MD_COORDINATOR_SCHEMA_VERSION, engineVersion: COMPILED_ENGINE_VERSION, sourceSha256: COMPILED_SOURCE_SHA256 } };
}
function coordinatorError(exitCode, error) {
  return { ok: false, exitCode, error, schemaVersion: CLAUDE_MD_COORDINATOR_SCHEMA_VERSION };
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function verifiedSource(pluginRootInput, sourceInput) {
  const pluginRoot = (0, import_node_path2.resolve)(pluginRootInput);
  const sourcePath = (0, import_node_path2.resolve)(sourceInput);
  if (!isStrictChildPath(pluginRootInput, sourceInput)) throw new Error("Source must be inside plugin root");
  if ((0, import_node_fs.lstatSync)(pluginRoot).isSymbolicLink()) throw new Error("Plugin root must not be a symbolic link");
  const rootReal = (0, import_node_fs.realpathSync)(pluginRoot);
  let component = pluginRoot;
  const suffix = (0, import_node_path2.relative)(pluginRoot, sourcePath).split(/[\\/]/);
  for (const part of suffix) {
    component = (0, import_node_path2.resolve)(component, part);
    if ((0, import_node_fs.lstatSync)(component).isSymbolicLink()) throw new Error("Source path must not traverse a symbolic link");
  }
  const stat = (0, import_node_fs.lstatSync)(sourcePath);
  if (!stat.isFile()) throw new Error("Source must be a regular file");
  const sourceReal = (0, import_node_fs.realpathSync)(sourcePath);
  if (!isStrictChildPath(rootReal, sourceReal)) throw new Error("Resolved source escapes plugin root");
  return { pluginRoot, sourcePath, bytes: (0, import_node_fs.readFileSync)(sourcePath) };
}
function runClaudeMdCoordinator(input) {
  try {
    if (!isObject(input)) return { exitCode: 2, response: coordinatorError(2, "Request must be an object") };
    const allowed = /* @__PURE__ */ new Set(["schemaVersion", "engineVersion", "mode", "configRoot", "pluginRoot", "sourcePath", "sourceSha256", "sourceVersion"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) return { exitCode: 2, response: coordinatorError(2, "Unknown request field") };
    const { mode } = input;
    if (input.schemaVersion !== CLAUDE_MD_COORDINATOR_SCHEMA_VERSION || input.engineVersion !== COMPILED_ENGINE_VERSION || mode !== "local" && mode !== "global-overwrite" && mode !== "global-preserve" || typeof input.configRoot !== "string" || typeof input.pluginRoot !== "string" || typeof input.sourcePath !== "string" || typeof input.sourceSha256 !== "string" || typeof input.sourceVersion !== "string") return { exitCode: 2, response: coordinatorError(2, "Invalid coordinator request") };
    if (!COMPILED_ENGINE_VERSION || !COMPILED_SOURCE_SHA256) return { exitCode: 2, response: coordinatorError(2, "Coordinator build handshake is unavailable") };
    const source = verifiedSource(input.pluginRoot, input.sourcePath);
    const sourceSha256 = (0, import_node_crypto2.createHash)("sha256").update(source.bytes).digest("hex");
    if (sourceSha256 !== COMPILED_SOURCE_SHA256 || input.sourceSha256 !== COMPILED_SOURCE_SHA256 || input.sourceVersion !== COMPILED_ENGINE_VERSION) return { exitCode: 2, response: coordinatorError(2, "Canonical source handshake mismatch") };
    const result = executeClaudeMdTransaction({ mode, root: input.configRoot, source: source.sourcePath, sourceRoot: source.pluginRoot, sourceBytes: source.bytes, version: input.sourceVersion });
    return { exitCode: result.exitCode, response: result };
  } catch (error) {
    return { exitCode: 3, response: coordinatorError(3, `Coordinator I/O validation failed: ${error instanceof Error ? error.message : String(error)}`) };
  }
}
function main() {
  if (process.argv.slice(2).length === 1 && process.argv[2] === "--handshake") {
    const outcome2 = runClaudeMdCoordinatorHandshake();
    process.stdout.write(`${JSON.stringify(outcome2.response)}
`);
    process.exitCode = outcome2.exitCode;
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode((0, import_node_fs.readFileSync)(0)));
  } catch {
    process.stdout.write(`${JSON.stringify(coordinatorError(2, "Malformed UTF-8 JSON request"))}
`);
    process.exitCode = 2;
    return;
  }
  const outcome = runClaudeMdCoordinator(parsed);
  process.stdout.write(`${JSON.stringify(outcome.response)}
`);
  process.exitCode = outcome.exitCode;
}
if (process.argv[1] && /claude-md-coordinator\.(?:[cm]?js|ts)$/.test(process.argv[1])) main();
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CLAUDE_MD_COORDINATOR_SCHEMA_VERSION,
  runClaudeMdCoordinator,
  runClaudeMdCoordinatorHandshake
});

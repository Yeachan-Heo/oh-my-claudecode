import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // 안 쓰는 변수 잡기 (핵심)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // 안 쓰는 import 잡기
      "no-unused-vars": "off",
      // any 허용 (점진적 타입 강화)
      "@typescript-eslint/no-explicit-any": "warn",
      // require 금지 (ESM 사용)
      "@typescript-eslint/no-require-imports": "error",
    },
  },
  {
    ignores: [
      "node_modules/",
      "dist/",
      "data/",
      "agent-town/",
      "**/_*.ts",
      "memory-graph/",
      "claude-memory-mcp/",
      "personal-kg-mcp/",
      "trustgraph/",
    ],
  }
);

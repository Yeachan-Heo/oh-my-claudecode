import type { NextConfig } from "next";

const extraConnectSrc = process.env.CSP_CONNECT_SRC ?? "";

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      [
        "connect-src 'self'",
        "ws://localhost:* ws://127.0.0.1:* wss://localhost:* wss://127.0.0.1:*",
        extraConnectSrc,
      ]
        .filter(Boolean)
        .join(" "),
      "media-src 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: __dirname,
  },
  env: {
    NEXT_PUBLIC_AGENT_PROVIDER: process.env.AGENT_PROVIDER ?? "openclaw",
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;

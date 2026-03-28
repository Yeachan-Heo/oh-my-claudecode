[38;5;8m   1[0m [37m/**[0m
[38;5;8m   2[0m [37m * OMC HUD - Token Speed Element[0m
[38;5;8m   3[0m [37m *[0m
[38;5;8m   4[0m [37m * Renders the token output speed (tokens/second) for the last assistant response.[0m
[38;5;8m   5[0m [37m * Calculated as: outputTokens / elapsed_seconds (from promptTime to lastAssistantTimestamp).[0m
[38;5;8m   6[0m [37m */[0m
[38;5;8m   7[0m 
[38;5;8m   8[0m [37mimport { dim } from '../colors.js';[0m
[38;5;8m   9[0m 
[38;5;8m  10[0m [37m/**[0m
[38;5;8m  11[0m [37m * Render token output speed.[0m
[38;5;8m  12[0m [37m *[0m
[38;5;8m  13[0m [37m * Format: ⚡23tok/s[0m
[38;5;8m  14[0m [37m */[0m
[38;5;8m  15[0m [37mexport function renderTokenSpeed(tokenSpeed: number | null): string | null {[0m
[38;5;8m  16[0m [37m  if (tokenSpeed === null || tokenSpeed <= 0) return null;[0m
[38;5;8m  17[0m [37m  const rounded = Math.round(tokenSpeed);[0m
[38;5;8m  18[0m [37m  return `${dim('⚡')}${rounded}tok/s`;[0m
[38;5;8m  19[0m [37m}[0m

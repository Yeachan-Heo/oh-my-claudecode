declare module "safe-regex" {
  function safe(re: string | RegExp, opts?: { limit?: number }): boolean;
  export default safe;
}

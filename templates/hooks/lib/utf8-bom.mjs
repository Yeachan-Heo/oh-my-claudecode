/** Remove exactly one UTF-8 BOM when it is the first character. */
export function stripLeadingUtf8Bom(content) {
  return content.startsWith('\uFEFF') ? content.slice(1) : content;
}

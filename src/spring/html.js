/** HTML parsing consumes one immediate LF in pre/textarea/listing. The default
 * serializer does not compensate, so a parse/serialize cycle otherwise loses
 * an intentional leading blank line. Restore the caller's DOM after rendering.
 */
export function serializeSpringHTML($) {
  const changed = [];
  for (const element of $('pre,textarea,listing')) {
    const first = element.children?.[0];
    if (first?.type === 'text' && first.data.startsWith('\n')) {
      changed.push([first, first.data]); first.data = '\n' + first.data;
    }
  }
  try { return $.html(); }
  finally { for (const [node, text] of changed) node.data = text; }
}

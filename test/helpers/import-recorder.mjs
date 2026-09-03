// A resolve hook records what Node actually resolves. Unlike a source scan it
// cannot be fooled by a comment, a template literal, a string-named binding,
// `require`, or a dynamic import with options — it observes the real graph.
import fs from 'node:fs';

let out = null;

export function initialize(data) {
  out = data?.out ?? null;
}

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (out && context.parentURL) {
    try {
      fs.appendFileSync(out, `${JSON.stringify({
        parent: context.parentURL,
        specifier,
        url: result.url,
      })}\n`);
    } catch { /* recording is best-effort; the assertion sees what landed */ }
  }
  return result;
}

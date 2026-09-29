export async function resolve(specifier, context, next) {
  if (specifier === '@vercel/blob') return { url: new URL('./tools-dev-blob-stub.mjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}

// Retry a relative, extensionless import with `.ts` when Node can't find it as written.
export async function resolve(specifier, context, nextResolve) {
  // The context pill icon is React Native code; tests get a stub instead.
  if (/\/context-pill-icon$/.test(specifier)) return nextResolve(new URL("./context-pill-icon-stub.mjs", import.meta.url).href, context);
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !/^\.\.?\//.test(specifier) || /\.[cm]?[jt]sx?$/.test(specifier)) {
      throw error;
    }
    return nextResolve(`${specifier}.ts`, context);
  }
}

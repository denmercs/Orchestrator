// Retry a relative, extensionless import with `.ts` when Node can't find it as written.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !/^\.\.?\//.test(specifier) || /\.[cm]?[jt]sx?$/.test(specifier)) {
      throw error;
    }
    return nextResolve(`${specifier}.ts`, context);
  }
}

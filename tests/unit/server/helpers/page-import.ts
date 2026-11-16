/**
 * An import() of one of the page's own modules, as a string for
 * page.evaluate (compiled, an import() in a function becomes a helper the
 * page hasn't got). Den serves every script as <path>?v=<version>, and a
 * bare "/x.js" would be a second copy of the module, with its own state, so
 * this reads the stamp off the page and imports the same URL the page uses.
 */
export function pageImport(path: string): string {
  return `import((() => {
    const v = [...document.querySelectorAll("link[href], script[src]")]
      .map((e) => new URL(e.href || e.src, location.href).searchParams.get("v"))
      .find(Boolean);
    return v ? ${JSON.stringify(path)} + "?v=" + encodeURIComponent(v) : ${JSON.stringify(path)};
  })())`;
}

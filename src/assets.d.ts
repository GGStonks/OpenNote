/** Vite: the URL a bundled file is served at (`import url from '…?url'`). */
declare module '*?url' {
  const url: string;
  export default url;
}
/** Vite: a bundled file's text (`import css from '…?raw'`). */
declare module '*?raw' {
  const text: string;
  export default text;
}
/** Vite: the files a pattern matches, imported at build time. */
interface ImportMeta {
  glob(pattern: string, options: { query?: string; import?: string; eager: true }): Record<string, unknown>;
}

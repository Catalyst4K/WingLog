// Ambient declaration for Vite's `?raw` asset-import suffix in the main process. The
// renderer gets this for free via tsconfig.web.json's "vite/client" types, but that also
// pulls in DOM globals inappropriate for a Node context — this is the same feature,
// scoped to just what src/main actually uses (see aircraft-lookup/icao-types.ts).
declare module '*.csv?raw' {
  const content: string
  export default content
}

declare module '*.json?raw' {
  const content: string
  export default content
}

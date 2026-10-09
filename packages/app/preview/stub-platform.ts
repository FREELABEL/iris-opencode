// Preview stub: fetch answers from fixtures (see main.tsx); openExternal just records the URL.
export const usePlatform = () => ({
  fetch: (input: string, init?: RequestInit) => (window as any).__previewFetch(input, init),
  openExternal: (url: string) => ((window as any).__opened = url),
})

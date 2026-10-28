// Where "Share" sends a chat (#191488, epic #191485).
//
// opencode's share client defaults to opencode's own public servers (opncd.ai), or, for a
// signed-in opencode organisation, to opencode's console. IRIS never changed that, so Share in
// IRIS Desktop and the CLI uploaded people's chats to a third party. Now it goes to IRIS: the
// owner-only share server on fl-iris-api (/api/v6/shares), signed with the person's own IRIS key.
//
// The only other destination is one a person configures on purpose (`enterprise.url`). There is no
// fallback to opncd.ai or to opencode's console: without an IRIS sign-in, Share refuses and says why.

export type ShareApi = {
  create: string
  sync: (shareID: string) => string
  remove: (shareID: string) => string
  data: (shareID: string) => string
}

export type ShareTarget = { headers: Record<string, string>; api: ShareApi; baseUrl: string }

export function shareApi(resource: string): ShareApi {
  return {
    create: `/api/${resource}`,
    sync: (shareID) => `/api/${resource}/${shareID}/sync`,
    remove: (shareID) => `/api/${resource}/${shareID}`,
    data: (shareID) => `/api/${resource}/${shareID}/data`,
  }
}

export class ShareNeedsSignIn extends Error {
  constructor() {
    super("Sharing needs an IRIS sign-in. Sign in to IRIS, then share again.")
  }
}

/**
 * The share server for this engine. `enterpriseUrl` (a deliberate config choice) wins; otherwise
 * IRIS at `irisApi` with `IRIS_API_KEY`. Pure: everything it reads is passed in.
 */
export function irisShareTarget(input: { enterpriseUrl?: string; irisApi: string; irisKey?: string }): ShareTarget {
  if (input.enterpriseUrl) return { headers: {}, api: shareApi("share"), baseUrl: input.enterpriseUrl }
  const key = input.irisKey?.trim()
  if (!key) throw new ShareNeedsSignIn()
  return {
    headers: { authorization: `Bearer ${key}` },
    api: shareApi("v6/shares"),
    baseUrl: input.irisApi.replace(/\/+$/, ""),
  }
}

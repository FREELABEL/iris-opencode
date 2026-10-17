// [IRIS] Provider and model reads return resolved settings, so `{env:IRIS_API_KEY}` came back
// as the key itself to any client holding the server password (#188596). The engine keeps the
// real values; only what leaves over HTTP is masked. A masked value stays truthy, so a client
// that only asks "is a key configured" still gets the right answer.

const SECRET_KEY = /^(api_?key|key|token|access_?token|secret|client_?secret|password|auth(orization)?)$/i
const SECRET_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key|cookie)$/i
const MASK = "[redacted]"

export function redactSecrets<T extends { settings?: object; headers?: Record<string, string> }>(info: T): T {
  return {
    ...info,
    settings: info.settings && mask(info.settings, SECRET_KEY),
    headers: info.headers && mask(info.headers, SECRET_HEADER),
  }
}

function mask<T extends object>(record: T, secret: RegExp): T {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, secret.test(key) && value ? MASK : value]),
  ) as T
}

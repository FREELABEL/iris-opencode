/**
 * KEEP IN SYNC — a verbatim copy of the #192664 brand logo resolver for Desktop (#192667).
 * Sources: fl-iris-api resources/js/lib/brand-logo.ts (PR #330) and its CLI copy
 * packages/opencode/src/cli/cmd/brand-logo.ts (iris-opencode PR #494, branch main). Desktop ships
 * from iris/1.18.23, which has neither, so it carries its own copy. Its test
 * (iris-brand-logo.test.ts) runs fl-iris-api's tests/Fixtures/brand-logo-cases.json, copied beside
 * it as iris-brand-logo.cases.json: change the resolver or the fixture there, copy both here.
 */
/**
 * The brand's logo, and which one to show on a given background (#192664, epic #192663).
 *
 * A copy of fl-iris-api's resources/js/lib/brand-logo.ts (whose PHP twin, app/Support/BrandLogo.php,
 * every server surface uses). Copied, not shared — the CLI ships without fl-iris-api — so its test
 * (brand-logo.test.ts) runs the same cases as fl-iris-api's tests/Fixtures/brand-logo-cases.json.
 * Change one, change both.
 *
 * THE SHAPE — design_tokens.brand.logo: primary · on_dark · on_light · icon · social (URLs).
 * THE RULE — light ground → on_light, dark → on_dark, else primary on a tile unless its tone is
 * known to suit the ground; never a mark that vanishes into the page (#184115).
 *
 *   logoFor(brand, background) → { url, variant, tile, ground, reason } | null
 *
 * `brand` is a brand's design_tokens in any stored shape, the public payload ({name,
 * design_tokens}), or the `theme.branding.logo` variants the page renderer passes down.
 * `background` is a hex colour or 'light' / 'dark'. Render `tile` (when set) as a solid ground
 * behind the mark — it is what keeps a mark that does not suit the page from vanishing.
 */

export type LogoVariant = 'primary' | 'on_dark' | 'on_light' | 'icon' | 'social';
export type LogoVariants = Record<LogoVariant, string | null>;
export interface ResolvedLogo {
    url: string;
    variant: LogoVariant;
    /** Paint this colour behind the mark; null = place it straight on the page. */
    tile: string | null;
    ground: 'light' | 'dark';
    reason: string;
}

export const VARIANTS: LogoVariant[] = ['primary', 'on_dark', 'on_light', 'icon', 'social'];
/** WCAG relative luminance at which black and white text have equal contrast. Above → light. */
export const LIGHT_ABOVE = 0.179;
export const DARK_TILE = '#0a0a0a';
export const LIGHT_TILE = '#ffffff';

const ALIASES: Record<string, LogoVariant> = {
    primary: 'primary', full: 'primary', default: 'primary', main: 'primary',
    on_dark: 'on_dark', onDark: 'on_dark', 'on-dark': 'on_dark', for_dark: 'on_dark',
    on_light: 'on_light', onLight: 'on_light', 'on-light': 'on_light', for_light: 'on_light',
    icon: 'icon', mark: 'icon', monogram: 'icon', favicon: 'icon',
    social: 'social', og: 'social', share: 'social',
};

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function unwrap(tokens: unknown): Obj | null {
    if (!isObj(tokens)) return null;
    return isObj(tokens.design_tokens) ? tokens.design_tokens : tokens;
}

function url(value: unknown): string | null {
    if (isObj(value)) value = value.url ?? value.src;
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return /^(https?:\/\/|\/(?!\/))\S+$/i.test(v) ? v : null;
}

/** The five variants, each a URL or null, from tokens in any stored shape. */
export function logoVariants(tokens: unknown): LogoVariants {
    const out = Object.fromEntries(VARIANTS.map((k) => [k, null])) as LogoVariants;
    const t = unwrap(tokens);
    if (!t) return out;
    const logo = t.logo;
    const sources: unknown[] = [
        t.brand?.logo,
        t.logos,
        logo === undefined ? null : isObj(logo) && logo.url === undefined ? logo : { primary: logo },
        isObj(t.branding) ? { primary: t.branding.logoUrl, icon: t.branding.faviconUrl } : null,
        // Already-resolved variants (theme.branding.logo) pass straight through.
        VARIANTS.some((k) => k in t) ? t : null,
    ];
    for (let src of sources) {
        if (typeof src === 'string') src = { primary: src };
        if (!isObj(src)) continue;
        for (const [key, value] of Object.entries(src)) {
            const variant = ALIASES[key];
            const u = variant && out[variant] === null ? url(value) : null;
            if (variant && u) out[variant] = u;
        }
    }
    return out;
}

/** WCAG relative luminance of #rgb / #rrggbb / #rrggbbaa; null if not a hex colour. */
export function luminance(hex: string): number | null {
    let h = hex.trim().replace(/^#/, '');
    if (!/^([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) return null;
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const lin = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(parseInt(h.slice(0, 2), 16)) + 0.7152 * lin(parseInt(h.slice(2, 4), 16)) + 0.0722 * lin(parseInt(h.slice(4, 6), 16));
}

/** True for a light ground, false for dark, null when unreadable. */
export function isLight(background: string | null | undefined): boolean | null {
    if (background == null) return null;
    const b = String(background).trim().toLowerCase();
    if (b === 'light' || b === 'white') return true;
    if (b === 'dark' || b === 'black') return false;
    const l = luminance(b);
    return l === null ? null : l > LIGHT_ABOVE;
}

/** A colour token's hex: a string, or {DEFAULT}/{500}/first hex of a scale. */
export function hex(value: unknown): string | null {
    if (typeof value === 'string') {
        const v = value.trim();
        return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ? v : null;
    }
    if (!isObj(value)) return null;
    for (const k of ['DEFAULT', 'default', '500', 'value']) {
        const h = k in value ? hex(value[k]) : null;
        if (h) return h;
    }
    for (const v of Object.values(value)) {
        const h = typeof v === 'string' ? hex(v) : null;
        if (h) return h;
    }
    return null;
}

/** The ground the brand designed itself on. */
export function brandBackground(tokens: unknown): string | null {
    const t = unwrap(tokens);
    if (!t) return null;
    return hex(t.semantic?.bg_page) ?? hex(t.colors?.background) ?? hex(t.colors?.bg) ?? hex(t.background);
}

/** The logo to show on `background`. Unreadable background reads as dark (the Genesis default). */
export function logoFor(brand: unknown, background: string | null | undefined): ResolvedLogo | null {
    const t = unwrap(brand);
    const v = logoVariants(t);
    const ground: 'light' | 'dark' = isLight(background) ? 'light' : 'dark';
    const exact: LogoVariant = ground === 'light' ? 'on_light' : 'on_dark';

    if (v[exact]) return { url: v[exact]!, variant: exact, tile: null, ground, reason: `${exact} variant` };

    const variant: LogoVariant | null = v.primary ? 'primary' : v.icon ? 'icon' : null;
    if (!variant) return null;
    const u = v[variant]!;

    const bg = brandBackground(t);
    let tone: 'light' | 'dark' | null = null;
    if (v.on_dark && u === v.on_dark) tone = 'light';
    else if (v.on_light && u === v.on_light) tone = 'dark';
    else if (bg !== null) tone = isLight(bg) ? 'dark' : 'light';

    if (tone !== null && (tone === 'light') === (ground === 'dark')) {
        return { url: u, variant, tile: null, ground, reason: `${variant} is a ${tone} mark, which suits a ${ground} ground` };
    }
    if (tone === null) {
        return { url: u, variant, tile: ground === 'light' ? DARK_TILE : LIGHT_TILE, ground, reason: `no ${exact} variant and the ${variant} mark's tone is unknown — shown on a tile` };
    }
    const tile = bg !== null && isLight(bg) !== (ground === 'light') ? bg : tone === 'light' ? DARK_TILE : LIGHT_TILE;
    return { url: u, variant, tile, ground, reason: `no ${exact} variant — ${variant} (${tone} mark) shown on a tile` };
}


export type LogoCheck = { variant: LogoVariant; url: string; ok: boolean; status: number | null; type: string | null; problem: string | null }

/**
 * Every logo URL must answer 200 with an image (#192664). A 200 that is an HTML error page, a
 * redirect to a login, or a 404 all render as a broken or blank mark on every surface that reads
 * the kit. HEAD first; GET when a host refuses HEAD.
 */
export async function checkLogoUrls(tokens: unknown, fetchImpl: typeof fetch = fetch, timeoutMs = 10000): Promise<LogoCheck[]> {
  const v = logoVariants(tokens)
  const out: LogoCheck[] = []
  for (const variant of VARIANTS) {
    const url = v[variant]
    if (!url) continue
    if (!/^https?:\/\//i.test(url)) {
      out.push({ variant, url, ok: false, status: null, type: null, problem: "not an absolute URL — other sites (emails, Desktop, renders) cannot load a site-relative path" })
      continue
    }
    let status: number | null = null
    let type: string | null = null
    let problem: string | null = null
    try {
      let res = await fetchImpl(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) })
      if (res.status === 405 || res.status === 403 || res.status === 501) {
        res = await fetchImpl(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) })
      }
      status = res.status
      type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() || null
      if (status !== 200) problem = `answered ${status}, not 200`
      else if (!type || !type.startsWith("image/")) problem = `is ${type ?? "an unknown type"}, not an image`
    } catch (e) {
      problem = `could not be fetched (${e instanceof Error ? e.message : String(e)})`
    }
    out.push({ variant, url, ok: problem === null, status, type, problem })
  }
  return out
}

/** What a kit is missing, in the words a person fixing it needs. Empty = complete. */
export function missingVariants(tokens: unknown): string[] {
  const v = logoVariants(tokens)
  const out: string[] = []
  if (!v.primary) out.push("primary — no canonical logo; surfaces fall back to the icon or to text")
  if (!v.on_light) out.push("on_light — light pages show the primary on a tile instead of a mark made for them")
  if (!v.on_dark) out.push("on_dark — dark pages show the primary on a tile instead of a mark made for them")
  if (!v.icon) out.push("icon — no favicon / avatar mark")
  if (!v.social) out.push("social — no share-card image")
  return out
}

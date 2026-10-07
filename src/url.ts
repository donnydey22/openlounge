// Strict, dependency-free URL helpers.
//
// React Native's global `URL` is a small regex shim (Libraries/Blob/URL.js), NOT a WHATWG parser: for example it
// reports host "openlounge.app" for "https://evil.example?@openlounge.app/". Anything that decides whether a page
// may stay in the app or talk to the session bridge must use these helpers instead.

export type ParsedUrl = {
  scheme: string; // lower-case, no ':'
  host: string; // lower-case hostname ('' for opaque URLs like mailto:)
  port: string;
  path: string; // starts with '/', or '' when absent
  query: string; // without '?'
  hash: string; // without '#'
  hasUserInfo: boolean;
};

// scheme://authority path ?query #hash
const HIERARCHICAL = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;

export function parseUrl(raw: string): ParsedUrl | null {
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  // Control characters / whitespace / backslashes are normalised differently by browsers: refuse them outright.
  if (/[\u0000-\u0020\u007f\\]/.test(raw)) return null;
  const m = HIERARCHICAL.exec(raw);
  if (!m) return null;
  const authority = m[2];
  const hasUserInfo = authority.includes('@');
  const hostPort = hasUserInfo ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  const pm = /^([^:]*)(?::(\d*))?$/.exec(hostPort);
  if (!pm) return null;
  return {
    scheme: m[1].toLowerCase(),
    host: pm[1].toLowerCase().replace(/\.$/, ''),
    port: pm[2] ?? '',
    path: m[3],
    query: m[4] ?? '',
    hash: m[5] ?? '',
    hasUserInfo,
  };
}

export function schemeOf(raw: string): string {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  return m ? m[1].toLowerCase() : '';
}

export function queryParam(query: string, name: string): string | null {
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq < 0 ? part : part.slice(0, eq);
    let key: string;
    try {
      key = decodeURIComponent(k.replace(/\+/g, ' '));
    } catch {
      continue;
    }
    if (key !== name) continue;
    const v = eq < 0 ? '' : part.slice(eq + 1);
    try {
      return decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      return null;
    }
  }
  return null;
}

/** A safe same-site path ("/room/abc?x=1"): no scheme, no '//' authority, no traversal, printable ASCII only. */
export function isSafeAppPath(pathAndQuery: string): boolean {
  return (
    pathAndQuery.length <= 2048 &&
    /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/.test(pathAndQuery) &&
    !/(^|\/)\.\.?(\/|$|\?)/.test(pathAndQuery.split('?')[0])
  );
}

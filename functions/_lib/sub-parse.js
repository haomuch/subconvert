/**
 * Parse subscription content in various formats into unified node arrays.
 *
 * Supported input formats:
 * - base64: Base64-encoded list of proxy URIs
 * - clash: Clash/Mihomo YAML config
 * - singbox: Sing-box JSON config
 * - plain: Plain text list of proxy URIs (one per line)
 */

import yaml from './vendor/js-yaml.mjs';
import { parseURI } from './uri-parse.js';
import { b64UrlDecode, tryBase64Decode } from './utils.js';

/**
 * Auto-detect and parse subscription content.
 * @param {string} content - Raw subscription content
 * @returns {{nodes: Array, format: string}}
 */
export function parseSubscription(content) {
  if (!content || !content.trim()) return { nodes: [], format: 'unknown', meta: {} };

  // A subscription may itself be base64-wrapped (e.g. a v2ray base64 list, or a
  // base64-encoded Clash/Sing-box config). Decode it once up front when the
  // decoded payload looks like a subscription so downstream parsers see real YAML/JSON.
  let working = content.trim();
  const decoded = b64UrlDecode(working);
  if (decoded && looksLikeSubscription(decoded)) working = decoded;

  const format = detectFormat(working);
  let nodes = [];
  let meta = {};

  switch (format) {
    case 'base64':
      nodes = parseBase64Sub(working);
      break;
    case 'clash': {
      const r = parseClashSub(working);
      nodes = r.nodes; meta = r.meta;
      break;
    }
    case 'singbox': {
      const r = parseSingboxSub(working);
      nodes = r.nodes; meta = r.meta;
      break;
    }
    case 'plain':
      nodes = parsePlainSub(working);
      break;
  }

  // Capture original names BEFORE dedupe so we can rewrite the proxy-group and
  // rule references carried in `meta` to the final (de-duplicated) names.
  const originals = nodes.map(n => (n.name != null ? String(n.name).trim() : ''));
  nodes = nodes.map(normalizeNode);
  dedupeNames(nodes);

  rebaseMeta(meta, buildRenameMap(nodes, originals));

  return { nodes, format, meta };
}

/**
 * Deep-clone plain config objects. Subscription configs are pure JSON data
 * (no functions/classes), so a round-trip through JSON is safe and avoids
 * mutating the parsed source document when we rewrite references.
 */
function clone(x) {
  try { return JSON.parse(JSON.stringify(x)); } catch { return x; }
}

/**
 * Build a mapping from each node's original name to the final name(s) it was
 * de-duplicated into. When several nodes shared a name, they map to the
 * sequence of unique suffixes (HK -> [HK, HK-2, HK-3, ...]).
 */
function buildRenameMap(nodes, originals) {
  const map = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const orig = originals[i];
    if (!orig) continue;
    if (!map.has(orig)) map.set(orig, []);
    map.get(orig).push(nodes[i].name);
  }
  return map;
}

/**
 * Rewrite proxy-group membership lists and rule targets in `meta` so they
 * point at the de-duplicated node names. Group membership lists consume the
 * rename mapping in order (shift); rule targets peek at the primary instance
 * (so a rule pointing at a renamed proxy still resolves, without starving a
 * group that also referenced it).
 */
function rebaseMeta(meta, map) {
  if (!meta || typeof meta !== 'object') return;

  const rebaseList = (list) => (list || []).map(name => {
    const arr = map.get(name);
    return (arr && arr.length) ? arr.shift() : name;
  });
  const peek = (name) => {
    const arr = map.get(name);
    return (arr && arr.length) ? arr[0] : name;
  };

  if (Array.isArray(meta.proxyGroups)) {
    for (const g of meta.proxyGroups) {
      if (g && Array.isArray(g.proxies)) g.proxies = rebaseList(g.proxies);
    }
  }
  if (Array.isArray(meta.groups)) {
    for (const g of meta.groups) {
      if (g && Array.isArray(g.outbounds)) g.outbounds = rebaseList(g.outbounds);
    }
  }
  if (Array.isArray(meta.rules)) {
    meta.rules = meta.rules.map(r => rebaseRule(r, map, peek));
  }
  if (meta.route && Array.isArray(meta.route.rules)) {
    for (const r of meta.route.rules) {
      if (r && r.outbound) r.outbound = peek(r.outbound);
    }
  }
}

/** Rewrite the final (outbound/group) target of a Clash rule string. */
function rebaseRule(rule, map, peek) {
  if (typeof rule !== 'string') return rule;
  const parts = rule.split(',');
  const lastIdx = parts.length - 1;
  const target = parts[lastIdx].trim();
  if (map.has(target)) parts[lastIdx] = peek(target);
  return parts.join(',');
}


/** Heuristic: does this text look like a subscription payload (vs random bytes)? */
function looksLikeSubscription(s) {
  const t = s.trim();
  return /:\/\//.test(t) || /proxies:/.test(t) || t.startsWith('{') || t.startsWith('[');
}

/**
 * Normalize a node produced by a structured-source parser (Clash/Sing-box):
 * strip IPv6 brackets from the server and normalize alpn to an array.
 * (URI parsers already run their own normalization/validation in uri-parse.js.)
 */
function normalizeNode(n) {
  if (!n || !n.type) return n;
  if (typeof n.server === 'string') {
    n.server = n.server.replace(/^\[|\]$/g, '').trim();
  }
  if (typeof n.alpn === 'string') {
    n.alpn = n.alpn.split(',').map(s => s.trim()).filter(Boolean);
  }
  return n;
}

/**
 * Ensure every node has a unique, non-empty name. Clash and Sing-box both
 * reject duplicate names/tags and empty tags, which would make the entire
 * generated config fail to load. Appends -2, -3, ... suffixes on collision.
 */
function dedupeNames(nodes) {
  const seen = new Set();
  for (const n of nodes) {
    let name = (n.name && String(n.name).trim()) || '';
    if (!name) name = `${n.type || 'node'}-${seen.size + 1}`;
    let base = name;
    let i = 2;
    while (seen.has(name)) name = `${base}-${i++}`;
    seen.add(name);
    n.name = name;
  }
}
export function detectFormat(content) {
  const trimmed = content.trim();

  // Check if it's JSON (Clash JSON or Sing-box)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const json = JSON.parse(trimmed);
      if (json.proxies && Array.isArray(json.proxies)) return 'clash';
      if (json.outbounds) return 'singbox';
    } catch { /* not JSON */ }
  }

  // Check if it's YAML (clash)
  if (trimmed.includes('proxies:') || (trimmed.includes('proxy-groups:') && trimmed.includes('rules:'))) {
    try {
      const doc = yaml.load(trimmed);
      if (doc && doc.proxies && Array.isArray(doc.proxies)) return 'clash';
    } catch { /* not valid YAML */ }
  }

  // Check if it's base64 encoded
  const decoded = tryBase64Decode(trimmed);
  if (decoded) {
    if (/:\/\//.test(decoded)) return 'base64';
  }

  // Check if it's plain text with proxy URIs
  if (/:\/\//.test(trimmed)) return 'plain';

  return 'unknown';
}

/** Parse base64-encoded subscription (decodes to URI list) */
export function parseBase64Sub(content) {
  const decoded = b64UrlDecode(content.trim());
  if (!decoded) return [];
  return parsePlainSub(decoded);
}

/** Parse plain text list of proxy URIs */
export function parsePlainSub(content) {
  const lines = content.trim().split(/[\r\n]+/);
  const nodes = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const node = parseURI(trimmed);
    if (node) nodes.push(node);
  }
  return nodes;
}

/** Parse Clash/Mihomo YAML subscription */
export function parseClashSub(content) {
  const doc = yaml.load(content);
  if (!doc || !doc.proxies || !Array.isArray(doc.proxies)) return { nodes: [], meta: {} };

  const nodes = [];
  for (const proxy of doc.proxies) {
    const node = clashProxyToNode(proxy);
    if (node) nodes.push(node);
  }

  // Preserve the rest of the config (proxy groups, routing rules, rule
  // providers, dns, clash-api) so a Clash->Clash conversion doesn't silently
  // drop them. These are rebased (node-name references rewritten) later in
  // parseSubscription once duplicate names are resolved.
  const meta = {
    format: 'clash',
    proxyGroups: Array.isArray(doc['proxy-groups']) ? clone(doc['proxy-groups']) : null,
    rules: Array.isArray(doc.rules) ? doc.rules.slice() : null,
    ruleProviders: (doc['rule-providers'] && typeof doc['rule-providers'] === 'object') ? clone(doc['rule-providers']) : null,
    dns: (doc.dns && typeof doc.dns === 'object') ? clone(doc.dns) : null,
    clashApi: (doc['clash-api'] && typeof doc['clash-api'] === 'object') ? clone(doc['clash-api']) : null,
  };

  return { nodes, meta };
}

/** Convert a Clash proxy entry to unified node format */
function clashProxyToNode(p) {
  if (!p || !p.type) return null;
  const base = {
    type: p.type,
    name: p.name || '',
    server: p.server,
    port: parseInt(p.port, 10),
    // Preserve an explicit udp:false; pass-through nodes keep their original.
    udp: p.udp,
  };

  // WebSocket / httpupgrade common fields (accept both Host and host casing)
  const wsOpts = p['ws-opts'] || p['http-opts'];
  const wsFields = {
    wsPath: wsOpts?.path,
    wsHost: wsOpts?.headers?.Host || wsOpts?.headers?.host,
    wsEarlyData: wsOpts?.['max-early-data'],
    wsEarlyDataHeader: wsOpts?.['early-data-header-name'],
  };

  switch (p.type) {
    case 'ss':
      return {
        ...base,
        cipher: p.cipher,
        password: p.password,
        ...(p.plugin ? { plugin: p.plugin } : {}),
        ...(p['plugin-opts'] ? { pluginOpts: p['plugin-opts'] } : {}),
      };

    case 'vmess':
      return {
        ...base,
        ...wsFields,
        uuid: p.uuid,
        alterId: p.aid || p.alterId || 0,
        cipher: p.cipher || 'auto',
        network: p.network || 'tcp',
        tls: p.tls ? 'tls' : 'none',
        sni: p.servername || p.sni,
        skipCertVerify: p['skip-cert-verify'] || false,
        grpcServiceName: p['grpc-opts']?.['grpc-service-name'],
        grpcMode: p['grpc-opts']?.['grpc-mode'],
        h2Host: p['h2-opts']?.host,
        h2Path: p['h2-opts']?.path,
        xhttpPath: p['xhttp-opts']?.path,
        xhttpHost: p['xhttp-opts']?.host,
        xhttpMode: p['xhttp-opts']?.mode,
        alpn: p.alpn,
        fingerprint: p['client-fingerprint'],
      };

    case 'vless':
      return {
        ...base,
        ...wsFields,
        uuid: p.uuid,
        flow: p.flow,
        network: p.network || 'tcp',
        tls: p['reality-opts'] ? 'reality' : (p.tls === true ? 'tls' : 'none'),
        sni: p.servername || p.sni,
        skipCertVerify: p['skip-cert-verify'] || false,
        realityPublicKey: p['reality-opts']?.['public-key'],
        realityShortId: p['reality-opts']?.['short-id'],
        grpcServiceName: p['grpc-opts']?.['grpc-service-name'],
        grpcMode: p['grpc-opts']?.['grpc-mode'],
        h2Host: p['h2-opts']?.host,
        h2Path: p['h2-opts']?.path,
        xhttpPath: p['xhttp-opts']?.path,
        xhttpHost: p['xhttp-opts']?.host,
        xhttpMode: p['xhttp-opts']?.mode,
        alpn: p.alpn,
        fingerprint: p['client-fingerprint'],
      };

    case 'trojan':
      return {
        ...base,
        ...wsFields,
        password: p.password,
        network: p.network || 'tcp',
        tls: 'tls',
        sni: p.sni || p.servername,
        skipCertVerify: p['skip-cert-verify'] || false,
        grpcServiceName: p['grpc-opts']?.['grpc-service-name'],
        grpcMode: p['grpc-opts']?.['grpc-mode'],
        xhttpPath: p['xhttp-opts']?.path,
        xhttpHost: p['xhttp-opts']?.host,
        xhttpMode: p['xhttp-opts']?.mode,
        alpn: p.alpn,
        fingerprint: p['client-fingerprint'],
      };

    case 'hysteria2':
    case 'hy2':
      return {
        ...base,
        type: 'hysteria2',
        auth: p.password || p.auth,
        password: p.password || p.auth,
        tls: 'tls',
        sni: p.sni,
        skipCertVerify: p['skip-cert-verify'] || false,
        up_mbps: p.up != null ? parseInt(String(p.up)) : undefined,
        down_mbps: p.down != null ? parseInt(String(p.down)) : undefined,
        obfs: p.obfs,
        obfsPassword: p['obfs-password'],
        alpn: p.alpn,
      };

    case 'tuic':
      return {
        ...base,
        uuid: p.uuid,
        password: p.password,
        tls: 'tls',
        sni: p.sni,
        skipCertVerify: p['skip-cert-verify'] || false,
        congestionControl: p['congestion-controller'] || p['congestion-control'],
        udpRelayMode: p['udp-relay-mode'],
        alpn: p.alpn,
      };

    case 'anytls':
      return {
        ...base,
        password: p.password,
        tls: 'tls',
        sni: p.sni || p.servername,
        skipCertVerify: p['skip-cert-verify'] || false,
        alpn: p.alpn,
        fingerprint: p['client-fingerprint'],
        idleSessionCheckInterval: p['idle-session-check-interval'],
        idleSessionTimeout: p['idle-session-timeout'],
        minIdleSession: p['min-idle-session'] != null ? parseInt(String(p['min-idle-session']), 10) : undefined,
      };

    default:
      // Unknown/unsupported proxy type (snell, wireguard, socks5, ssr, ...):
      // preserve the original object verbatim so it survives a Clash->Clash pass.
      return { ...base, _raw: p };
  }
}

/** Parse Sing-box JSON subscription */
export function parseSingboxSub(content) {
  let doc;
  try {
    doc = JSON.parse(content);
  } catch {
    return { nodes: [], meta: {} };
  }
  if (!doc.outbounds || !Array.isArray(doc.outbounds)) return { nodes: [], meta: {} };

  // Proxy types are modelled as unified nodes; everything else (selector,
  // url-test, load-balance, relay, direct, reject, dns, ...) is structural
  // config we preserve verbatim so a Sing-box->Sing-box conversion keeps the
  // user's proxy groups and routing rules.
  const PROXY_TYPES = new Set(['shadowsocks', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'anytls']);

  const nodes = [];
  for (const ob of doc.outbounds) {
    const node = singboxOutboundToNode(ob);
    if (node) nodes.push(node);
  }
  const groups = doc.outbounds.filter(o => o && o.type && !PROXY_TYPES.has(o.type));

  const meta = {
    format: 'singbox',
    groups: groups.length ? clone(groups) : null,
    route: doc.route ? {
      rules: Array.isArray(doc.route.rules) ? doc.route.rules.slice() : null,
      rule_set: doc.route.rule_set || null,
      final: doc.route.final || null,
      auto_detect_interface: doc.route.auto_detect_interface,
    } : null,
    dns: (doc.dns && typeof doc.dns === 'object') ? clone(doc.dns) : null,
    clashApi: doc.experimental?.clash_api ? clone(doc.experimental.clash_api) : null,
  };

  return { nodes, meta };
}

/** Convert a Sing-box outbound to unified node format */
function singboxOutboundToNode(ob) {
  if (!ob || !ob.type) return null;
  // Skip non-proxy outbounds
  const skipTypes = ['direct', 'block', 'reject', 'dns', 'selector', 'urltest', 'compat'];
  if (skipTypes.includes(ob.type)) return null;

  const base = {
    type: ob.type === 'shadowsocks' ? 'ss' : ob.type,
    name: ob.tag || '',
    server: ob.server,
    port: ob.server_port,
  };

  switch (ob.type) {
    case 'shadowsocks':
      return {
        ...base,
        type: 'ss',
        cipher: ob.method,
        password: ob.password,
      };

    case 'vmess':
      return {
        ...base,
        uuid: ob.uuid,
        alterId: ob.alter_id || 0,
        cipher: ob.security || 'auto',
        network: ob.transport?.type === 'http' ? 'h2' : (ob.transport?.type || 'tcp'),
        tls: ob.tls?.enabled ? 'tls' : 'none',
        sni: ob.tls?.server_name,
        skipCertVerify: ob.tls?.insecure || false,
        alpn: ob.tls?.alpn,
        wsPath: ob.transport?.path,
        wsHost: ob.transport?.headers?.Host,
        grpcServiceName: ob.transport?.service_name,
        grpcMode: ob.transport?.mode,
        h2Host: ob.transport?.host,
        h2Path: ob.transport?.path,
        xhttpPath: ob.transport?.type === 'xhttp' ? ob.transport?.path : undefined,
        xhttpHost: ob.transport?.type === 'xhttp' ? ob.transport?.host : undefined,
        xhttpMode: ob.transport?.type === 'xhttp' ? ob.transport?.mode : undefined,
        fingerprint: ob.tls?.utls?.fingerprint,
      };

    case 'vless':
      return {
        ...base,
        uuid: ob.uuid,
        flow: ob.flow,
        network: ob.transport?.type === 'http' ? 'h2' : (ob.transport?.type || 'tcp'),
        tls: ob.tls?.enabled ? (ob.tls?.reality ? 'reality' : 'tls') : 'none',
        sni: ob.tls?.server_name,
        skipCertVerify: ob.tls?.insecure || false,
        realityPublicKey: ob.tls?.reality?.public_key,
        realityShortId: ob.tls?.reality?.short_id,
        wsPath: ob.transport?.path,
        wsHost: ob.transport?.headers?.Host,
        grpcServiceName: ob.transport?.service_name,
        grpcMode: ob.transport?.mode,
        h2Host: ob.transport?.host,
        h2Path: ob.transport?.path,
        xhttpPath: ob.transport?.type === 'xhttp' ? ob.transport?.path : undefined,
        xhttpHost: ob.transport?.type === 'xhttp' ? ob.transport?.host : undefined,
        xhttpMode: ob.transport?.type === 'xhttp' ? ob.transport?.mode : undefined,
        alpn: ob.tls?.alpn,
        fingerprint: ob.tls?.utls?.fingerprint,
      };

    case 'trojan':
      return {
        ...base,
        password: ob.password,
        network: ob.transport?.type === 'http' ? 'h2' : (ob.transport?.type || 'tcp'),
        tls: 'tls',
        sni: ob.tls?.server_name,
        skipCertVerify: ob.tls?.insecure || false,
        wsPath: ob.transport?.path,
        wsHost: ob.transport?.headers?.Host,
        grpcServiceName: ob.transport?.service_name,
        grpcMode: ob.transport?.mode,
        xhttpPath: ob.transport?.type === 'xhttp' ? ob.transport?.path : undefined,
        xhttpHost: ob.transport?.type === 'xhttp' ? ob.transport?.host : undefined,
        xhttpMode: ob.transport?.type === 'xhttp' ? ob.transport?.mode : undefined,
        alpn: ob.tls?.alpn,
        fingerprint: ob.tls?.utls?.fingerprint,
      };

    case 'hysteria2':
      return {
        ...base,
        auth: ob.password,
        password: ob.password,
        tls: 'tls',
        sni: ob.tls?.server_name,
        skipCertVerify: ob.tls?.insecure || false,
        up_mbps: ob.up_mbps,
        down_mbps: ob.down_mbps,
        alpn: ob.tls?.alpn,
        ...(ob.obfs ? { obfs: ob.obfs.type, obfsPassword: ob.obfs.password } : {}),
      };

    case 'tuic':
      return {
        ...base,
        uuid: ob.uuid,
        password: ob.password,
        tls: 'tls',
        sni: ob.tls?.server_name,
        skipCertVerify: ob.tls?.insecure || false,
        congestionControl: ob.congestion_control,
        udpRelayMode: ob.udp_relay_mode,
        alpn: ob.tls?.alpn,
      };

    case 'anytls':
      return {
        ...base,
        password: ob.password,
        tls: 'tls',
        sni: ob.tls?.server_name,
        skipCertVerify: ob.tls?.insecure || false,
        alpn: ob.tls?.alpn,
        fingerprint: ob.tls?.utls?.fingerprint,
        idleSessionCheckInterval: ob.idle_session_check_interval,
        idleSessionTimeout: ob.idle_session_timeout,
        minIdleSession: ob.min_idle_session,
      };

    default:
      return { ...base, _raw: ob };
  }
}

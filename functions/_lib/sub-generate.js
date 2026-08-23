/**
 * Generate subscription content in various formats from unified node arrays.
 *
 * Supported output formats:
 * - base64: Base64-encoded list of proxy URIs (v2ray format)
 * - clash: Clash/Mihomo YAML config
 * - singbox: Sing-box JSON config
 * - plain: Plain text list of proxy URIs
 */

import yaml from './vendor/js-yaml.mjs';
import { generateURI } from './uri-generate.js';
import { b64Encode } from './utils.js';

/** Supported output format identifiers */
export const FORMATS = {
  CLASH: 'clash',
  SINGBOX: 'singbox',
  BASE64: 'base64',
  PLAIN: 'plain',
};

/** Format display names */
export const FORMAT_NAMES = {
  clash: 'Clash / Mihomo',
  singbox: 'Sing-Box',
  base64: 'V2Ray (Base64)',
  plain: 'Plain Text',
};

/**
 * Generate subscription content in the specified format.
 * @param {Array} nodes - Array of unified node objects
 * @param {string} format - Output format
 * @param {object} options - Additional options (name, etc.)
 * @returns {{content: string, contentType: string}}
 */
export function generateSubscription(nodes, format, options = {}) {
  const validNodes = (nodes || []).filter(n => n && n.type);

  switch (format) {
    case 'clash':
      return { content: genClash(validNodes, options), contentType: 'text/yaml; charset=utf-8' };
    case 'singbox':
      return { content: genSingbox(validNodes, options), contentType: 'application/json; charset=utf-8' };
    case 'base64':
      return { content: genBase64(validNodes), contentType: 'text/plain; charset=utf-8' };
    case 'plain':
      return { content: genPlain(validNodes), contentType: 'text/plain; charset=utf-8' };
    default:
      return { content: genBase64(validNodes), contentType: 'text/plain; charset=utf-8' };
  }
}

/** Generate base64-encoded subscription (v2ray format) */
function genBase64(nodes) {
  const uris = genPlain(nodes);
  return b64Encode(uris);
}

/** Generate plain text URI list */
function genPlain(nodes) {
  return nodes.map(n => generateURI(n)).filter(Boolean).join('\n');
}

/** Default proxy groups used only when the source has none of its own. */
function defaultClashGroups(proxyNames) {
  return [
    {
      name: '🚀 节点选择',
      type: 'select',
      proxies: ['♻️ 自动选择', ...proxyNames],
    },
    {
      name: '♻️ 自动选择',
      type: 'url-test',
      url: 'https://www.gstatic.com/generate_204',
      interval: 300,
      tolerance: 50,
      proxies: proxyNames,
    },
    {
      name: '🐟 漏网之鱼',
      type: 'select',
      proxies: ['🚀 节点选择', 'DIRECT', ...proxyNames],
    },
  ];
}

/** Default fallback rules used only when the source has none of its own. */
function defaultClashRules(catchAll) {
  return [
    'GEOIP,PRIVATE,DIRECT,no-resolve',
    'GEOIP,CN,DIRECT',
    `MATCH,${catchAll}`,
  ];
}

/** Translate Sing-box group outbounds into Clash proxy-groups. */
function singboxGroupsToClash(groups) {
  const typeMap = { selector: 'select', urltest: 'url-test', loadbalance: 'load-balance', relay: 'relay' };
  return groups
    .filter(g => typeMap[g.type])
    .map(g => {
      const pg = { name: g.tag, type: typeMap[g.type], proxies: g.outbounds || [] };
      if (g.type === 'urltest') {
        if (g.url) pg.url = g.url;
        if (g.interval != null) pg.interval = parseInterval(g.interval);
        if (g.tolerance != null) pg.tolerance = g.tolerance;
      } else if (g.type === 'loadbalance') {
        if (g.url) pg.url = g.url;
        if (g.interval != null) pg.interval = parseInterval(g.interval);
      }
      return pg;
    });
}

/** Sing-box durations ("5m", "300s") -> Clash seconds (number). */
function parseInterval(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return 300;
  const m = v.trim().match(/^(\d+)\s*(s|m|h)?$/);
  if (!m) return 300;
  const n = parseInt(m[1], 10);
  const u = m[2];
  if (u === 'm') return n * 60;
  if (u === 'h') return n * 3600;
  return n;
}

/**
 * Generate Clash/Mihomo YAML config.
 *
 * Routing rules and proxy groups are PRESERVED from the source subscription
 * when present (Clash->Clash uses them verbatim; Sing-box->Clash translates the
 * groups). Defaults are only injected when the source provided neither — this
 * stops us from throwing away a user's hand-tuned rules and replacing them
 * with hard-coded ones.
 */
function genClash(nodes, options = {}) {
  const meta = options.meta || {};
  const proxies = nodes.map(nodeToClashProxy).filter(Boolean);
  const proxyNames = proxies.map(p => p.name);

  // Proxy groups: prefer source; translate if cross-format; else default.
  let proxyGroups;
  if (meta.format === 'clash' && Array.isArray(meta.proxyGroups)) {
    proxyGroups = meta.proxyGroups;
  } else if (meta.format === 'singbox' && Array.isArray(meta.groups)) {
    proxyGroups = singboxGroupsToClash(meta.groups);
  } else {
    proxyGroups = defaultClashGroups(proxyNames);
  }

  // Routing rules: only Clash->Clash carries them (no rule-schema translation
  // across formats yet, so cross-format falls back to defaults below).
  const rules = (meta.format === 'clash' && Array.isArray(meta.rules)) ? meta.rules : null;
  const ruleProviders = meta.ruleProviders || null;

  const config = {
    'proxies': proxies,
    'proxy-groups': proxyGroups,
  };
  if (rules) config.rules = rules;
  if (ruleProviders) config['rule-providers'] = ruleProviders;

  if (!rules) {
    const catchAll = (proxyGroups[0] && proxyGroups[0].name) || 'DIRECT';
    config.rules = defaultClashRules(catchAll);
  }

  const header = {
    'port': 7890,
    'socks-port': 7891,
    'allow-lan': false,
    'mode': 'rule',
    'log-level': 'info',
    'external-controller': '127.0.0.1:9090',
    'dns': meta.dns || {
      'enable': true,
      'ipv6': false,
      'enhanced-mode': 'fake-ip',
      'nameserver': ['223.5.5.5', '119.29.29.29'],
      'fallback': ['8.8.8.8', '1.1.1.1'],
    },
  };
  if (meta.clashApi) header['clash-api'] = meta.clashApi;

  const fullConfig = { ...header, ...config };
  return yaml.dump(fullConfig, { lineWidth: -1, quotingType: '"' });
}

/** Convert a unified node to Clash proxy format */
function nodeToClashProxy(n) {
  if (!n || !n.type) return null;

  const base = {
    name: n.name,
    type: n.type,
    server: n.server,
    port: n.port,
    // Preserve an explicit udp:false; default to true otherwise.
    udp: n.udp === false ? false : true,
  };

  const addTLS = (obj) => {
    if (n.tls === 'tls') {
      obj.tls = true;
      if (n.sni) obj.servername = n.sni;
      if (n.skipCertVerify) obj['skip-cert-verify'] = true;
      if (n.alpn) obj.alpn = n.alpn;
      if (n.fingerprint) obj['client-fingerprint'] = n.fingerprint;
    } else if (n.tls === 'reality') {
      obj.tls = true;
      if (n.sni) obj.servername = n.sni;
      if (n.fingerprint) obj['client-fingerprint'] = n.fingerprint;
      obj['reality-opts'] = {};
      if (n.realityPublicKey) obj['reality-opts']['public-key'] = n.realityPublicKey;
      if (n.realityShortId) obj['reality-opts']['short-id'] = n.realityShortId;
    }
  };

  const addTransport = (obj) => {
    if (n.network && n.network !== 'tcp') {
      obj.network = n.network;
      if (n.network === 'ws' || n.network === 'httpupgrade') {
        const key = n.network === 'ws' ? 'ws-opts' : 'http-opts';
        obj[key] = {};
        if (n.wsPath) obj[key].path = n.wsPath;
        if (n.wsHost) obj[key].headers = { Host: n.wsHost };
        if (n.network === 'ws' && n.wsEarlyData) {
          obj[key]['max-early-data'] = n.wsEarlyData;
          if (n.wsEarlyDataHeader) obj[key]['early-data-header-name'] = n.wsEarlyDataHeader;
        }
      } else if (n.network === 'grpc') {
        obj['grpc-opts'] = {};
        if (n.grpcServiceName) obj['grpc-opts']['grpc-service-name'] = n.grpcServiceName;
        if (n.grpcMode) obj['grpc-opts']['grpc-mode'] = n.grpcMode;
      } else if (n.network === 'h2') {
        obj['h2-opts'] = {};
        if (n.h2Host) obj['h2-opts'].host = n.h2Host;
        if (n.h2Path) obj['h2-opts'].path = n.h2Path;
      } else if (n.network === 'xhttp') {
        obj['xhttp-opts'] = {};
        if (n.xhttpPath) obj['xhttp-opts'].path = n.xhttpPath;
        if (n.xhttpHost) obj['xhttp-opts'].host = n.xhttpHost;
        if (n.xhttpMode) obj['xhttp-opts'].mode = n.xhttpMode;
      }
    }
  };

  switch (n.type) {
    case 'ss':
      return {
        ...base,
        cipher: n.cipher,
        password: n.password,
        ...(n.plugin ? { plugin: n.plugin, 'plugin-opts': n.pluginOpts || {} } : {}),
      };

    case 'vmess':
      addTLS(base);
      addTransport(base);
      return {
        ...base,
        uuid: n.uuid,
        alterId: n.alterId || 0,
        cipher: n.cipher || 'auto',
      };

    case 'vless':
      addTLS(base);
      addTransport(base);
      const vless = {
        ...base,
        uuid: n.uuid,
      };
      if (n.flow) vless.flow = n.flow;
      return vless;

    case 'trojan':
      addTLS(base);
      addTransport(base);
      return {
        ...base,
        password: n.password,
        sni: n.sni,
      };

    case 'hysteria2':
      return {
        ...base,
        password: n.auth || n.password,
        sni: n.sni,
        'skip-cert-verify': n.skipCertVerify || false,
        ...(n.up_mbps ? { up: `${n.up_mbps} Mbps` } : {}),
        ...(n.down_mbps ? { down: `${n.down_mbps} Mbps` } : {}),
        ...(n.obfs ? { obfs: n.obfs } : {}),
        ...(n.obfsPassword ? { 'obfs-password': n.obfsPassword } : {}),
      };

    case 'tuic':
      return {
        ...base,
        uuid: n.uuid,
        password: n.password,
        sni: n.sni,
        'skip-cert-verify': n.skipCertVerify || false,
        'congestion-controller': n.congestionControl || 'bbr',
        'udp-relay-mode': n.udpRelayMode || 'native',
        ...(n.alpn ? { alpn: n.alpn } : {}),
      };

    case 'anytls':
      return {
        ...base,
        password: n.password,
        ...(n.sni ? { sni: n.sni } : {}),
        ...(n.alpn ? { alpn: n.alpn } : {}),
        ...(n.skipCertVerify ? { 'skip-cert-verify': true } : {}),
        ...(n.fingerprint ? { 'client-fingerprint': n.fingerprint } : {}),
        ...(n.idleSessionCheckInterval ? { 'idle-session-check-interval': n.idleSessionCheckInterval } : {}),
        ...(n.idleSessionTimeout ? { 'idle-session-timeout': n.idleSessionTimeout } : {}),
        ...(n.minIdleSession != null ? { 'min-idle-session': n.minIdleSession } : {}),
      };

    default:
      // Pass through proxy types the engine does not model (snell, wireguard,
      // socks5, ssr, ...) so a Clash->Clash conversion doesn't silently drop them.
      if (n._raw) return { ...n._raw, name: n.name };
      return null;
  }
}

/** Default group outbounds used only when the source has none of its own. */
function defaultSingboxGroups(tags) {
  return [
    {
      type: 'selector',
      tag: '🚀 节点选择',
      outbounds: ['♻️ 自动选择', ...tags],
      default: tags[0] || 'direct',
    },
    {
      type: 'urltest',
      tag: '♻️ 自动选择',
      outbounds: tags,
      url: 'https://www.gstatic.com/generate_204',
      interval: '5m',
    },
    { type: 'direct', tag: 'direct' },
    { type: 'reject', tag: 'block' },
    { type: 'dns', tag: 'dns-out' },
  ];
}

/** Default route used only when the source has none of its own.
 *  `finalTag` points the catch-all at a group that actually exists (the first
 *  group we emitted), so a translated/cross-format config never routes to a
 *  missing selector. */
function defaultSingboxRoute(finalTag) {
  const final = finalTag || '🚀 节点选择';
  return {
    rules: [
      { protocol: 'dns', outbound: 'dns-out' },
      { ip_is_private: true, outbound: 'direct' },
      { clash_mode: 'direct', outbound: 'direct' },
      { clash_mode: 'global', outbound: final },
    ],
    final,
    auto_detect_interface: true,
  };
}

/** Default dns block. */
function defaultDns() {
  return {
    servers: [
      { tag: 'google', address: 'tls://8.8.8.8' },
      { tag: 'local', address: '223.5.5.5', detour: 'direct' },
    ],
    rules: [
      { outbound: 'any', server: 'local' },
      { clash_mode: 'global', server: 'google' },
      { clash_mode: 'direct', server: 'local' },
    ],
  };
}

/** Translate Clash proxy-groups into Sing-box group outbounds. */
function clashGroupsToSingbox(groups) {
  const typeMap = { select: 'selector', 'url-test': 'urltest', 'load-balance': 'loadbalance', relay: 'selector' };
  return groups.map(g => {
    const type = typeMap[g.type] || g.type;
    const ob = { type, tag: g.name, outbounds: g.proxies || [] };
    if (g.type === 'url-test') {
      if (g.url) ob.url = g.url;
      if (g.interval != null) ob.interval = `${g.interval}s`;
      if (g.tolerance != null) ob.tolerance = `${g.tolerance}ms`;
    } else if (g.type === 'load-balance') {
      if (g.url) ob.url = g.url;
      if (g.interval != null) ob.interval = `${g.interval}s`;
    } else if (g.type === 'select' || g.type === 'relay') {
      ob.default = (g.proxies && g.proxies[0]) || 'direct';
    }
    return ob;
  });
}

/**
 * Generate Sing-box JSON config.
 *
 * Routing rules and proxy groups are PRESERVED from the source subscription
 * when present (Sing-box->Sing-box uses them verbatim; Clash->Sing-box
 * translates the groups). Defaults are only injected when the source provided
 * neither — this stops us from discarding a user's rules/groups and replacing
 * them with hard-coded ones.
 */
function genSingbox(nodes, options = {}) {
  const meta = options.meta || {};
  const outbounds = nodes.map(nodeToSingboxOutbound).filter(Boolean);
  const tags = outbounds.map(o => o.tag);

  // Group outbounds: prefer source; translate if cross-format; else default.
  let groups;
  if (meta.format === 'singbox' && Array.isArray(meta.groups)) {
    groups = meta.groups;
  } else if (meta.format === 'clash' && Array.isArray(meta.proxyGroups)) {
    groups = clashGroupsToSingbox(meta.proxyGroups);
  } else {
    groups = defaultSingboxGroups(tags);
  }

  // Ensure required structural outbounds still exist (source may omit them).
  const seen = new Set(groups.map(g => g.tag));
  const extra = [];
  if (!seen.has('direct')) extra.push({ type: 'direct', tag: 'direct' });
  if (!seen.has('block')) extra.push({ type: 'reject', tag: 'block' });
  if (!seen.has('dns-out')) extra.push({ type: 'dns', tag: 'dns-out' });

  // Route: only Sing-box->Sing-box carries the rules (no rule-schema
  // translation across formats yet, so cross-format falls back to defaults).
  let route;
  if (meta.format === 'singbox' && meta.route) {
    route = {
      rules: Array.isArray(meta.route.rules) ? meta.route.rules : [],
      final: meta.route.final || '🚀 节点选择',
    };
    if (meta.route.rule_set) route.rule_set = meta.route.rule_set;
    if (meta.route.auto_detect_interface != null) route.auto_detect_interface = meta.route.auto_detect_interface;
  } else {
    const primary = (groups[0] && groups[0].tag) || 'direct';
    route = defaultSingboxRoute(primary);
  }

  const config = {
    log: { level: 'info' },
    ...(meta.dns ? { dns: meta.dns } : { dns: defaultDns() }),
    inbounds: [
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: 7890,
      },
    ],
    outbounds: [...outbounds, ...groups, ...extra],
    route,
  };
  if (meta.clashApi) config.experimental = { clash_api: meta.clashApi };

  return JSON.stringify(config, null, 2);
}

/** Convert a unified node to Sing-box outbound format */
function nodeToSingboxOutbound(n) {
  if (!n || !n.type) return null;

  const base = {
    type: n.type === 'ss' ? 'shadowsocks' : n.type,
    tag: n.name,
    server: n.server,
    server_port: n.port,
  };

  const addTLS = (obj) => {
    if (n.tls === 'tls' || n.tls === 'reality') {
      obj.tls = { enabled: true };
      if (n.sni) obj.tls.server_name = n.sni;
      if (n.skipCertVerify) obj.tls.insecure = true;
      if (n.alpn) obj.tls.alpn = n.alpn;
      if (n.fingerprint) {
        obj.tls.utls = { enabled: true, fingerprint: n.fingerprint };
      }
      if (n.tls === 'reality') {
        obj.tls.reality = { enabled: true };
        if (n.realityPublicKey) obj.tls.reality.public_key = n.realityPublicKey;
        if (n.realityShortId) obj.tls.reality.short_id = n.realityShortId;
      }
    }
  };

  const addTransport = (obj) => {
    if (n.network && n.network !== 'tcp') {
      // Sing-box has no "xhttp" or "h2" transport type. The closest valid
      // constructs are the "http" transport (used for both xhttp and the
      // h2/http-upgrade family), so emit that without the unsupported types
      // or the v2ray-only "mode" field.
      const tType = (n.network === 'xhttp' || n.network === 'h2') ? 'http' : n.network;
      obj.transport = { type: tType };
      if (n.network === 'ws') {
        if (n.wsPath) obj.transport.path = n.wsPath;
        if (n.wsHost) obj.transport.headers = { Host: n.wsHost };
      } else if (n.network === 'grpc') {
        // Sing-box grpc transport does NOT accept a "mode" field — only service_name.
        if (n.grpcServiceName) obj.transport.service_name = n.grpcServiceName;
      } else if (n.network === 'h2') {
        if (n.h2Host) obj.transport.host = n.h2Host;
        if (n.h2Path) obj.transport.path = n.h2Path;
      } else if (n.network === 'xhttp') {
        if (n.xhttpPath) obj.transport.path = n.xhttpPath;
        if (n.xhttpHost) obj.transport.host = [n.xhttpHost];
      }
    }
  };

  switch (n.type) {
    case 'ss':
      return {
        type: 'shadowsocks',
        tag: n.name,
        server: n.server,
        server_port: n.port,
        method: n.cipher,
        password: n.password,
      };

    case 'vmess':
      addTLS(base);
      addTransport(base);
      return {
        ...base,
        uuid: n.uuid,
        alter_id: n.alterId || 0,
        security: n.cipher || 'auto',
      };

    case 'vless':
      addTLS(base);
      addTransport(base);
      const vless = {
        ...base,
        uuid: n.uuid,
      };
      if (n.flow) vless.flow = n.flow;
      return vless;

    case 'trojan':
      addTLS(base);
      addTransport(base);
      return {
        ...base,
        password: n.password,
      };

    case 'hysteria2':
      addTLS(base);
      const hy2 = {
        ...base,
        password: n.auth || n.password,
      };
      if (n.up_mbps) hy2.up_mbps = n.up_mbps;
      if (n.down_mbps) hy2.down_mbps = n.down_mbps;
      if (n.obfs) hy2.obfs = { type: n.obfs, password: n.obfsPassword || '' };
      return hy2;

    case 'tuic':
      addTLS(base);
      const tuic = {
        ...base,
        uuid: n.uuid,
        password: n.password,
      };
      if (n.congestionControl) tuic.congestion_control = n.congestionControl;
      if (n.udpRelayMode) tuic.udp_relay_mode = n.udpRelayMode;
      return tuic;

    case 'anytls':
      addTLS(base);
      const anytls = {
        ...base,
        password: n.password,
      };
      if (n.idleSessionCheckInterval) anytls.idle_session_check_interval = n.idleSessionCheckInterval;
      if (n.idleSessionTimeout) anytls.idle_session_timeout = n.idleSessionTimeout;
      if (n.minIdleSession != null) anytls.min_idle_session = n.minIdleSession;
      return anytls;

    default:
      return null;
  }
}

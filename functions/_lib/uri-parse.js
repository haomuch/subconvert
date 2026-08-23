/**
 * Parse individual proxy protocol URIs into unified node objects.
 *
 * Supported protocols: ss, vmess, vless, trojan, hysteria2 (hy2), tuic, anytls
 *
 * Unified node format:
 * {
 *   type, name, server, port,
 *   // SS
 *   cipher?, password?,
 *   // VMess/VLESS
 *   uuid?, alterId?, flow?,
 *   // Transport
 *   network?, // tcp | ws | grpc | h2 | httpupgrade | xhttp
 *   wsPath?, wsHost?,
 *   grpcServiceName?, grpcMode?,
 *   h2Host?, h2Path?,
 *   xhttpPath?, xhttpHost?, xhttpMode?,
 *   // TLS
 *   tls?, // tls | reality | none
 *   sni?, alpn?, fingerprint?, skipCertVerify?,
 *   // Reality
 *   realityPublicKey?, realityShortId?,
 *   // Hysteria2
 *   auth?, up?, down?,
 *   // TUIC
 *   congestionControl?, udpRelayMode?,
 * }
 */

import { b64UrlDecode, decodeName } from './utils.js';

/** Treat '1', 'true', and boolean true as enabled. */
function isTrue(v) {
  return v === '1' || v === 'true' || v === true;
}

/** Parse a single proxy URI, auto-detecting the protocol */
export function parseURI(uri) {
  uri = uri.trim();
  if (!uri) return null;

  try {
    if (uri.startsWith('ss://')) return parseSS(uri);
    if (uri.startsWith('vmess://')) return parseVMess(uri);
    if (uri.startsWith('vless://')) return parseVLESS(uri);
    if (uri.startsWith('trojan://')) return parseTrojan(uri);
    if (uri.startsWith('hysteria2://') || uri.startsWith('hy2://')) return parseHysteria2(uri);
    if (uri.startsWith('tuic://')) return parseTUIC(uri);
    if (uri.startsWith('anytls://')) return parseAnyTLS(uri);
    if (uri.startsWith('hysteria://')) return parseHysteria2(uri.replace('hysteria://', 'hysteria2://'));
  } catch (e) {
    console.error('Parse error for URI:', e);
    return null;
  }
  return null;
}

/**
 * Finalize a parsed node: normalise the server field, normalize alpn,
 * and reject structurally invalid nodes (missing server, out-of-range port,
 * or missing credentials). Returning null makes the caller drop the node.
 */
function validateNode(n) {
  if (!n || !n.type) return null;
  if (typeof n.server === 'string') {
    n.server = n.server.replace(/^\[|\]$/g, '').trim();
  }
  if (typeof n.alpn === 'string') {
    n.alpn = n.alpn.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (!n.server) return null;
  if (!Number.isInteger(n.port) || n.port < 1 || n.port > 65535) return null;
  if (n.type === 'vmess' || n.type === 'vless') {
    if (!n.uuid) return null;
  } else if (n.type === 'trojan' || n.type === 'anytls') {
    if (!n.password) return null;
  } else if (n.type === 'ss') {
    if (!n.cipher || !n.password) return null;
  } else if (n.type === 'hysteria2') {
    if (!n.auth && !n.password) return null;
  } else if (n.type === 'tuic') {
    if (!n.uuid || !n.password) return null;
  }
  return n;
}

/** Parse Shadowsocks URI (supports both SIP002 and legacy formats) */
function parseSS(uri) {
  // SIP002: ss://base64url(method:password)@host:port#name
  //         ss://base64url(method:password)@host:port/?plugin=...#name
  // Legacy: ss://base64(method:password@host:port)#name
  const body = uri.slice(5);
  const hashIdx = body.indexOf('#');
  const name = hashIdx >= 0 ? decodeName(body.slice(hashIdx + 1)) : '';
  const main = hashIdx >= 0 ? body.slice(0, hashIdx) : body;

  let method, password, server, port;
  let ssPlugin = null;

  if (main.includes('@')) {
    // SIP002 format
    const atIdx = main.lastIndexOf('@');
    const userInfo = main.slice(0, atIdx);
    const hostPort = main.slice(atIdx + 1);
    // Split off the query string (carries the plugin parameter)
    const qIdx = hostPort.indexOf('?');
    const hostPart = qIdx >= 0 ? hostPort.slice(0, qIdx) : hostPort;
    const queryStr = qIdx >= 0 ? hostPort.slice(qIdx + 1) : '';

    // Try base64url decode the user info (also handles standard base64 / no padding)
    let decoded = b64UrlDecode(userInfo);
    if (!decoded) decoded = userInfo; // might be plaintext

    const colonIdx = decoded.indexOf(':');
    method = decoded.slice(0, colonIdx);
    password = decoded.slice(colonIdx + 1);

    // Parse host:port (handle IPv6)
    const lastColon = hostPart.lastIndexOf(':');
    server = hostPart.slice(0, lastColon).replace(/^\[|\]$/g, '');
    port = parseInt(hostPart.slice(lastColon + 1), 10);

    // Parse Shadowsocks plugin (e.g. obfs-local;obfs=http;obfs-host=bing.com)
    if (queryStr) {
      const pluginParam = new URLSearchParams(queryStr).get('plugin');
      if (pluginParam) {
        const segs = pluginParam.split(';');
        const pluginName = segs.shift();
        const pluginOpts = {};
        for (const seg of segs) {
          const eq = seg.indexOf('=');
          if (eq >= 0) pluginOpts[seg.slice(0, eq)] = decodeURIComponent(seg.slice(eq + 1));
          else if (seg) pluginOpts[seg] = true;
        }
        if (pluginName) ssPlugin = { name: pluginName, opts: pluginOpts };
      }
    }
  } else {
    // Legacy format: base64(method:password@host:port)
    const decoded = b64UrlDecode(main);
    if (!decoded) return null;
    const atIdx = decoded.lastIndexOf('@');
    const methodPass = decoded.slice(0, atIdx);
    const hostPort = decoded.slice(atIdx + 1);
    const colonIdx = methodPass.indexOf(':');
    method = methodPass.slice(0, colonIdx);
    password = methodPass.slice(colonIdx + 1);
    const lastColon = hostPort.lastIndexOf(':');
    server = hostPort.slice(0, lastColon).replace(/^\[|\]$/g, '');
    port = parseInt(hostPort.slice(lastColon + 1), 10);
  }

  if (!server || !port || !method) return null;

  const node = {
    type: 'ss',
    name: name || `${server}:${port}`,
    server,
    port,
    cipher: method,
    password,
  };
  if (ssPlugin) {
    node.plugin = ssPlugin.name;
    node.pluginOpts = ssPlugin.opts;
  }
  return validateNode(node);
}

/** Parse VMess URI (vmess://base64(json)) */
function parseVMess(uri) {
  const decoded = b64UrlDecode(uri.slice(8));
  if (!decoded) return null;
  let config;
  try {
    config = JSON.parse(decoded);
  } catch {
    return null;
  }

  const node = {
    type: 'vmess',
    name: config.ps || config.remarks || '',
    server: config.add,
    port: parseInt(config.port, 10),
    uuid: config.id,
    alterId: parseInt(config.aid, 10) || 0,
    cipher: config.scy || 'auto',
    network: config.net || 'tcp',
    tls: (config.tls === 'tls' || config.tls === 'reality') ? config.tls : 'none',
  };

  if (config.sni) node.sni = config.sni;
  if (config.host) node.wsHost = config.host;
  if (config.path) node.wsPath = config.path;
  if (config.alpn) node.alpn = config.alpn.split(',').map(s => s.trim()).filter(Boolean);
  if (config.fp) node.fingerprint = config.fp;
  if (config.verify_cert === false || config.allowInsecure) node.skipCertVerify = true;

  // gRPC
  if (config.net === 'grpc' && config.path) {
    node.grpcServiceName = config.path;
    node.grpcMode = config.type || 'gun';
  }

  // h2
  if (config.net === 'h2') {
    if (config.host) node.h2Host = config.host.split(',');
    if (config.path) node.h2Path = config.path;
  }

  // xhttp
  if (config.net === 'xhttp') {
    if (config.path) node.xhttpPath = config.path;
    if (config.host) node.xhttpHost = config.host;
    // v2rayN stores the xhttp mode in the `type` field (same slot used by grpc mode)
    if (config.type) node.xhttpMode = config.type;
  }

  return validateNode(node);
}

/** Parse VLESS URI */
function parseVLESS(uri) {
  const url = new URL(uri);
  const params = url.searchParams;

  const node = {
    type: 'vless',
    name: decodeName(url.hash.slice(1)),
    server: url.hostname,
    port: parseInt(url.port, 10),
    uuid: url.username,
    network: params.get('type') || 'tcp',
    tls: 'none',
  };

  const security = params.get('security');
  if (security === 'tls') node.tls = 'tls';
  else if (security === 'reality') node.tls = 'reality';
  else node.tls = 'none';

  if (params.get('flow')) node.flow = params.get('flow');
  if (params.get('sni')) node.sni = params.get('sni');
  if (params.get('alpn')) node.alpn = params.get('alpn').split(',');
  if (params.get('fp')) node.fingerprint = params.get('fp');
  if (isTrue(params.get('allowInsecure')) || isTrue(params.get('insecure'))) node.skipCertVerify = true;

  // Reality options
  if (node.tls === 'reality') {
    if (params.get('pbk')) node.realityPublicKey = params.get('pbk');
    if (params.get('sid')) node.realityShortId = params.get('sid');
  }

  // Transport options
  if (node.network === 'ws') {
    if (params.get('path')) node.wsPath = params.get('path');
    if (params.get('host')) node.wsHost = params.get('host');
    if (params.get('max-early-data')) node.wsEarlyData = parseInt(params.get('max-early-data'), 10);
    if (params.get('early-data-header-name')) node.wsEarlyDataHeader = params.get('early-data-header-name');
  } else if (node.network === 'grpc') {
    if (params.get('serviceName')) node.grpcServiceName = params.get('serviceName');
    if (params.get('mode')) node.grpcMode = params.get('mode');
  } else if (node.network === 'h2' || node.network === 'http') {
    node.network = 'h2';
    if (params.get('host')) node.h2Host = params.get('host').split(',');
    if (params.get('path')) node.h2Path = params.get('path');
  } else if (node.network === 'httpupgrade') {
    if (params.get('path')) node.wsPath = params.get('path');
    if (params.get('host')) node.wsHost = params.get('host');
  } else if (node.network === 'xhttp') {
    if (params.get('path')) node.xhttpPath = params.get('path');
    if (params.get('host')) node.xhttpHost = params.get('host');
    if (params.get('mode')) node.xhttpMode = params.get('mode');
  }

  if (!node.name) node.name = `${node.server}:${node.port}`;
  return validateNode(node);
}

/** Parse Trojan URI */
function parseTrojan(uri) {
  const url = new URL(uri);
  const params = url.searchParams;

  const node = {
    type: 'trojan',
    name: decodeName(url.hash.slice(1)),
    server: url.hostname,
    port: parseInt(url.port, 10),
    password: decodeURIComponent(url.username),
    network: params.get('type') || 'tcp',
    tls: 'tls', // Trojan always uses TLS
  };

  if (params.get('sni')) node.sni = params.get('sni');
  if (params.get('alpn')) node.alpn = params.get('alpn').split(',');
  if (params.get('fp')) node.fingerprint = params.get('fp');
  if (isTrue(params.get('allowInsecure')) || isTrue(params.get('insecure'))) node.skipCertVerify = true;

  // Transport options
  if (node.network === 'ws') {
    if (params.get('path')) node.wsPath = params.get('path');
    if (params.get('host')) node.wsHost = params.get('host');
    if (params.get('max-early-data')) node.wsEarlyData = parseInt(params.get('max-early-data'), 10);
    if (params.get('early-data-header-name')) node.wsEarlyDataHeader = params.get('early-data-header-name');
  } else if (node.network === 'grpc') {
    if (params.get('serviceName')) node.grpcServiceName = params.get('serviceName');
    if (params.get('mode')) node.grpcMode = params.get('mode');
  } else if (node.network === 'httpupgrade') {
    if (params.get('path')) node.wsPath = params.get('path');
    if (params.get('host')) node.wsHost = params.get('host');
  } else if (node.network === 'xhttp') {
    if (params.get('path')) node.xhttpPath = params.get('path');
    if (params.get('host')) node.xhttpHost = params.get('host');
    if (params.get('mode')) node.xhttpMode = params.get('mode');
  }

  if (!node.name) node.name = `${node.server}:${node.port}`;
  return validateNode(node);
}

/** Parse Hysteria2 URI */
function parseHysteria2(uri) {
  const url = new URL(uri);
  const params = url.searchParams;

  // Hysteria2 auth may be "user:pass" — the URL parser splits it into
  // username/password, so reconstruct the full auth string before decoding.
  let auth = url.username;
  if (url.password) auth += ':' + url.password;
  auth = decodeURIComponent(auth);

  const node = {
    type: 'hysteria2',
    name: decodeName(url.hash.slice(1)),
    server: url.hostname,
    port: parseInt(url.port, 10),
    auth: auth || '',
    password: auth || '', // alias
    tls: 'tls',
  };

  if (params.get('sni')) node.sni = params.get('sni');
  if (params.get('alpn')) node.alpn = params.get('alpn').split(',');
  if (isTrue(params.get('insecure')) || isTrue(params.get('allowInsecure'))) node.skipCertVerify = true;
  if (params.get('up')) node.up_mbps = parseInt(params.get('up'), 10);
  if (params.get('down')) node.down_mbps = parseInt(params.get('down'), 10);
  if (params.get('obfs')) node.obfs = params.get('obfs');
  if (params.get('obfs-password')) node.obfsPassword = params.get('obfs-password');

  if (!node.name) node.name = `${node.server}:${node.port}`;
  return validateNode(node);
}

/** Parse TUIC URI */
function parseTUIC(uri) {
  const url = new URL(uri);
  const params = url.searchParams;

  const node = {
    type: 'tuic',
    name: decodeName(url.hash.slice(1)),
    server: url.hostname,
    port: parseInt(url.port, 10),
    uuid: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    tls: 'tls',
  };

  if (params.get('sni')) node.sni = params.get('sni');
  if (params.get('alpn')) node.alpn = params.get('alpn').split(',');
  if (params.get('congestion_control')) node.congestionControl = params.get('congestion_control');
  if (params.get('udp_relay_mode')) node.udpRelayMode = params.get('udp_relay_mode');
  if (params.get('allowInsecure') === '1') node.skipCertVerify = true;

  if (!node.name) node.name = `${node.server}:${node.port}`;
  return validateNode(node);
}

/** Parse AnyTLS URI */
function parseAnyTLS(uri) {
  const url = new URL(uri);
  const params = url.searchParams;

  let password = url.username;
  if (url.password) password += ':' + url.password;
  password = decodeURIComponent(password || '');
  if (!password && params.get('password')) {
    password = params.get('password');
  }

  const node = {
    type: 'anytls',
    name: decodeName(url.hash.slice(1)),
    server: url.hostname,
    port: parseInt(url.port, 10) || 443,
    password: password || '',
    tls: 'tls',
  };

  const sni = params.get('sni') || params.get('peer');
  if (sni) node.sni = sni;
  if (params.get('alpn')) node.alpn = params.get('alpn').split(',');
  const fp = params.get('fp') || params.get('fingerprint') || params.get('client-fingerprint');
  if (fp) node.fingerprint = fp;
  if (isTrue(params.get('insecure')) || isTrue(params.get('allowInsecure'))) node.skipCertVerify = true;

  const checkInterval = params.get('idle_session_check_interval') || params.get('idle-session-check-interval');
  if (checkInterval) node.idleSessionCheckInterval = checkInterval;

  const timeout = params.get('idle_session_timeout') || params.get('idle-session-timeout');
  if (timeout) node.idleSessionTimeout = timeout;

  const minIdle = params.get('min_idle_session') || params.get('min-idle-session');
  if (minIdle != null && minIdle !== '') {
    const parsed = parseInt(minIdle, 10);
    if (!isNaN(parsed)) node.minIdleSession = parsed;
  }

  if (!node.name) node.name = `${node.server}:${node.port}`;
  return validateNode(node);
}


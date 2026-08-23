/**
 * Generate proxy protocol URIs from unified node objects.
 * Supports: ss, vmess, vless, trojan, hysteria2, tuic, anytls
 */

import { b64Encode, b64UrlEncode, encodeName } from './utils.js';

/** Wrap an IPv6 literal in brackets for use in a URI authority; leave hostnames alone. */
function hostOf(server) {
  return server && server.includes(':') ? `[${server}]` : server;
}

/** Generate a single proxy URI from a node object */
export function generateURI(node) {
  if (!node || !node.type) return '';
  try {
    switch (node.type) {
      case 'ss': return genSS(node);
      case 'vmess': return genVMess(node);
      case 'vless': return genVLESS(node);
      case 'trojan': return genTrojan(node);
      case 'hysteria2': return genHysteria2(node);
      case 'tuic': return genTUIC(node);
      case 'anytls': return genAnyTLS(node);
    }
  } catch (e) {
    console.error('Generate error:', e);
    return '';
  }
  return '';
}

/** Generate Shadowsocks URI (SIP002 format) */
function genSS(node) {
  const userInfo = b64UrlEncode(`${node.cipher}:${node.password}`);
  const host = node.server.includes(':') ? `[${node.server}]` : node.server;
  const name = node.name ? `#${encodeName(node.name)}` : '';
  return `ss://${userInfo}@${host}:${node.port}${name}`;
}

/** Generate VMess URI */
function genVMess(node) {
  const config = {
    v: '2',
    ps: node.name || '',
    add: node.server,
    port: String(node.port),
    id: node.uuid,
    aid: String(node.alterId || 0),
    scy: node.cipher || 'auto',
    net: node.network || 'tcp',
    type: node.network === 'xhttp' ? (node.xhttpMode || 'auto') : (node.grpcMode || 'none'),
    host: node.network === 'xhttp' ? (node.xhttpHost || '') : (node.wsHost || ''),
    path: node.network === 'xhttp' ? (node.xhttpPath || '') : (node.wsPath || node.grpcServiceName || node.h2Path || ''),
    tls: node.tls === 'tls' || node.tls === 'reality' ? node.tls : '',
    sni: node.sni || '',
    alpn: node.alpn || '',
    fp: node.fingerprint || '',
    verify_cert: node.skipCertVerify ? false : true,
  };

  // h2 host
  if (node.network === 'h2' && node.h2Host) {
    config.host = node.h2Host.join(',');
  }

  return `vmess://${b64Encode(JSON.stringify(config))}`;
}

/** Generate VLESS URI */
function genVLESS(node) {
  const params = new URLSearchParams();
  params.set('type', node.network || 'tcp');
  params.set('encryption', 'none');

  if (node.tls === 'tls') {
    params.set('security', 'tls');
    if (node.sni) params.set('sni', node.sni);
    if (node.fingerprint) params.set('fp', node.fingerprint);
    if (node.skipCertVerify) params.set('allowInsecure', '1');
  } else if (node.tls === 'reality') {
    params.set('security', 'reality');
    if (node.sni) params.set('sni', node.sni);
    if (node.fingerprint) params.set('fp', node.fingerprint);
    if (node.realityPublicKey) params.set('pbk', node.realityPublicKey);
    if (node.realityShortId) params.set('sid', node.realityShortId);
  }

  if (node.flow) params.set('flow', node.flow);
  if (node.alpn) params.set('alpn', Array.isArray(node.alpn) ? node.alpn.join(',') : node.alpn);

  // Transport
  if (node.network === 'ws' || node.network === 'httpupgrade') {
    if (node.wsPath) params.set('path', node.wsPath);
    if (node.wsHost) params.set('host', node.wsHost);
    if (node.wsEarlyData) {
      params.set('max-early-data', String(node.wsEarlyData));
      if (node.wsEarlyDataHeader) params.set('early-data-header-name', node.wsEarlyDataHeader);
    }
  } else if (node.network === 'grpc') {
    if (node.grpcServiceName) params.set('serviceName', node.grpcServiceName);
    if (node.grpcMode) params.set('mode', node.grpcMode);
  } else if (node.network === 'h2') {
    if (node.h2Host) params.set('host', node.h2Host.join(','));
    if (node.h2Path) params.set('path', node.h2Path);
  } else if (node.network === 'xhttp') {
    if (node.xhttpPath) params.set('path', node.xhttpPath);
    if (node.xhttpHost) params.set('host', node.xhttpHost);
    if (node.xhttpMode) params.set('mode', node.xhttpMode);
  }

  const name = node.name ? `#${encodeName(node.name)}` : '';
  const uuid = encodeURIComponent(node.uuid);
  return `vless://${uuid}@${hostOf(node.server)}:${node.port}?${params.toString()}${name}`;
}

/** Generate Trojan URI */
function genTrojan(node) {
  const params = new URLSearchParams();
  params.set('type', node.network || 'tcp');

  if (node.sni) params.set('sni', node.sni);
  if (node.alpn) params.set('alpn', Array.isArray(node.alpn) ? node.alpn.join(',') : node.alpn);
  if (node.fingerprint) params.set('fp', node.fingerprint);
  if (node.skipCertVerify) params.set('allowInsecure', '1');

  // Transport
  if (node.network === 'ws' || node.network === 'httpupgrade') {
    if (node.wsPath) params.set('path', node.wsPath);
    if (node.wsHost) params.set('host', node.wsHost);
    if (node.wsEarlyData) {
      params.set('max-early-data', String(node.wsEarlyData));
      if (node.wsEarlyDataHeader) params.set('early-data-header-name', node.wsEarlyDataHeader);
    }
  } else if (node.network === 'grpc') {
    if (node.grpcServiceName) params.set('serviceName', node.grpcServiceName);
    if (node.grpcMode) params.set('mode', node.grpcMode);
  } else if (node.network === 'xhttp') {
    if (node.xhttpPath) params.set('path', node.xhttpPath);
    if (node.xhttpHost) params.set('host', node.xhttpHost);
    if (node.xhttpMode) params.set('mode', node.xhttpMode);
  }

  const name = node.name ? `#${encodeName(node.name)}` : '';
  const password = encodeURIComponent(node.password);
  return `trojan://${password}@${hostOf(node.server)}:${node.port}?${params.toString()}${name}`;
}

/** Generate Hysteria2 URI */
function genHysteria2(node) {
  const params = new URLSearchParams();

  if (node.sni) params.set('sni', node.sni);
  if (node.alpn) params.set('alpn', Array.isArray(node.alpn) ? node.alpn.join(',') : node.alpn);
  if (node.skipCertVerify) params.set('insecure', '1');
  if (node.up_mbps) params.set('up', String(node.up_mbps));
  if (node.down_mbps) params.set('down', String(node.down_mbps));
  if (node.obfs) params.set('obfs', node.obfs);
  if (node.obfsPassword) params.set('obfs-password', node.obfsPassword);

  const name = node.name ? `#${encodeName(node.name)}` : '';
  const auth = encodeURIComponent(node.auth || node.password || '');
  return `hysteria2://${auth}@${hostOf(node.server)}:${node.port}?${params.toString()}${name}`;
}

/** Generate TUIC URI */
function genTUIC(node) {
  const params = new URLSearchParams();

  if (node.sni) params.set('sni', node.sni);
  if (node.alpn) params.set('alpn', Array.isArray(node.alpn) ? node.alpn.join(',') : node.alpn);
  if (node.congestionControl) params.set('congestion_control', node.congestionControl);
  if (node.udpRelayMode) params.set('udp_relay_mode', node.udpRelayMode);
  if (node.skipCertVerify) params.set('allowInsecure', '1');

  const name = node.name ? `#${encodeName(node.name)}` : '';
  const uuid = encodeURIComponent(node.uuid);
  const password = encodeURIComponent(node.password);
  return `tuic://${uuid}:${password}@${hostOf(node.server)}:${node.port}?${params.toString()}${name}`;
}

/** Generate AnyTLS URI */
function genAnyTLS(node) {
  const params = new URLSearchParams();

  if (node.sni) params.set('sni', node.sni);
  if (node.alpn) params.set('alpn', Array.isArray(node.alpn) ? node.alpn.join(',') : node.alpn);
  if (node.fingerprint) params.set('fp', node.fingerprint);
  if (node.skipCertVerify) params.set('insecure', '1');
  if (node.idleSessionCheckInterval) params.set('idle_session_check_interval', node.idleSessionCheckInterval);
  if (node.idleSessionTimeout) params.set('idle_session_timeout', node.idleSessionTimeout);
  if (node.minIdleSession != null) params.set('min_idle_session', String(node.minIdleSession));

  const name = node.name ? `#${encodeName(node.name)}` : '';
  const password = encodeURIComponent(node.password || '');
  const queryString = params.toString() ? `?${params.toString()}` : '';
  return `anytls://${password}@${hostOf(node.server)}:${node.port}${queryString}${name}`;
}


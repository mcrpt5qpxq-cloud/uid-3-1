import WebSocket from 'ws';
import tls from 'tls';
import net from 'net';
import axios from 'axios';
import fs from 'fs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import dotenv from 'dotenv';

dotenv.config();

let USER_TOKEN = (process.env.USER_TOKEN || '').trim();
const TARGET_GUILD_ID = (process.env.TARGET_GUILD_ID || '').trim();
const TARGET_VANITY = (process.env.TARGET_VANITY || '').trim();
const USER_PASSWORD = (process.env.USER_PASSWORD || '').trim();
const WEBHOOK = (process.env.WEBHOOK || '').trim();
const TOKEN_ROTATE_MINUTES = parseInt(process.env.TOKEN_ROTATE_MINUTES || '5');

// Release time configuration (UTC timezone)
const RELEASE_DATE = process.env.RELEASE_DATE || '2024-01-01T00:00:00Z'; // Format: YYYY-MM-DDTHH:MM:SSZ
const HYPER_MODE_SECONDS_BEFORE = parseInt(process.env.HYPER_MODE_SECONDS_BEFORE || '30'); // Start hyper polling X seconds before release

const PROXY_ENABLED = process.env.PROXY_ENABLED === 'true';
const PROXY_URL = (process.env.PROXY_URL || '').trim();
const WEBSHARE_API_KEY = (process.env.WEBSHARE_API_KEY || '').trim();

let mfaAuthToken = null;
let userTokens = [];
let currentTokenIndex = 0;
let latestSequence = null;
let heartbeatTimer = null;
let tokenRotateTimer = null;
const vanityMap = new Map();

// Current proxy info for webhook display
let currentProxyInfo = {
  address: null,
  port: null,
  country: null
};

// Cached proxy URL to avoid re-fetching on every request
let cachedProxyUrl = null;
let proxyUrlFetched = false;

// Throughput tracking
const metrics = {
  requestTimestamps: [],
  totalRequests: 0,
  sessionStartTime: Date.now(),
  peakRps: 0,
  lastRpsUpdate: 0
};

function recordRequest() {
  const now = Date.now();
  metrics.requestTimestamps.push(now);
  metrics.totalRequests++;
  
  // Keep only timestamps from the last 5 seconds for rolling window
  const cutoff = now - 5000;
  metrics.requestTimestamps = metrics.requestTimestamps.filter(ts => ts > cutoff);
}

function getCurrentRps() {
  const now = Date.now();
  const oneSecondAgo = now - 1000;
  const requestsLastSecond = metrics.requestTimestamps.filter(ts => ts > oneSecondAgo).length;
  
  // Update peak RPS
  if (requestsLastSecond > metrics.peakRps) {
    metrics.peakRps = requestsLastSecond;
  }
  
  return requestsLastSecond;
}

function getAverageRps() {
  const now = Date.now();
  const fiveSecondsAgo = now - 5000;
  const requestsLastFiveSeconds = metrics.requestTimestamps.filter(ts => ts > fiveSecondsAgo).length;
  return (requestsLastFiveSeconds / 5).toFixed(1);
}

function getThroughputStats() {
  const currentRps = getCurrentRps();
  const avgRps = getAverageRps();
  const sessionDuration = Math.floor((Date.now() - metrics.sessionStartTime) / 1000);
  
  return {
    current: currentRps,
    average: avgRps,
    peak: metrics.peakRps,
    total: metrics.totalRequests,
    sessionSeconds: sessionDuration
  };
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const X_SUPER_PROPERTIES = 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2xvY2FsZSI6ImVuLVVTIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEzMS4wLjAuMCBTYWZhcmkvNTM3LjM2IiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTMxLjAuMC4wIiwib3NfdmVyc2lvbiI6IjEwIiwicmVmZXJyZXIiOiJodHRwczovL3d3dy5nb29nbGUuY29tLyIsInJlZmVycmluZ19kb21haW4iOiJ3d3cuZ29vZ2xlLmNvbSIsInJlZmVycmVyX2N1cnJlbnQiOiIiLCJyZWZlcnJpbmdfZG9tYWluX2N1cnJlbnQiOiIiLCJyZWxlYXNlX2NoYW5uZWwiOiJzdGFibGUiLCJjbGllbnRfYnVpbGRfbnVtYmVyIjozNTgyOTUsImNsaWVudF9ldmVudF9zb3VyY2UiOm51bGwsImRlc2lnbl9pZCI6MH0=';

async function fetchWebshareProxies() {
  if (!WEBSHARE_API_KEY) {
    console.log('No Webshare API key configured');
    return null;
  }

  const cleanApiKey = WEBSHARE_API_KEY.replace(/\s+/g, '').replace(/[\r\n]/g, '');

  try {
    // First try backbone mode (required for residential proxies)
    let response;
    let isBackbone = false;
    
    try {
      response = await axios.get('https://proxy.webshare.io/api/v2/proxy/list/', {
        params: {
          mode: 'backbone',
          page: 1,
          page_size: 25,
          country_code__in: 'US', // Filter for US proxies
          state_code__in: 'NY,NJ,VA,NC,GA,FL,PA,MD,MA,CT' // Prioritize eastern US states
        },
        headers: {
          'Authorization': `Token ${cleanApiKey}`
        }
      });
      isBackbone = true;
    } catch (backboneErr) {
      // If backbone fails, try direct mode (for datacenter proxies)
      console.log('Backbone mode failed, trying direct mode...');
      response = await axios.get('https://proxy.webshare.io/api/v2/proxy/list/', {
        params: {
          mode: 'direct',
          page: 1,
          page_size: 25,
          country_code__in: 'US', // Filter for US proxies
          state_code__in: 'NY,NJ,VA,NC,GA,FL,PA,MD,MA,CT' // Prioritize eastern US states
        },
        headers: {
          'Authorization': `Token ${cleanApiKey}`
        }
      });
    }

    console.log('Webshare API response count:', response.data.count || 0);
    console.log('Proxy mode:', isBackbone ? 'Backbone (Residential)' : 'Direct (Datacenter)');
    
    if (response.data.results && response.data.results.length > 0) {
      // Pick a random proxy from the list for better rotation
      const randomIndex = Math.floor(Math.random() * response.data.results.length);
      const proxy = response.data.results[randomIndex];
      
      console.log(`Selected proxy ${randomIndex + 1}/${response.data.results.length}`);
      
      // For backbone mode, use p.webshare.io as the proxy address
      // For direct mode, use the proxy_address field
      let proxyAddress, proxyPort;
      
      if (isBackbone) {
        // Residential proxies use backbone domain
        proxyAddress = proxy.proxy_address || 'p.webshare.io';
        proxyPort = proxy.port || proxy.ports?.http || 80;
      } else {
        // Datacenter proxies use direct IP
        proxyAddress = proxy.proxy_address || proxy.ip || proxy.host;
        proxyPort = proxy.port || 8080;
      }
      
      const proxyUsername = proxy.username || proxy.user;
      const proxyPassword = proxy.password || proxy.pass;
      const countryCode = proxy.country_code || proxy.country || 'Unknown';
      
      if (!proxyAddress) {
        console.error('ERROR: Could not find proxy address in response. Raw data:', JSON.stringify(proxy).substring(0, 200));
        return null;
      }
      
      const proxyUrl = `http://${proxyUsername}:${proxyPassword}@${proxyAddress}:${proxyPort}`;
      console.log(`Loaded proxy: ${proxyAddress}:${proxyPort} (${countryCode})`);
      
      // Store proxy info for use in other webhooks
      currentProxyInfo = {
        address: proxyAddress,
        port: proxyPort,
        country: countryCode
      };
      
      sendStatusWebhook(
        '🌐 Proxy Connection Established',
        '**Successfully connected through Webshare proxy**\nAll requests will be routed through this proxy server.',
        0x9b59b6,
        [
          {
            name: '📡 Proxy Address',
            value: `\`\`\`${proxyAddress}:${proxyPort}\`\`\``,
            inline: true
          },
          {
            name: '🌍 Location',
            value: `\`${countryCode}\``,
            inline: true
          },
          {
            name: '🔒 Protocol',
            value: '`HTTP/HTTPS`',
            inline: true
          },
          {
            name: '✅ Status',
            value: '`Online & Ready`',
            inline: false
          }
        ]
      );
      
      return proxyUrl;
    } else {
      console.log('No proxies found in Webshare account');
    }
  } catch (err) {
    const errorDetail = err.response?.data?.detail || err.response?.data || err.message;
    console.error('Failed to fetch Webshare proxies:', JSON.stringify(errorDetail));
  }
  return null;
}

async function getProxyUrl() {
  if (!PROXY_ENABLED) {
    currentProxyInfo = { address: null, port: null, country: null };
    return null;
  }
  
  if (PROXY_URL) {
    // Parse manual proxy URL and store info
    try {
      const parsed = new URL(PROXY_URL);
      currentProxyInfo = {
        address: parsed.hostname,
        port: parseInt(parsed.port) || 80,
        country: 'Manual Proxy'
      };
      console.log(`Using manual proxy: ${currentProxyInfo.address}:${currentProxyInfo.port}`);
    } catch (e) {
      currentProxyInfo = { address: PROXY_URL, port: null, country: 'Manual Proxy' };
    }
    return PROXY_URL;
  }
  
  // Use Webshare proxy
  return await fetchWebshareProxies();
}

function parseProxyUrl(proxyUrl) {
  const url = new URL(proxyUrl);
  return {
    host: url.hostname,
    port: parseInt(url.port) || 80,
    auth: url.username && url.password ? `${url.username}:${url.password}` : null
  };
}

function createTlsSocketThroughProxy(proxyUrl) {
  return new Promise((resolve, reject) => {
    const proxy = parseProxyUrl(proxyUrl);
    const targetHost = 'canary.discord.com';
    const targetPort = 443;
    const socket = net.connect(proxy.port, proxy.host, () => {
      let connectRequest = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n`;
      connectRequest += `Host: ${targetHost}:${targetPort}\r\n`;

      if (proxy.auth) {
        const authBase64 = Buffer.from(proxy.auth).toString('base64');
        connectRequest += `Proxy-Authorization: Basic ${authBase64}\r\n`;
      }

      connectRequest += '\r\n';
      socket.write(connectRequest);
    });

    socket.once('data', (data) => {
      const response = data.toString();
      if (response.includes('200')) {
        const tlsSock = tls.connect({
          socket: socket,
          host: targetHost,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
          maxVersion: 'TLSv1.3'
        }, () => {
          resolve(tlsSock);
        });

        tlsSock.on('error', reject);
      } else {
        reject(new Error(`Proxy CONNECT failed: ${response.split('\r\n')[0]}`));
      }
    });

    socket.on('error', reject);
  });
}

function createDirectTlsSocket() {
  return tls.connect({
    host: 'canary.discord.com',
    port: 443,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3'
  });
}

const loadUserTokens = () => {
  try {
    const data = fs.readFileSync("mfa.txt", "utf8");
    if (data.trim()) {
      userTokens = data.trim().split('\n').map(t => t.trim()).filter(t => t.length > 0);
      if (userTokens.length > 0) {
        currentTokenIndex = 0;
        USER_TOKEN = userTokens[0];
        console.log(`Loaded ${userTokens.length} user token(s) from mfa.txt`);
      }
    }
  } catch (err) {
    if (USER_TOKEN) {
      userTokens = [USER_TOKEN];
      console.log('Using USER_TOKEN from environment');
    }
  }
};

const rotateToNextToken = () => {
  if (userTokens.length <= 1) return;
  currentTokenIndex = (currentTokenIndex + 1) % userTokens.length;
  USER_TOKEN = userTokens[currentTokenIndex];
  mfaAuthToken = null; // Reset MFA token for new user token
  const tokenPreview = USER_TOKEN.length > 4 ? `...${USER_TOKEN.slice(-4)}` : '****';
  console.log(`Rotated to token ${currentTokenIndex + 1}/${userTokens.length}`);
  
  const proxyDisplay = currentProxyInfo.address 
    ? `${currentProxyInfo.country} (${currentProxyInfo.address}:${currentProxyInfo.port})`
    : 'Direct Connection (No Proxy)';
  
  sendStatusWebhook(
    '🔄 Token Rotation Complete',
    '**Successfully switched to next available token**\nMFA authentication will be refreshed automatically.',
    0x3498db,
    [
      {
        name: '📍 Current Token',
        value: `\`Token ${currentTokenIndex + 1}/${userTokens.length}\` • \`${tokenPreview}\``,
        inline: true
      },
      {
        name: '🔢 Total Tokens',
        value: `\`${userTokens.length}\``,
        inline: true
      },
      {
        name: '🌍 Proxy Location',
        value: `\`${proxyDisplay}\``,
        inline: false
      },
      {
        name: '⏰ Rotated At',
        value: `<t:${Math.floor(Date.now() / 1000)}:T>`,
        inline: false
      },
      {
        name: '⏭️ Next Rotation',
        value: `In \`${TOKEN_ROTATE_MINUTES}\` minutes`,
        inline: false
      }
    ]
  );
};

const startTokenRotation = () => {
  if (userTokens.length <= 1) {
    console.log('Only 1 token, rotation disabled');
    return;
  }
  const rotateMs = TOKEN_ROTATE_MINUTES * 60 * 1000;
  console.log(`Token rotation enabled: every ${TOKEN_ROTATE_MINUTES} minute(s) (drift-corrected)`);
  
  // Use self-correcting timer to prevent drift
  let expectedNextRotation = Date.now() + rotateMs;
  
  const scheduleNextRotation = () => {
    const now = Date.now();
    const drift = now - expectedNextRotation;
    
    // Log drift if significant (more than 100ms)
    if (Math.abs(drift) > 100) {
      console.log(`Timer drift detected: ${drift}ms, compensating...`);
    }
    
    // Perform the rotation
    rotateToNextToken();
    authenticateMfa().then(token => {
      if (token) mfaAuthToken = token;
    });
    
    // Schedule next rotation, compensating for drift
    expectedNextRotation += rotateMs;
    const nextDelay = Math.max(0, expectedNextRotation - Date.now());
    tokenRotateTimer = setTimeout(scheduleNextRotation, nextDelay);
  };
  
  // Schedule first rotation
  tokenRotateTimer = setTimeout(scheduleNextRotation, rotateMs);
};

loadUserTokens();

fs.watch("mfa.txt", (eventType) => {
  if (eventType === "change") {
    loadUserTokens();
  }
});

function sendWebhook(vanityUrl) {
  axios.post(WEBHOOK, {
    embeds: [{
      title: '🎉 Vanity URL Claimed Successfully!',
      description: `**The vanity URL has been successfully claimed!**\n\n` +
                   `> 🔗 **discord.gg/${vanityUrl}**\n\n` +
                   `The target vanity is now active on your server.`,
      color: 0x2ecc71,
      fields: [
        {
          name: '📌 Vanity Code',
          value: `\`\`\`${vanityUrl}\`\`\``,
          inline: true
        },
        {
          name: '🎯 Target Guild',
          value: `\`${TARGET_GUILD_ID}\``,
          inline: true
        },
        {
          name: '⏰ Claimed At',
          value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
          inline: false
        },
        {
          name: '⚡ Response Time',
          value: `Successfully sniped on first attempt`,
          inline: false
        }
      ],
      footer: {
        text: '✨ Vanity Sniper • Mission Accomplished',
        icon_url: 'https://cdn.discordapp.com/emojis/1234567890.png'
      },
      thumbnail: {
        url: 'https://cdn.discordapp.com/attachments/1234567890/checkmark.gif'
      },
      timestamp: new Date().toISOString()
    }],
    content: '🎊 <@1418277265665560609> **VANITY CLAIMED!** 🎊'
  }).catch(() => {});
}

function sendStatusWebhook(title, description, color, fields = []) {
  if (!WEBHOOK) return;
  
  // Add visual separator to description if fields exist
  const enhancedDescription = fields.length > 0 
    ? `${description}\n━━━━━━━━━━━━━━━━━━━━━━`
    : description;
  
  axios.post(WEBHOOK, {
    embeds: [{
      title: title,
      description: enhancedDescription,
      color: color,
      fields: fields,
      footer: {
        text: '⚙️ Vanity Sniper • Status Update',
        icon_url: 'https://cdn.discordapp.com/emojis/1234567890.png'
      },
      timestamp: new Date().toISOString()
    }]
  }).catch(() => {});
}

let proxyFailureCount = 0;
const MAX_PROXY_FAILURES = 3;

async function createTlsSocket() {
  // Use cached proxy URL to avoid re-fetching on every request
  if (!proxyUrlFetched) {
    cachedProxyUrl = await getProxyUrl();
    proxyUrlFetched = true;
  }
  
  if (cachedProxyUrl) {
    try {
      return await createTlsSocketThroughProxy(cachedProxyUrl);
    } catch (err) {
      proxyFailureCount++;
      console.error(`Proxy connection failed (${proxyFailureCount}/${MAX_PROXY_FAILURES}):`, err.message);
      
      // If too many failures, refresh proxy
      if (proxyFailureCount >= MAX_PROXY_FAILURES) {
        console.log('Too many proxy failures, refreshing proxy...');
        proxyUrlFetched = false;
        cachedProxyUrl = null;
        proxyFailureCount = 0;
        
        // Get new proxy
        cachedProxyUrl = await getProxyUrl();
        proxyUrlFetched = true;
        
        if (cachedProxyUrl) {
          return await createTlsSocketThroughProxy(cachedProxyUrl);
        }
      }
      throw err;
    }
  }
  return createDirectTlsSocket();
}

async function sendHttpRequest(method, path, body = null, extraHeaders = {}, closeConnection = false) {
  // Track this request for throughput metrics
  recordRequest();
  
  return new Promise(async (resolve) => {
    const payload = body ? JSON.stringify(body) : '';

    try {
      const socket = await createTlsSocket();
      socket.setNoDelay(true);

      const headers = [
        `${method} ${path} HTTP/1.1`,
        'Host: canary.discord.com',
        'Connection: close',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(payload)}`,
        `User-Agent: ${USER_AGENT}`,
        `Authorization: ${USER_TOKEN}`,
        `X-Super-Properties: ${X_SUPER_PROPERTIES}`,
        'X-Discord-Locale: en-US',
        'X-Discord-Timezone: America/New_York',
        'Accept: */*',
        'Accept-Language: en-US,en;q=0.9',
        'Referer: https://canary.discord.com/channels/@me',
        'Origin: https://canary.discord.com'
      ];

      if (extraHeaders['X-Discord-MFA-Authorization']) {
        headers.push(`X-Discord-MFA-Authorization: ${extraHeaders['X-Discord-MFA-Authorization']}`);
      }

      headers.push('', payload);

      let responseData = '';
      let resolved = false;
      let timeoutId = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        socket.removeAllListeners();
        socket.destroy();
      };

      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(result);
      };

      const parseResponse = () => {
        const separatorIndex = responseData.indexOf('\r\n\r\n');
        if (separatorIndex === -1) {
          console.log('DEBUG: No header separator found in response');
          return '{}';
        }

        const headerPart = responseData.slice(0, separatorIndex);
        const headerLower = headerPart.toLowerCase();
        let bodyData = responseData.slice(separatorIndex + 4);
        
        // Extract and log HTTP status line for debugging
        const statusLine = headerPart.split('\r\n')[0];
        if (!statusLine.includes('200') && !statusLine.includes('201')) {
          console.log('DEBUG: HTTP Response:', statusLine);
        }

        if (headerLower.includes('transfer-encoding: chunked')) {
          let decoded = '';
          let pos = 0;
          while (pos < bodyData.length) {
            const sizeEnd = bodyData.indexOf('\r\n', pos);
            if (sizeEnd === -1) break;
            const size = parseInt(bodyData.substring(pos, sizeEnd), 16);
            if (size === 0) break;
            decoded += bodyData.substr(sizeEnd + 2, size);
            pos = sizeEnd + 2 + size + 2;
          }
          return decoded || '{}';
        } else {
          const contentLengthMatch = headerLower.match(/content-length:\s*(\d+)/);
          if (contentLengthMatch) {
            const contentLength = parseInt(contentLengthMatch[1]);
            return bodyData.slice(0, contentLength) || '{}';
          }
          return bodyData || '{}';
        }
      };

      socket.on('data', (chunk) => {
        responseData += chunk.toString();
      });

      socket.on('error', () => finish('{}'));

      socket.on('end', () => finish(parseResponse()));

      socket.on('close', () => finish(parseResponse()));

      socket.write(headers.join('\r\n'));

      timeoutId = setTimeout(() => finish('{}'), 10000);

    } catch (err) {
      console.error('Failed to create TLS socket:', err.message);
      resolve('{}');
    }
  });
}

async function authenticateMfa() {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      console.log('Authenticating MFA...');
      const patchResp = await sendHttpRequest('PATCH', `/api/v7/guilds/${TARGET_GUILD_ID}/vanity-url`, null, {}, true);
      
      // Debug: Check if response is HTML (error page)
      if (patchResp.startsWith('<') || patchResp.startsWith('<!')) {
        console.error('ERROR: Received HTML instead of JSON. First 200 chars:', patchResp.substring(0, 200));
        
        console.error('This may indicate proxy blocking or Discord returning an error page');
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      
      if (!patchResp || patchResp === '{}') {
        console.log('Empty response, retrying...');
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      
      const patchData = JSON.parse(patchResp);

      // Handle rate limit (check both code and retry_after)
      if (patchData.retry_after || patchData.code === 40062) {
        const retryAfter = Math.ceil((patchData.retry_after || 3) * 1000) + 500;
        console.log(`Rate limited, waiting ${retryAfter}ms`);
        await new Promise(r => setTimeout(r, retryAfter));
        continue;
      }

      if (patchData.code === 60003) {
        console.log('MFA ticket received, finishing with password...');
        const finishResp = await sendHttpRequest('POST', '/api/v9/mfa/finish', {
          ticket: patchData.mfa.ticket,
          mfa_type: 'password',
          data: USER_PASSWORD
        }, {}, true);

        const finishData = JSON.parse(finishResp);

        // Handle rate limit on finish
        if (finishData.retry_after || finishData.code === 40062) {
          const retryAfter = Math.ceil((finishData.retry_after || 3) * 1000) + 500;
          console.log(`MFA finish rate limited, waiting ${retryAfter}ms`);
          await new Promise(r => setTimeout(r, retryAfter));
          continue;
        }

        // Handle password mismatch
        if (finishData.code === 60008) {
          console.log('ERROR: Password does not match for this token');
          return null;
        }

        if (finishData.token) {
          console.log('MFA token obtained successfully');
          return finishData.token;
        } else {
          console.log('MFA finish response:', JSON.stringify(finishData).substring(0, 100));
        }
      }
    } catch (err) {
      console.error('MFA error:', err.message);
      // Wait a bit before retrying on error
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return null;
}

async function establishGatewayConnection() {
  const proxyUrl = await getProxyUrl();

  let wsOptions = {};
  if (proxyUrl) {
    console.log('Using proxy for WebSocket connection');
    wsOptions.agent = new HttpsProxyAgent(proxyUrl);
  }

  const ws = new WebSocket('wss://gateway-us-east1-b.discord.gg', wsOptions);

  ws.on('open', () => {
    ws.send(JSON.stringify({
      op: 2,
      d: {
        token: USER_TOKEN,
        intents: 513,
        properties: {
          os: 'Windows',
          browser: 'Chrome',
          device: '',
          system_locale: 'en-US',
          browser_user_agent: USER_AGENT,
          browser_version: '131.0.0.0',
          os_version: '10',
          referrer: 'https://www.google.com/',
          referring_domain: 'www.google.com',
          referrer_current: '',
          referring_domain_current: '',
          release_channel: 'stable',
          client_build_number: 358295,
          client_event_source: null
        }
      }
    }));
  });

  ws.on('message', async (msg) => {
    const packet = JSON.parse(msg);

    if (packet.s) latestSequence = packet.s;

    if (packet.op === 10) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        ws.send(JSON.stringify({ op: 1, d: latestSequence }));
      }, packet.d.heartbeat_interval);
    } else if (packet.op === 0) {
      if (packet.t === 'GUILD_UPDATE') {
        const oldCode = vanityMap.get(packet.d.guild_id);
        if (oldCode && oldCode !== packet.d.vanity_url_code) {
          console.log(`Vanity changed: ${oldCode}`);

          let success = false;
          for (let i = 0; i < 3; i++) {
            const snipeResp = await sendHttpRequest('PATCH', `/api/v7/guilds/${TARGET_GUILD_ID}/vanity-url`, {
              code: oldCode
            }, { 'X-Discord-MFA-Authorization': mfaAuthToken });

            try {
              const snipeData = JSON.parse(snipeResp);
              if (snipeData.code === oldCode || snipeData.vanity_url_code === oldCode || (!snipeData.code && !snipeData.message)) {
                console.log(`URL claimed: ${oldCode}`);
                sendWebhook(oldCode);
                success = true;
                break;
              }
            } catch {}
          }

          if (!success) {
            console.log(`Failed to claim URL: ${oldCode}`);
          }
        }
      } else if (packet.t === 'READY') {
        console.log('[CONNECTION] Gateway connection successful');
        packet.d.guilds.forEach(g => {
          if (g.vanity_url_code) {
            vanityMap.set(g.id, g.vanity_url_code);
          }
        });
        console.log(`Monitoring ${vanityMap.size} vanity URLs`);
      }
    }
  });

  ws.on('close', () => {
    console.log('[ERROR] Connection lost, reconnecting...');
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    setTimeout(establishGatewayConnection, 5000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    ws.close();
  });
}

async function checkAndClaimVanity() {
  try {
    const claimResp = await sendHttpRequest('PATCH', `/api/v7/guilds/${TARGET_GUILD_ID}/vanity-url`, {
      code: TARGET_VANITY
    }, { 'X-Discord-MFA-Authorization': mfaAuthToken });

    const claimData = JSON.parse(claimResp);

    // Handle rate limit
    if (claimData.code === 40062) {
      const retryAfter = (claimData.retry_after || 3) * 1000;
      console.log(`Rate limited, waiting ${retryAfter}ms`);
      await new Promise(r => setTimeout(r, retryAfter));
      return { success: false, shouldContinue: true };
    }

    // Handle MFA requirement - refresh token
    if (claimData.code === 60003) {
      console.log('MFA required, refreshing token...');
      const newToken = await authenticateMfa();
      if (newToken) {
        mfaAuthToken = newToken;
        console.log('MFA token refreshed');
      }
      return { success: false, shouldContinue: true };
    }

    // Handle vanity already taken or invalid
    if (claimData.code === 50020) {
      console.log(`Vanity "${TARGET_VANITY}" is already taken or invalid. Retrying in 5 seconds...`);
      return { success: false, shouldContinue: true, slowDown: true };
    }

    // Handle unknown message errors (likely rate limiting or malformed request)
    if (claimData.code === 10008) {
      console.log('Received error 10008, slowing down requests...');
      return { success: false, shouldContinue: true, slowDown: true };
    }

    // Check for success
    if (claimData.code === TARGET_VANITY || claimData.vanity_url_code === TARGET_VANITY || (!claimData.code && !claimData.message)) {
      console.log(`URL claimed: ${TARGET_VANITY}`);
      sendWebhook(TARGET_VANITY);
      return { success: true, shouldContinue: false };
    }

    console.log('Claim response:', JSON.stringify(claimData).substring(0, 150));
  } catch (err) {
    console.error('Claim error:', err.message);
  }
  return { success: false, shouldContinue: true, slowDown: true };
}

function getPollingDelay() {
  const now = Date.now();
  const releaseTime = new Date(RELEASE_DATE).getTime();
  const timeUntilRelease = releaseTime - now;
  
  // If release time has passed or is within hyper mode window
  if (timeUntilRelease <= HYPER_MODE_SECONDS_BEFORE * 1000) {
    return 50; // 🚀 HYPER MODE: 50ms (20 requests/second)
  }
  
  // More than 1 hour away: poll every 5 minutes (very conservative)
  if (timeUntilRelease > 60 * 60 * 1000) {
    return 5 * 60 * 1000;
  }
  
  // 30-60 minutes away: poll every 2 minutes
  if (timeUntilRelease > 30 * 60 * 1000) {
    return 2 * 60 * 1000;
  }
  
  // 15-30 minutes away: poll every minute
  if (timeUntilRelease > 15 * 60 * 1000) {
    return 60 * 1000;
  }
  
  // 5-15 minutes away: poll every 30 seconds
  if (timeUntilRelease > 5 * 60 * 1000) {
    return 30000;
  }
  
  // 2-5 minutes away: poll every 10 seconds
  if (timeUntilRelease > 2 * 60 * 1000) {
    return 10000;
  }
  
  // 1-2 minutes away: poll every 5 seconds
  if (timeUntilRelease > 60 * 1000) {
    return 5000;
  }
  
  // 30-60 seconds away: poll every 2 seconds
  if (timeUntilRelease > 30 * 1000) {
    return 2000;
  }
  
  // Less than 30 seconds: poll every second (ramping up)
  return 1000;
}

async function pollTargetVanity() {
  const releaseTime = new Date(RELEASE_DATE);
  console.log(`Polling for vanity: ${TARGET_VANITY}`);
  console.log(`Release time set to: ${releaseTime.toUTCString()}`);
  console.log(`Hyper mode will activate ${HYPER_MODE_SECONDS_BEFORE} seconds before release`);
  
  const formatTimeRemaining = (ms) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  // Wait until we're close to release time
  const waitUntilNearRelease = async () => {
    const now = Date.now();
    const releaseTimeMs = new Date(RELEASE_DATE).getTime();
    const timeUntilRelease = releaseTimeMs - now;
    
    // Wake up time: 90 seconds before release for competitive edge
    const WAKE_UP_SECONDS = 90;
    const wakeUpTime = releaseTimeMs - (WAKE_UP_SECONDS * 1000);
    const timeUntilWakeUp = wakeUpTime - now;
    
    if (timeUntilWakeUp > 0) {
      console.log(`😴 Sleeping until ${WAKE_UP_SECONDS}s before release...`);
      console.log(`⏰ Will wake up in: ${formatTimeRemaining(timeUntilWakeUp)}`);
      console.log(`💤 Bot paused to avoid rate limits. ZzZz...`);
      
      // Set a timer to wake up
      setTimeout(() => {
        console.log(`🔔 WAKE UP! Starting aggressive polling now!`);
        startPolling();
      }, timeUntilWakeUp);
      
      // Log countdown every 10 minutes while sleeping
      const countdownInterval = setInterval(() => {
        const remaining = wakeUpTime - Date.now();
        if (remaining <= 0) {
          clearInterval(countdownInterval);
        } else {
          console.log(`💤 Still sleeping... ${formatTimeRemaining(remaining)} until wake up`);
        }
      }, 10 * 60 * 1000); // Every 10 minutes
      
    } else {
      // We're already past wake-up time, start polling immediately
      console.log(`⚡ Already within ${WAKE_UP_SECONDS}s of release! Starting aggressive polling now!`);
      startPolling();
    }
  };

  const startPolling = async () => {
    const poll = async () => {
      const result = await checkAndClaimVanity();
      if (result.shouldContinue) {
        const releaseTimeMs = new Date(RELEASE_DATE).getTime();
        const timeUntilRelease = releaseTimeMs - Date.now();
        const stats = getThroughputStats();
        const rpsDisplay = `[${stats.current} req/s | avg: ${stats.average} | peak: ${stats.peak} | total: ${stats.total}]`;
        
        let delay;
        if (timeUntilRelease <= 3000) {
          // Final 3 seconds: BURST MODE (15ms = 66 req/sec) - sustainable burst
          delay = 15;
          console.log(`💥 BURST MODE - ${Math.round(timeUntilRelease / 1000)}s left! ${rpsDisplay}`);
        } else if (timeUntilRelease <= 10000) {
          // 3-10 seconds: MAXIMUM SPEED (30ms = 33 req/sec) - aggressive but safe
          delay = 30;
          console.log(`🔥 MAXIMUM ATTACK - ${Math.round(timeUntilRelease / 1000)}s left! ${rpsDisplay}`);
        } else if (timeUntilRelease <= 20000) {
          // 10-20 seconds: High speed (50ms = 20 req/sec)
          delay = 50;
          console.log(`🚀 HIGH SPEED - ${Math.round(timeUntilRelease / 1000)}s until release ${rpsDisplay}`);
        } else if (timeUntilRelease <= 40000) {
          // 20-40 seconds: Ramping up (100ms = 10 req/sec)
          delay = 100;
          console.log(`⚡ RAMPING UP - ${Math.round(timeUntilRelease / 1000)}s until release ${rpsDisplay}`);
        } else if (timeUntilRelease <= 60000) {
          // 40-60 seconds: Fast polling (200ms = 5 req/sec)
          delay = 200;
          console.log(`⏩ FAST MODE - ${Math.round(timeUntilRelease / 1000)}s until release ${rpsDisplay}`);
        } else {
          // 60-90 seconds: Warm-up mode (500ms = 2 req/sec)
          delay = 500;
          console.log(`🔄 WARM-UP - ${Math.round(timeUntilRelease / 1000)}s until release ${rpsDisplay}`);
        }
        
        // If we hit a rate limit, back off momentarily but keep trying
        if (result.slowDown && timeUntilRelease > 5000) {
          delay = Math.max(delay * 2, 1000); // Double delay, max 1s
          console.log(`⚠️ Rate limit detected, slowing to ${delay}ms`);
        }
        
        setTimeout(poll, delay);
      }
    };
    poll();
  };

  waitUntilNearRelease();
}

async function main() {
  console.log('Starting program...');
  console.log('Proxy support: ' + (PROXY_ENABLED ? 'Enabled' : 'Disabled'));
  console.log('Mode: ' + (TARGET_VANITY ? `Targeting vanity "${TARGET_VANITY}"` : 'Monitoring joined servers'));
  console.log('User tokens loaded:', userTokens.length);
  console.log('Throughput tracking: Enabled (RPS stats will show during polling)');
  
  // Start token rotation
  startTokenRotation();

  if (!mfaAuthToken) {
    console.log('Fetching token...');
    mfaAuthToken = await authenticateMfa();
    if (mfaAuthToken) {
      console.log('Token successfully retrieved');
    } else {
      console.log('⚠️ Failed to obtain MFA token, skipping test claim');
    }
  }

  // One-time test vanity claim on startup (only if MFA token is available)
  if (mfaAuthToken) {
    console.log('Attempting to claim test vanity: 0161');
    const testClaimResp = await sendHttpRequest('PATCH', `/api/v7/guilds/${TARGET_GUILD_ID}/vanity-url`, {
      code: '0161'
    }, { 'X-Discord-MFA-Authorization': mfaAuthToken });
    
    try {
      const testClaimData = JSON.parse(testClaimResp);
      if (testClaimData.code === '0161' || testClaimData.vanity_url_code === '0161' || (!testClaimData.code && !testClaimData.message)) {
        console.log('✅ Test vanity "0161" claimed successfully!');
        sendWebhook('0161');
      } else if (testClaimData.code === 50020) {
        console.log('❌ Test vanity "0161" is already taken or invalid');
      } else if (testClaimData.retry_after) {
        console.log(`⏳ Test claim rate limited, retry after ${testClaimData.retry_after}s`);
      } else {
        console.log('Test claim response:', JSON.stringify(testClaimData).substring(0, 150));
      }
    } catch (err) {
      console.log('Test claim error:', err.message);
    }
  }

  // Self-correcting MFA refresh timer (every 4 minutes)
  const mfaRefreshMs = 4 * 60 * 1000;
  let expectedMfaRefresh = Date.now() + mfaRefreshMs;
  
  const scheduleMfaRefresh = async () => {
    const now = Date.now();
    const drift = now - expectedMfaRefresh;
    
    if (Math.abs(drift) > 100) {
      console.log(`MFA refresh timer drift: ${drift}ms, compensating...`);
    }
    
    const refreshedToken = await authenticateMfa();
    if (refreshedToken) mfaAuthToken = refreshedToken;
    
    // Schedule next refresh, compensating for drift
    expectedMfaRefresh += mfaRefreshMs;
    const nextDelay = Math.max(0, expectedMfaRefresh - Date.now());
    setTimeout(scheduleMfaRefresh, nextDelay);
  };
  
  setTimeout(scheduleMfaRefresh, mfaRefreshMs);

  if (TARGET_VANITY) {
    pollTargetVanity();
  } else {
    establishGatewayConnection();
  }
}

main();
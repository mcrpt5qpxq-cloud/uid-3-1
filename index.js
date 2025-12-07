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

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const X_SUPER_PROPERTIES = 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2xvY2FsZSI6ImVuLVVTIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEzMS4wLjAuMCBTYWZhcmkvNTM3LjM2IiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTMxLjAuMC4wIiwib3NfdmVyc2lvbiI6IjEwIiwicmVmZXJyZXIiOiJodHRwczovL3d3dy5nb29nbGUuY29tLyIsInJlZmVycmluZ19kb21haW4iOiJ3d3cuZ29vZ2xlLmNvbSIsInJlZmVycmVyX2N1cnJlbnQiOiIiLCJyZWZlcnJpbmdfZG9tYWluX2N1cnJlbnQiOiIiLCJyZWxlYXNlX2NoYW5uZWwiOiJzdGFibGUiLCJjbGllbnRfYnVpbGRfbnVtYmVyIjozNTgyOTUsImNsaWVudF9ldmVudF9zb3VyY2UiOm51bGwsImRlc2lnbl9pZCI6MH0=';

async function fetchWebshareProxies() {
  if (!WEBSHARE_API_KEY) {
    console.log('No Webshare API key configured');
    return null;
  }

  const cleanApiKey = WEBSHARE_API_KEY.replace(/\s+/g, '').replace(/[\r\n]/g, '');

  try {
    const response = await axios.get('https://proxy.webshare.io/api/v2/proxy/list/', {
      params: {
        mode: 'backbone',
        page: 1,
        page_size: 25
      },
      headers: {
        'Authorization': `Token ${cleanApiKey}`
      }
    });

    if (response.data.results && response.data.results.length > 0) {
      const proxy = response.data.results[0];
      const proxyUrl = `http://${proxy.username}:${proxy.password}@${proxy.proxy_address}:${proxy.port}`;
      console.log(`Loaded proxy: ${proxy.proxy_address}:${proxy.port}`);
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
  if (!PROXY_ENABLED) return null;
  if (PROXY_URL) return PROXY_URL;
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
  console.log(`Rotated to token ${currentTokenIndex + 1}/${userTokens.length}`);
};

const startTokenRotation = () => {
  if (userTokens.length <= 1) {
    console.log('Only 1 token, rotation disabled');
    return;
  }
  const rotateMs = TOKEN_ROTATE_MINUTES * 60 * 1000;
  console.log(`Token rotation enabled: every ${TOKEN_ROTATE_MINUTES} minute(s)`);
  tokenRotateTimer = setInterval(() => {
    rotateToNextToken();
    // Re-authenticate MFA for new token
    authenticateMfa().then(token => {
      if (token) mfaAuthToken = token;
    });
  }, rotateMs);
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
      description: `Successfully claimed the vanity URL`,
      color: 0x00ff00,
      fields: [
        {
          name: '🔗 Vanity URL',
          value: `\`${vanityUrl}\``,
          inline: true
        },
        {
          name: '⏰ Claimed At',
          value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
          inline: true
        }
      ],
      footer: {
        text: 'Vanity Sniper • Successfully Sniped'
      },
      timestamp: new Date().toISOString()
    }],
    content: '<@1418277265665560609>'
  }).catch(() => {});
}

async function createTlsSocket() {
  const proxyUrl = await getProxyUrl();
  if (proxyUrl) {
    console.log('Using proxy for TLS connection');
    return await createTlsSocketThroughProxy(proxyUrl);
  }
  console.log('Using direct TLS connection');
  return createDirectTlsSocket();
}

async function sendHttpRequest(method, path, body = null, extraHeaders = {}, closeConnection = false) {
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
        if (separatorIndex === -1) return '{}';

        const headerPart = responseData.slice(0, separatorIndex).toLowerCase();
        let bodyData = responseData.slice(separatorIndex + 4);

        if (headerPart.includes('transfer-encoding: chunked')) {
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
          const contentLengthMatch = headerPart.match(/content-length:\s*(\d+)/);
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
        
        let delay;
        if (timeUntilRelease <= 10000) {
          // Final 10 seconds: MAXIMUM SPEED (25ms = 40 req/sec)
          delay = 25;
          console.log(`🔥 MAXIMUM ATTACK - ${Math.round(timeUntilRelease / 1000)}s left!`);
        } else if (timeUntilRelease <= 30000) {
          // 10-30 seconds: Hyper mode (50ms = 20 req/sec)
          delay = 50;
          console.log(`🚀 HYPER MODE - ${Math.round(timeUntilRelease / 1000)}s until release`);
        } else if (timeUntilRelease <= 60000) {
          // 30-60 seconds: Fast polling (200ms = 5 req/sec)
          delay = 200;
          console.log(`⚡ FAST MODE - ${Math.round(timeUntilRelease / 1000)}s until release`);
        } else {
          // 60-90 seconds: Warm-up mode (500ms = 2 req/sec)
          delay = 500;
          console.log(`🔄 WARM-UP - ${Math.round(timeUntilRelease / 1000)}s until release`);
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
  
  // Start token rotation
  startTokenRotation();

  if (!mfaAuthToken) {
    console.log('Fetching token...');
    mfaAuthToken = await authenticateMfa();
    if (mfaAuthToken) {
      console.log('Token successfully retrieved');
    }
  }

  setInterval(async () => {
    const refreshedToken = await authenticateMfa();
    if (refreshedToken) mfaAuthToken = refreshedToken;
  }, 4 * 60 * 1000);

  if (TARGET_VANITY) {
    pollTargetVanity();
  } else {
    establishGatewayConnection();
  }
}

main();
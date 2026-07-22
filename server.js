require('dotenv').config();
const express = require('express');
const https = require('https');
const { URL } = require('url');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── HTTPS Request Helper ────────────────────────────────────────
function httpsRequest(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
        ...(options.headers || {}),
      },
      // Accept self-signed or corporate certs
      rejectUnauthorized: false,
    };

    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ─── Cookie Helper ───────────────────────────────────────────────
function extractCookies(headers) {
  const setCookies = headers['set-cookie'] || [];
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

function mergeCookies(existing, newCookies) {
  const map = {};
  const parse = (str) => {
    if (!str) return;
    str.split('; ').forEach((pair) => {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        map[pair.substring(0, idx)] = pair.substring(idx + 1);
      }
    });
  };
  parse(existing);
  parse(newCookies);
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

// ─── EPMS Login ──────────────────────────────────────────────────
async function epmsLogin(username, password) {
  const BASE = 'https://yeniceri.epms.com.tr';

  // Step 1: GET login page to obtain CSRF token and cookies
  const loginPageRes = await httpsRequest(`${BASE}/Portal/Giris/Personel`);
  let cookies = extractCookies(loginPageRes.headers);

  // Extract __RequestVerificationToken from hidden input
  const $ = cheerio.load(loginPageRes.body);
  const token = $('input[name="__RequestVerificationToken"]').val();

  if (!token) {
    throw new Error('CSRF token alınamadı. EPMS sayfasına erişilemiyor olabilir.');
  }

  // Step 2: POST login credentials
  const formBody = new URLSearchParams({
    __RequestVerificationToken: token,
    KullaniciAdi: username,
    Sifre: password,
    beniHatirla: 'false',
  }).toString();

  const loginRes = await httpsRequest(`${BASE}/Portal/Giris/PersonelGiris`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookies,
      'Referer': `${BASE}/Portal/Giris/Personel`,
    },
    body: formBody,
  });

  // Merge cookies from login response
  cookies = mergeCookies(cookies, extractCookies(loginRes.headers));

  // Follow redirect(s) if any
  if (loginRes.statusCode === 302 || loginRes.statusCode === 301) {
    let location = loginRes.headers['location'];
    if (location && !location.startsWith('http')) {
      location = `${BASE}${location}`;
    }

    const redirectRes = await httpsRequest(location, {
      headers: { Cookie: cookies },
    });
    cookies = mergeCookies(cookies, extractCookies(redirectRes.headers));

    // Check if we got redirected back to login (wrong credentials)
    if (
      redirectRes.body.includes('PersonelGiris') &&
      redirectRes.body.includes('KullaniciAdi')
    ) {
      throw new Error('Kullanıcı adı veya şifre hatalı.');
    }
  }

  // Verify we're logged in by checking if we have auth cookies
  if (!cookies || cookies.length < 20) {
    throw new Error('Giriş başarısız. Lütfen bilgilerinizi kontrol edin.');
  }

  return cookies;
}

// ─── Fetch & Parse Vardiya ───────────────────────────────────────
async function fetchVardiyaData(cookies) {
  const BASE = 'https://yeniceri.epms.com.tr';

  const res = await httpsRequest(`${BASE}/Portal/Home/Vardiya`, {
    headers: { Cookie: cookies },
  });

  // Check if redirected to login (session expired)
  if (
    res.body.includes('PersonelGiris') ||
    res.body.includes('/Portal/Giris')
  ) {
    throw new Error('SESSION_EXPIRED');
  }

  const $ = cheerio.load(res.body);

  // Extract month/year from caption
  require('fs').writeFileSync('epms_full.html', res.body);
  const captionText = $('div.caption')
    .filter(function () {
      return $(this).text().includes('Planlanan Vardiya');
    })
    .text()
    .trim();

  // Parse header row to get day numbers and day names
  const headers = [];
  $('table.table thead tr th, table.table tr:first-child th').each(function (i) {
    if (i === 0) return; // Skip "Personel" column
    const text = $(this).text().trim();
    // Text format: "1\nÇa" or "2\nPe"
    const parts = text.split(/\s+/);
    headers.push({
      day: parseInt(parts[0], 10),
      dayName: parts[1] || '',
    });
  });

  // Parse data rows
  const personnel = [];
  $('table.table tr[id]').each(function () {
    const $row = $(this);
    const name = $row.find('td:first-child').text().trim();
    const shifts = [];

    $row.find('td').each(function (i) {
      if (i === 0) return; // Skip name column
      const cellText = $(this).text().trim().toLowerCase();
      shifts.push(cellText);
      const style = $(this).attr('style');
      const clazz = $(this).attr('class');
      if (cellText && style && style !== '') {
        require('fs').appendFileSync('epms_colors.txt', cellText + ' -> ' + style + ' | class: ' + clazz + '\n');
      } else if (cellText && clazz) {
        require('fs').appendFileSync('epms_colors.txt', cellText + ' -> class: ' + clazz + '\n');
      }
    });

    if (name) {
      personnel.push({ name, shifts });
    }
  });

  return {
    caption: captionText,
    headers,
    personnel,
    totalPersonnel: personnel.length,
  };
}

// ─── Session Store (in-memory, simple) ───────────────────────────
const sessions = new Map();

function generateSessionId() {
  return (
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15) +
    Date.now().toString(36)
  );
}

// ─── API Routes ──────────────────────────────────────────────────

// Login endpoint
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Kullanıcı adı ve şifre gereklidir.' });
  }

  try {
    const cookies = await epmsLogin(username, password);
    const sessionId = generateSessionId();
    sessions.set(sessionId, {
      cookies,
      username,
      createdAt: Date.now(),
    });

    // Clean old sessions (older than 4 hours)
    const FOUR_HOURS = 4 * 60 * 60 * 1000;
    for (const [key, val] of sessions.entries()) {
      if (Date.now() - val.createdAt > FOUR_HOURS) {
        sessions.delete(key);
      }
    }

    res.json({ success: true, sessionId, username });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(401).json({ error: err.message });
  }
});

// Vardiya data endpoint
app.get('/api/vardiya', async (req, res) => {
  const sessionId = req.headers['x-session-id'];

  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(401).json({ error: 'Oturum bulunamadı. Lütfen giriş yapın.' });
  }

  const session = sessions.get(sessionId);

  try {
    const data = await fetchVardiyaData(session.cookies);
    res.json(data);
  } catch (err) {
    if (err.message === 'SESSION_EXPIRED') {
      sessions.delete(sessionId);
      return res
        .status(401)
        .json({ error: 'EPMS oturumu sona erdi. Lütfen tekrar giriş yapın.' });
    }
    console.error('Vardiya fetch error:', err.message);
    res.status(500).json({ error: 'Vardiya verileri alınamadı: ' + err.message });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (sessionId) {
    sessions.delete(sessionId);
  }
  res.json({ success: true });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', activeSessions: sessions.size });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start Server ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║   🔄 Vardiya Görüntüleyici Başlatıldı     ║
║                                            ║
║   📍 http://localhost:${PORT}               ║
║   📱 Telefondan: http://<IP>:${PORT}        ║
║                                            ║
║   Durdurmak için: Ctrl+C                  ║
╚════════════════════════════════════════════╝
  `);
});

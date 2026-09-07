const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const origin = 'https://pickle-street-tugbok.boothsandbeyondoffic.chatgpt.site';
for (const name of fs.readdirSync(root)) {
  if (!/\.(html|css|js)$/.test(name) || /\.min\.js$|\.test\.js$/.test(name) || ['create-accounts.js','setup-db.js','seed-demo-data.js'].includes(name)) continue;
  const file = path.join(root, name);
  let source = fs.readFileSync(file, 'utf8');
  source = source.replaceAll('Paddle Rage Pickleball', 'Pickle Street Tugbok')
    .replaceAll('PADDLE RAGE PICKLEBALL', 'PICKLE STREET TUGBOK')
    .replaceAll('Paddle Rage', 'Pickle Street').replaceAll('PADDLE RAGE', 'PICKLE STREET')
    .replaceAll('Iponan, Cagayan de Oro', 'Tugbok, Davao City')
    .replaceAll('paddleragecdo.ph', 'pickle-street-tugbok.boothsandbeyondoffic.chatgpt.site')
    .replaceAll('paddle_rage_local_db_v1', 'pickle_street_tugbok_local_db_v1')
    .replaceAll('@paddlerage.local', '@picklestreet.local')
    .replaceAll('Feel the Rage', 'Make time to play').replaceAll('Live the Game', 'See you on court')
    .replaceAll('paddleragelogo-transparent.png', 'assets/pickle-street-mark.svg')
    .replaceAll('paddleragelogo.jpg', 'assets/pickle-street-mark.svg')
    .replaceAll('paddlerageqrgcash.jpg', 'assets/payment-not-configured.svg')
    .replaceAll('maximum-scale=1, user-scalable=no, ', '');
  if (name.endsWith('.html')) {
    source = source.replace(/<meta (?:property="og:image[^\"]*"|name="twitter:image[^\"]*")[^>]*>\r?\n/g, '');
    source = source.replace(/<link href="https:\/\/fonts.googleapis.com\/css2\?[^\"]*" rel="stylesheet"\s*\/>/g, '<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@400;500;600;650;700;800&display=swap" rel="stylesheet" />');
    source = source.replace('</head>', '<link rel="stylesheet" href="pickle-street.css?v=1">\n<meta name="robots" content="noindex,nofollow">\n</head>');
  }
  if (name === 'index.html') {
    source = source.replace('<body class="dark">', '<body class="light pickle-street-public">');
    source = source.replace('id="splashScreen"', 'id="splashScreen" class="dismissed" style="display:none"');
    source = source.replace("document.body.style.overflow = 'hidden';\n\ndocument.addEventListener('DOMContentLoaded', async () => {", "document.body.style.overflow = '';\n\ndocument.addEventListener('DOMContentLoaded', async () => {");
    source = source.replaceAll('Advance booking · opening Sep 19', 'Choose your next court day');
    source = source.replace('<h2>🏟️ SELECT A COURT</h2>', '<h2>Your court. Your time.</h2>');
    source = source.replace('<div class="nav-headline">\n    🏓 <span class="hl">𝑺𝒆𝒓𝒗𝒆. 𝑺𝒎𝒂𝒔𝒉. 𝑾𝒊𝒏. 𝑹𝒆𝒑𝒆𝒂𝒕.</span>\n  </div>', '<div class="nav-headline"><a href="#courts">Book a court</a><a href="host.html">Open Play</a></div>');
    source = source.replace('<!-- COURTS -->', `<header class="venue-intro"><div class="venue-intro-copy"><span class="venue-eyebrow">PICKLEBALL / TUGBOK, DAVAO CITY</span><h1>A little court time.<br><em>A better day.</em></h1><p>Fresh air, good rallies, your favorite people.<br>Find your next game at Pickle Street.</p><div class="venue-intro-meta"><span>Outdoor courts</span><span>Easy online booking</span></div></div><div class="venue-photo"><img src="assets/pickle-street-courts.jpg" alt="Blue and green outdoor pickleball courts at Pickle Street Tugbok" width="1920" height="1080"><span>WELCOME TO YOUR NEIGHBORHOOD COURT</span></div></header>\n<!-- COURTS -->`);
    source = source.replaceAll("  initOpAnnounceSplash();", '').replaceAll('  initEasterSplash();', '').replaceAll('  initGrandSplash();', '');
  }
  if (name === 'supabase-config.js') {
    source = source.replace("const SUPABASE_URL = 'https://qhvrowoqeyeypmefwkha.supabase.co';", "const SUPABASE_URL = 'https://neqvrwtofiolcuxewdze.supabase.co';");
    source = source.replace(/const SUPABASE_ANON_KEY = '[^']+';/, "const SUPABASE_ANON_KEY = 'sb_publishable_UHMKYGsygjeMl79VRfPNVw_RyWiV5Yr';");
    source = source.replace("const PB_PUBLIC_COURT_OPENING_DATE = '2026-09-19';", "const PB_PUBLIC_COURT_OPENING_DATE = '2026-01-01';");
    source = source.replace('Array.from({ length: 10 }', 'Array.from({ length: 3 }');
    source = source.replace("photo: '',", "photo: 'assets/pickle-street-courts.jpg',");
    source = source.replace('bookings: defaultHostDemoBookings(),', 'bookings: [],');
    source = source.replace('for (const demoBooking of defaultHostDemoBookings()) {', 'for (const demoBooking of []) {');
    // Until the new platform adapter is selected, the copied standalone runtime
    // is permitted exclusively in explicitly selected device-local demo mode.
    source = source.replace('async function _pbFetchWithTimeout(input, init = {}, timeoutMs = PB_REQUEST_TIMEOUT_MS) {', "async function _pbFetchWithTimeout(input, init = {}, timeoutMs = PB_REQUEST_TIMEOUT_MS) {\n  throw new Error('The demonstration does not connect to a live database.');\n");
  }
  fs.writeFileSync(file, source);
}
fs.copyFileSync('C:/Users/hisol/AppData/Local/Temp/codex-clipboard-90784b8b-d5e7-43eb-ad36-87e50838f6d5.png', path.join(root, 'assets/pickle-street-courts.jpg'));
console.log('Pickle Street branding applied to independent workspace.');

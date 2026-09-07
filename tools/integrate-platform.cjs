const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = "D:/Q'dink-garage-pickleball";
const reference = path.join(root, 'feature-preview');
fs.mkdirSync(reference, {recursive:true});
// Preserve the complete Paddle Rage feature implementation as an explicitly
// disconnected local development reference. It is excluded from deployment.
for (const name of fs.readdirSync(root)) {
  if (/\.(html|css|js)$/.test(name) && !/\.test\.js$/.test(name)) fs.copyFileSync(path.join(root,name),path.join(reference,name));
}
const names = ['index.html','admin.html','login.html','supabase-config.js','booking-balance.js','blocked-date-access.js','open-play-data.js','open-play-public.js','open-play-admin.js','open-play-reporting.js','open-play.css','open-play-admin.css','open-play-reporting.css'];
const hero = fs.readFileSync(path.join(reference,'index.html'),'utf8').match(/<header class="venue-intro">[\s\S]*?<\/header>/)[0];
for (const name of names) {
  let text = fs.readFileSync(path.join(source,name),'utf8');
  text = text.replaceAll("Q'Dink Garage", 'Pickle Street Tugbok').replaceAll("Q'DINK GARAGE", 'PICKLE STREET TUGBOK')
    .replaceAll("Q’Dink Garage", 'Pickle Street Tugbok').replaceAll('Q&#39;Dink Garage', 'Pickle Street Tugbok')
    .replaceAll('qdinkgarage.pages.dev', 'pickle-street-tugbok.boothsandbeyondoffic.chatgpt.site')
    .replaceAll('qdink-garage','pickle-street-tugbok').replaceAll('qdink_garage','pickle_street_tugbok')
    .replaceAll('qdinklogo.jpg','assets/pickle-street-mark.svg')
    .replaceAll('pickleball-splash-v2.webp','assets/pickle-street-courts.jpg')
    .replaceAll('Picklaball','Pickleball').replaceAll('maximum-scale=1, user-scalable=no, ','');
  if (name.endsWith('.html')) {
    text = text.replace(/<meta (?:property="og:image[^\"]*"|name="twitter:image[^\"]*")[^>]*>\r?\n/g,'');
    text = text.replace(/<link[^>]*href="manifest.webmanifest"[^>]*>\r?\n/g,'');
    text = text.replace('</head>','<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">\n<link rel="stylesheet" href="pickle-street.css?v=2">\n<meta name="robots" content="noindex,nofollow">\n</head>');
    text = text.replace('<html lang="en">', `<html lang="en" data-pb-data-scope="${name === 'admin.html' ? 'manager' : name === 'index.html' ? 'public' : 'auth'}">`);
    text = text.replace('</body>', '<script src="pickle-street.js?v=2"></script>\n</body>');
  }
  if (name === 'index.html') {
    text = text.replace('id="splashScreen"', 'id="splashScreen" class="dismissed" style="display:none"');
    text = text.replace('// Lock scroll while splash is showing\n' + "document.body.style.overflow = 'hidden';", "// The booking surface is available immediately.\ndocument.body.style.overflow = '';" );
    text = text.replace('// Lock scroll while splash is showing\r\n' + "document.body.style.overflow = 'hidden';", "// The booking surface is available immediately.\ndocument.body.style.overflow = '';" );
    text = text.replace('<!-- COURTS -->',hero+'\n<!-- COURTS -->');
    text = text.replace('<div class="nav-r">', '<div class="nav-r"><a class="nav-manage-link" href="manage-booking.html">Manage booking</a><a class="nav-manage-link ps-staff-link" href="login.html">Staff login</a>');
    text = text.replace('<h2 id="courtsHeading">🏟️ BOOK A COURT</h2>', '<h2 id="courtsHeading">Your court. Your time.</h2>');
  }
  if(name==='supabase-config.js') {
    text = text.replace('if (session && canManageTenant) {', "if (session && canManageTenant && document.documentElement.dataset.pbDataScope === 'manager') {");
    text = text.replace("  global: { fetch: (input, init) => _pbFetchWithTimeout(input, init) },", "  global: { fetch: (input, init) => _pbFetchWithTimeout(input, init) },");
  }
  fs.writeFileSync(path.join(root,name),text);
}
console.log('Installed the current shared-platform booking and management contracts.');

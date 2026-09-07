export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const primaryHostname = String(env.PRIMARY_HOSTNAME || 'pickle-street-tugbok.boothsandbeyondoffic.chatgpt.site').trim().toLowerCase();
    if (primaryHostname && url.hostname === `www.${primaryHostname}`) {
      url.hostname = primaryHostname;
      return Response.redirect(url.toString(), 301);
    }

    // Cloudflare Pages resolves extensionless HTML routes through the asset
    // binding. Redirecting /host to /host.html here conflicts with Pages'
    // canonical /host.html -> /host redirect and creates a redirect loop.
    const response = await env.ASSETS.fetch(request);
    const releaseCoupledRuntime = new Set([
      '/booking-balance.js',
      '/host-balance-payment.js',
      '/host-balance-admin.js',
      '/owner-insights.js',
      '/owner-insights.css',
      '/manage-booking.js',
      '/manage-booking.css',
    ]);
    const isSharedRuntime = url.pathname === '/supabase-config.js' ||
      releaseCoupledRuntime.has(url.pathname);
    const isHtmlEntry = url.pathname === '/' ||
      url.pathname.endsWith('.html') ||
      ['/admin', '/host', '/login', '/manage-booking', '/player-live'].includes(url.pathname);
    if (!isSharedRuntime && !isHtmlEntry) return response;

    // Pages' advanced-mode asset binding can attach a four-hour cache policy
    // even when _headers asks for revalidation. Keep HTML and its shared DB
    // adapter in the same release so a newly deployed UI never calls an older
    // runtime API from the browser cache. Host balance UI, adapter, deadline
    // rules, and review controls are one release-coupled runtime set.
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store, max-age=0');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

export default { fetch: handleRequest };

const FACEBOOK_PUBLISH_PATH = '/api/facebook-page/publish';
const SUPABASE_URL = 'https://neqvrwtofiolcuxewdze.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_UHMKYGsygjeMl79VRfPNVw_RyWiV5Yr';
const TENANT_SLUG = 'pickle-street-tugbok';
const TENANT_ID = 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
const ALLOWED_PUBLISH_ROLES = new Set(['owner', 'admin', 'court_owner']);
const MAX_IMAGE_COUNT = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_CAPTION_LENGTH = 5000;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function bearerToken(request) {
  const match = String(request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function verifyPublisher(request, env) {
  const token = bearerToken(request);
  if (!token) throw Object.assign(new Error('Sign in again before publishing.'), { status: 401 });

  const supabaseUrl = String(env.SUPABASE_URL || SUPABASE_URL).replace(/\/+$/, '');
  const publishableKey = String(env.SUPABASE_PUBLISHABLE_KEY || SUPABASE_PUBLISHABLE_KEY);
  const headers = {
    apikey: publishableKey,
    Authorization: `Bearer ${token}`,
  };
  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, { headers });
  if (!userResponse.ok) throw Object.assign(new Error('Your dashboard session expired. Sign in again.'), { status: 401 });

  const sessionResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/get_my_tenant_session`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_tenant_slug: TENANT_SLUG,
      p_hostname: String(env.PRIMARY_HOSTNAME || 'picklestreetcourt.com'),
    }),
  });
  if (!sessionResponse.ok) throw Object.assign(new Error('Could not verify your Pickle Street access.'), { status: 403 });
  const session = await sessionResponse.json();
  const role = String(session?.role || '').toLowerCase();
  if (session?.tenantSlug !== TENANT_SLUG || session?.tenantId !== TENANT_ID || session?.status !== 'active' || !ALLOWED_PUBLISH_ROLES.has(role)) {
    throw Object.assign(new Error('Only a Pickle Street owner can publish Facebook posts.'), { status: 403 });
  }
  return session;
}

async function graphRequest(env, path, init) {
  const graphVersion = String(env.FACEBOOK_GRAPH_VERSION || 'v25.0').replace(/[^v0-9.]/g, '') || 'v25.0';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`https://graph.facebook.com/${graphVersion}/${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.FACEBOOK_PAGE_ACCESS_TOKEN}`,
        ...(init?.headers || {}),
      },
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = null; }
    if (!response.ok || data?.error) {
      const error = new Error('Facebook rejected the Page post. Reconnect the Page and try again.');
      error.facebookCode = data?.error?.code || null;
      error.facebookSubcode = data?.error?.error_subcode || null;
      throw error;
    }
    return data || {};
  } finally {
    clearTimeout(timeout);
  }
}

async function removeUnpublishedPhotos(env, photoIds) {
  await Promise.allSettled(photoIds.map(id => graphRequest(env, String(id), { method: 'DELETE' })));
}

async function publishFacebookPost(env, caption, images) {
  if (images.length === 1) {
    const body = new FormData();
    body.append('source', images[0], images[0].name || 'pickle-street-availability.png');
    body.append('message', caption);
    const result = await graphRequest(env, 'me/photos', { method: 'POST', body });
    return { postId: result.post_id || result.id || null, imageCount: 1 };
  }

  const photoIds = [];
  try {
    for (const image of images) {
      const body = new FormData();
      body.append('source', image, image.name || `pickle-street-availability-${photoIds.length + 1}.png`);
      body.append('published', 'false');
      const uploaded = await graphRequest(env, 'me/photos', { method: 'POST', body });
      if (!uploaded.id) throw new Error('Facebook did not return an uploaded photo ID.');
      photoIds.push(String(uploaded.id));
    }
    const body = new URLSearchParams({ message: caption });
    photoIds.forEach((id, index) => body.set(`attached_media[${index}]`, JSON.stringify({ media_fbid: id })));
    const published = await graphRequest(env, 'me/feed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
    });
    return { postId: published.id || null, imageCount: images.length };
  } catch (error) {
    await removeUnpublishedPhotos(env, photoIds);
    throw error;
  }
}

async function handleFacebookPublish(request, env) {
  if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405);
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return jsonResponse({ ok: false, error: 'This publishing request came from an untrusted site.' }, 403);
  }

  try {
    const publisher = await verifyPublisher(request, env);
    if (!env.FACEBOOK_PAGE_ACCESS_TOKEN) {
      return jsonResponse({ ok: false, error: 'Facebook Page publishing is not connected yet.' }, 503);
    }
    const form = await request.formData();
    const caption = String(form.get('caption') || '').trim();
    const images = form.getAll('images').filter(value => value instanceof File);
    const totalBytes = images.reduce((sum, image) => sum + Number(image.size || 0), 0);
    if (!caption || caption.length > MAX_CAPTION_LENGTH) {
      return jsonResponse({ ok: false, error: 'The Facebook caption is empty or too long.' }, 400);
    }
    if (!images.length || images.length > MAX_IMAGE_COUNT || totalBytes > MAX_TOTAL_IMAGE_BYTES || images.some(image => image.type !== 'image/png' || image.size < 1 || image.size > MAX_IMAGE_BYTES)) {
      return jsonResponse({ ok: false, error: 'Attach one to four valid Pickle Street PNG graphics.' }, 400);
    }

    const published = await publishFacebookPost(env, caption, images);
    console.log(JSON.stringify({ event: 'facebook_page_post_published', postId: published.postId, imageCount: published.imageCount, publisherId: publisher.id || null }));
    return jsonResponse({ ok: true, ...published });
  } catch (error) {
    const status = Number(error?.status || 0) || 502;
    console.error(JSON.stringify({ event: 'facebook_page_publish_failed', status, facebookCode: error?.facebookCode || null, facebookSubcode: error?.facebookSubcode || null }));
    return jsonResponse({ ok: false, error: String(error?.message || 'Could not publish the Facebook Page post.') }, status);
  }
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

  const primaryHostname = String(env.PRIMARY_HOSTNAME || 'picklestreetcourt.com').trim().toLowerCase();
  if (primaryHostname && url.hostname === `www.${primaryHostname}`) {
    url.hostname = primaryHostname;
    return Response.redirect(url.toString(), 301);
  }

  if (url.pathname === FACEBOOK_PUBLISH_PATH) return handleFacebookPublish(request, env);

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
      '/open-play-data.js',
      '/open-play-public.js',
      '/open-play.css',
      '/availability-graphic.js',
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
}

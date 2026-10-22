// Cloudflare Worker: serves the app, and passes /api/* and /health on to the backend on Render.
// Why: some mobile networks in India fail to reach *.onrender.com. With this, phones only ever talk to
// the app's own address. Same-origin also means no CORS. Nothing is logged or stored here.
const BACKEND = 'https://focus-app-6fb9.onrender.com'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    // The old workers.dev addresses send everyone to the app's one address, https://thrywe.pages.dev (wrangler.jsonc).
    if (env.FORWARD_TO) return Response.redirect(env.FORWARD_TO + url.pathname + url.search, 301)
    // Each Pages deploy also lives at <hash>.thrywe.pages.dev, which the browser treats as another site with its
    // own storage (signed out). A tab opened there from address-bar history asked to sign in again: send it home.
    if (url.hostname.endsWith('.thrywe.pages.dev')) return Response.redirect('https://thrywe.pages.dev' + url.pathname + url.search, 301)
    if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
      const headers = new Headers(request.headers)
      headers.delete('cookie')
      const ip = request.headers.get('CF-Connecting-IP')
      if (ip) headers.set('X-Forwarded-For', ip) // the sign-in rate limit keys on the real visitor
      return fetch(BACKEND + url.pathname + url.search, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'manual',
      })
    }
    return env.ASSETS.fetch(request)
  },
  // Cron (wrangler.jsonc): keep the backend awake so no one meets the sleeping-server wait.
  async scheduled(_event, _env, ctx) {
    ctx.waitUntil(fetch(BACKEND + '/health').catch(() => undefined))
  },
}

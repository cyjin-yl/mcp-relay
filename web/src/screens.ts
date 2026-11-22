import { setCsrfToken, type Me } from './api'
import { el, onProtoClick, protoButton } from './ui'

export function brand(subtitle = '控制台'): HTMLElement {
  return el(
    'div',
    { class: 'brand' },
    el('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'm'),
    el(
      'span',
      { class: 'brand-title' },
      el('strong', {}, 'mcp-relay'),
      el('span', {}, subtitle),
    ),
  )
}

function featureCard(index: string, title: string, body: string): HTMLElement {
  return el(
    'article',
    { class: 'intro-feature' },
    el('span', { class: 'intro-number' }, index),
    el('h3', {}, title),
    el('p', { class: 'muted' }, body),
  )
}

function stepCard(index: string, title: string, body: string): HTMLElement {
  return el(
    'li',
    { class: 'intro-step' },
    el('span', { class: 'intro-step-num' }, index),
    el('div', {}, el('h3', {}, title), el('p', { class: 'muted' }, body)),
  )
}

export function renderIntro(host: HTMLElement): void {
  setCsrfToken('')
  document.title = 'mcp-relay · 让 ChatGPT 和 Claude 使用你的设备'

  const login = protoButton('使用 GitHub 登录', { size: 'lg' })
  onProtoClick(login, () => {
    window.location.assign('/login?return_to=/app/')
  })

  const steps = protoButton('查看连接步骤', { variant: 'outline', size: 'lg' })
  onProtoClick(steps, () => {
    document.querySelector('#connect')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })

  const topbar = el(
    'header',
    { class: 'intro-topbar' },
    brand('设备连接'),
    el('a', { class: 'intro-login-link', href: '/login?return_to=/app/' }, '登录'),
  )

  const hero = el(
    'section',
    { class: 'intro-hero' },
    el('span', { class: 'badge badge-online intro-kicker' }, 'ChatGPT / Claude · MCP'),
    el('h1', {}, '让你的 AI 直接使用', el('br'), el('em', {}, '你自己的机器')),
    el(
      'p',
      { class: 'intro-lead' },
      '在要暴露工具的机器上运行一个 npx 进程。ChatGPT 和 Claude 通过 OAuth 连接 relay，调用 read、edit、apply_patch、bash、grep、ast-grep。文件和命令只在本机执行。',
    ),
    el('div', { class: 'intro-actions' }, login, steps),
    el(
      'p',
      { class: 'intro-endpoint' },
      'MCP endpoint ',
      el('code', { class: 'inline-code' }, 'https://relay.cyjin.dev/mcp'),
    ),
  )

  const features = el(
    'section',
    { class: 'intro-grid' },
    featureCard('01', '在设备上执行', 'relay 只转发工具调用和审计摘要；文件内容、命令输出不经过 OVH。'),
    featureCard('02', '细粒度 OAuth scope', 'relay.read 只允许 devices_list 和只读工具；写文件、改文件、bash 需要 relay.write。'),
    featureCard('03', '多设备、多客户端', '同一个账号可以连接多台设备；ChatGPT 和 Claude 共享在线设备列表，按用户隔离。'),
  )

  const connect = el(
    'section',
    { class: 'intro-steps card', id: 'connect' },
    el('span', { class: 'intro-kicker muted' }, '三步接入'),
    el('h2', {}, '从登录到第一次工具调用'),
    el(
      'ol',
      { class: 'intro-step-list' },
      stepCard('1', 'GitHub 登录并生成配对码', '在控制台点击生成一次性配对码；邀请制账号先激活。'),
      stepCard('2', '在设备上运行 npx', 'npx -y @cyjin/mcp-relay@0.1.1 connect --code XXXX-XXXX --root ~/code'),
      stepCard('3', '在 ChatGPT / Claude 添加 MCP', 'Plugins → Add custom MCP server，URL 填 https://relay.cyjin.dev/mcp，认证选 OAuth；Claude 在 Connectors 里添加。'),
    ),
    el(
      'p',
      { class: 'muted intro-note' },
      '设备在线后，工具名是 d_<slug>__<tool>。先让模型调用 devices_list，再使用具体设备前缀的工具。',
    ),
  )

  const packs = el(
    'section',
    { class: 'intro-packs' },
    el('span', { class: 'intro-kicker muted' }, '工具包'),
    el('div', { class: 'packs' }, el('span', { class: 'pack' }, 'minimal'), el('span', { class: 'pack' }, 'omp'), el('span', { class: 'pack badge-muted' }, 'kernel · 可选')),
    el(
      'p',
      { class: 'muted' },
      'minimal：read / write / edit / bash / grep / find / ls。omp：omp_read / omp_hash / omp_apply_patch（base SHA-256 校验）/ omp_glob / omp_grep / omp_ast_grep。',
    ),
  )

  const footer = el(
    'footer',
    { class: 'intro-footer' },
    el('span', { class: 'muted' }, '自托管 · Go relay + SQLite · Cloudflare + Caddy'),
    el('a', { href: '/app/' }, '控制台'),
  )

  host.replaceChildren(el('main', { class: 'intro' }, topbar, hero, features, connect, packs, footer))
}

export function renderPending(host: HTMLElement, me: Me): void {
  document.title = '账号待激活 · mcp-relay'
  const card = el(
    'section',
    { class: 'card auth-card' },
    brand(),
    el('h1', {}, '账号待激活'),
    el('p', { class: 'muted' }, `当前 GitHub 账号：${me.login}`),
    el('p', {}, 'mcp-relay 目前是邀请制，请先输入邀请码激活账号。'),
    el('a', { class: 'login-link', href: '/welcome' }, '输入邀请码激活'),
  )
  host.replaceChildren(el('div', { class: 'auth-shell' }, card))
}

export function renderFatal(host: HTMLElement, error: unknown): void {
  document.title = '加载失败 · mcp-relay'
  const message = error instanceof Error ? error.message : String(error)
  const card = el(
    'section',
    { class: 'card auth-card' },
    brand(),
    el('h1', {}, '加载失败'),
    el('p', { class: 'muted' }, message),
    el('a', { class: 'login-link', href: '/app/' }, '重新加载'),
  )
  host.replaceChildren(el('div', { class: 'auth-shell' }, card))
}

export const renderLogin = renderIntro

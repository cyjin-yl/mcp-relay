import { setCsrfToken, type Me } from './api'
import { el } from './ui'

export function brand(): HTMLElement {
  return el(
    'div',
    { class: 'brand' },
    el('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'm'),
    el(
      'span',
      { class: 'brand-title' },
      el('strong', {}, 'mcp-relay'),
      el('span', {}, '控制台'),
    ),
  )
}

export function renderLogin(host: HTMLElement): void {
  setCsrfToken('')
  document.title = '登录 · mcp-relay'
  const card = el(
    'section',
    { class: 'card auth-card' },
    brand(),
    el('h1', {}, '需要登录'),
    el('p', { class: 'muted' }, '使用 GitHub 账号登录后即可管理设备。'),
    el(
      'a',
      { class: 'login-link', href: '/login?return_to=/app/' },
      '使用 GitHub 登录',
    ),
  )
  host.replaceChildren(el('div', { class: 'auth-shell' }, card))
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

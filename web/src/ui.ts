import { setElementProps } from '@proto.ui/adapter-web-component'

export type ProtoElement = HTMLElement & {
  getExposes?: () => Record<string, unknown>
}

export type Child = Node | string | number | null | undefined | false
export type Attrs = Record<string, string | number | boolean | null | undefined>

const protoProps = new WeakMap<HTMLElement, Record<string, unknown>>()

function applyAttrs(node: HTMLElement, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') {
      node.className = String(value)
      continue
    }
    node.setAttribute(key, value === true ? '' : String(value))
  }
}

export function el(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag)
  applyAttrs(node, attrs)
  appendChildren(node, children)
  return node
}

export function proto(
  tag: string,
  props: Record<string, unknown> = {},
  attrs: Attrs = {},
  ...children: Child[]
): ProtoElement {
  const node = document.createElement(tag) as ProtoElement
  applyAttrs(node, attrs)
  appendChildren(node, children)
  setProtoProps(node, props)
  return node
}

export function setProtoProps(node: HTMLElement, patch: Record<string, unknown>): void {
  const next = { ...(protoProps.get(node) ?? {}), ...patch }
  protoProps.set(node, next)
  setElementProps(node, next)
}

export function protoButton(
  label: string,
  props: Record<string, unknown> = {},
  attrs: Attrs = {},
): ProtoElement {
  return proto(
    'proto-ui-shadcn-button',
    { variant: 'default', size: 'default', ...props },
    attrs,
    label,
  )
}

function appendChildren(node: HTMLElement, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child)
  }
}

export function onProtoClick(node: HTMLElement, handler: () => void): void {
  node.addEventListener('click', (event) => {
    if (event instanceof CustomEvent && event.target === node) handler()
  })
}

export function closeDialog(node: HTMLElement): void {
  const exposes = readProtoExposes(node)
  const close = exposes?.['close']
  if (typeof close === 'function') {
    close()
  }
}

function readProtoExposes(node: HTMLElement): Record<string, unknown> | null {
  const getExposes: unknown = Reflect.get(node, 'getExposes')
  if (typeof getExposes !== 'function') return null
  const exposes: unknown = getExposes.call(node)
  if (typeof exposes !== 'object' || exposes === null) return null
  return exposes as Record<string, unknown>
}

export async function withBusy(node: HTMLElement, task: () => Promise<void>): Promise<void> {
  if (node.dataset['busy'] === '1') return
  node.dataset['busy'] = '1'
  setProtoProps(node, { disabled: true })
  try {
    await task()
  } finally {
    node.dataset['busy'] = ''
    if (node.isConnected) setProtoProps(node, { disabled: false })
  }
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text)
    return
  }

  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  const copied = document.execCommand('copy')
  area.remove()
  if (!copied) throw new Error('复制失败')
}

export function formatDateTime(unixSeconds: number): string {
  if (!unixSeconds) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(unixSeconds * 1000))
}

export function formatRelative(unixSeconds: number): string {
  if (!unixSeconds) return '从未在线'
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds)
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

export interface Me {
  login: string
  isAdmin: boolean
  status: string
  csrfToken: string
}

export interface Device {
  id: string
  slug: string
  name: string
  platform: string
  arch: string
  packs: string[]
  online: boolean
  lastSeen: number
  revoked: boolean
}

export interface PairingCode {
  code: string
  display: string
  expiresAt: number
}

export interface AuditEntry {
  tool: string
  deviceId: string
  status: string
  errorCode: string
  durationMs: number
  createdAt: number
}

export interface Invite {
  code: string
  display: string
  expiresAt: number
}

export type ShareStatus = 'pending' | 'active' | 'expired' | 'revoked'

export interface DeviceShare {
  id: string
  label: string
  devices: Pick<Device, 'id' | 'slug' | 'name'>[]
  scopes: string[]
  createdAt: number
  expiresAt: number
  claimedAt: number
  revokedAt: number
  status: ShareStatus
}

export interface CreateShareInput {
  label: string
  deviceIds: string[]
  permission: 'read' | 'write'
  ttlSeconds: number
}

export interface CreatedShare {
  share: DeviceShare
  claimUrl: string
}

export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

export class UnauthorizedError extends HttpError {
  constructor() {
    super(401, 'unauthorized')
    this.name = 'UnauthorizedError'
  }
}

let csrfToken = ''

export function setCsrfToken(value: string | null | undefined): void {
  csrfToken = value ?? ''
}

function errorMessage(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  if (!('error' in value)) return null
  const error = value.error
  return typeof error === 'string' && error.length > 0 ? error : null
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (method !== 'GET' && method !== 'HEAD' && csrfToken.length > 0) {
    headers.set('X-CSRF-Token', csrfToken)
  }

  const response = await fetch(path, {
    ...init,
    method,
    headers,
    credentials: 'include',
  })

  if (response.status === 401) {
    throw new UnauthorizedError()
  }

  const text = await response.text()
  let body: unknown = null
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown
    } catch {
      body = null
    }
  }

  if (!response.ok) {
    throw new HttpError(response.status, errorMessage(body) ?? `HTTP ${response.status}`)
  }

  return body as T
}

export function fetchMe(): Promise<Me> {
  return request<Me>('/api/me')
}

export async function fetchDevices(): Promise<Device[]> {
  const data = await request<{ devices?: Device[] }>('/api/devices')
  const devices = Array.isArray(data.devices) ? data.devices : []
  return devices.map((device) => ({
    ...device,
    platform: device.platform ?? '',
    arch: device.arch ?? '',
    packs: Array.isArray(device.packs) ? device.packs : [],
    lastSeen: typeof device.lastSeen === 'number' ? device.lastSeen : 0,
  }))
}

export function createPairingCode(): Promise<PairingCode> {
  return request<PairingCode>('/api/pairing-code', { method: 'POST' })
}

export function revokeDevice(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/devices/${encodeURIComponent(id)}/revoke`, { method: 'POST' })
}

export async function fetchAudit(): Promise<AuditEntry[]> {
  const data = await request<{ entries?: AuditEntry[] }>('/api/audit')
  const entries = Array.isArray(data.entries) ? data.entries : []
  return entries.map((entry) => ({
    ...entry,
    tool: entry.tool ?? '',
    deviceId: entry.deviceId ?? '',
    status: entry.status ?? '',
    errorCode: entry.errorCode ?? '',
    durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : 0,
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
  }))
}

export function createInvite(): Promise<Invite> {
  return request<Invite>('/api/invites', { method: 'POST' })
}

export async function fetchShares(): Promise<DeviceShare[]> {
  const data = await request<{ shares: DeviceShare[] }>('/api/shares', { cache: 'no-store' })
  return data.shares
}

export function createShare(input: CreateShareInput): Promise<CreatedShare> {
  return request<CreatedShare>('/api/shares', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    cache: 'no-store',
  })
}

export function revokeShare(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/shares/${encodeURIComponent(id)}/revoke`, { method: 'POST' })
}

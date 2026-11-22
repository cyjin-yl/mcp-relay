import {
  createInvite,
  createPairingCode,
  fetchAudit,
  fetchDevices,
  HttpError,
  revokeDevice,
  UnauthorizedError,
  type AuditEntry,
  type Device,
  type Invite,
  type Me,
  type PairingCode,
} from './api'
import { brand, renderLogin, renderPending } from './screens'
import {
  closeDialog,
  copyText,
  el,
  formatDateTime,
  formatRelative,
  onProtoClick,
  proto,
  protoButton,
  withBusy,
  type ProtoElement,
} from './ui'

type NoticeKind = 'success' | 'error' | 'info'
type Notice = (message: string, kind?: NoticeKind) => void

function copyButton(label: string, text: string, notify: Notice): ProtoElement {
  const button = protoButton(label, { variant: 'outline', size: 'sm' })
  onProtoClick(button, () => {
    void copyText(text)
      .then(() => notify('已复制到剪贴板。', 'success'))
      .catch((error: unknown) => {
        notify(error instanceof Error ? error.message : '复制失败。', 'error')
      })
  })
  return button
}

function pairingResultView(result: PairingCode, notify: Notice): HTMLElement {
  const display = result.display || result.code
  const command = `npx -y @cyjin/mcp-relay connect --code ${display} --root .`
  return el(
    'div',
    { class: 'result-body' },
    el(
      'div',
      { class: 'secret-row' },
      el(
        'div',
        { class: 'secret-value' },
        el('span', { class: 'field-label' }, '配对码'),
        el('code', { class: 'code-display' }, display),
      ),
      copyButton('复制配对码', display, notify),
    ),
    el('p', { class: 'muted' }, `有效至 ${formatDateTime(result.expiresAt)}，仅可使用一次。`),
    el(
      'div',
      { class: 'command' },
      el('pre', {}, el('code', {}, command)),
      copyButton('复制命令', command, notify),
    ),
    el('p', { class: 'muted' }, '设备连接后，在设备列表中点击“刷新”即可看到在线状态。'),
  )
}

function inviteResultView(result: Invite, notify: Notice): HTMLElement {
  const display = result.display || result.code
  return el(
    'div',
    { class: 'result-body' },
    el(
      'div',
      { class: 'secret-row' },
      el(
        'div',
        { class: 'secret-value' },
        el('span', { class: 'field-label' }, '邀请码'),
        el('code', { class: 'code-display' }, display),
      ),
      copyButton('复制邀请码', display, notify),
    ),
    el('p', { class: 'muted' }, `有效至 ${formatDateTime(result.expiresAt)}，仅可使用一次。`),
    el('p', { class: 'muted' }, '把这个码发给朋友，让对方在 /welcome 页面输入。'),
  )
}

function auditStatusBadge(status: string): HTMLElement {
  if (status === 'ok' || status === 'success') {
    return el('span', { class: 'badge badge-online' }, '成功')
  }
  if (status === 'error' || status === 'failed' || status === 'denied') {
    return el('span', { class: 'badge badge-danger' }, status === 'denied' ? '拒绝' : '失败')
  }
  return el('span', { class: 'badge badge-muted' }, status || '未知')
}

function onboardingStep(index: number, ...content: (Node | string)[]): HTMLElement {
  return el(
    'li',
    { class: 'step' },
    el('span', { class: 'step-number', 'aria-hidden': 'true' }, String(index)),
    el('span', { class: 'step-text' }, ...content),
  )
}

function onboardingCard(): HTMLElement {
  const chatgptSteps = el(
    'ol',
    { class: 'steps' },
    onboardingStep(1, 'ChatGPT → Plugins → Add custom MCP server'),
    onboardingStep(2, 'Name 填写 ', el('code', { class: 'inline-code' }, 'mcp-relay')),
    onboardingStep(
      3,
      'Server URL 填写 ',
      el('code', { class: 'inline-code' }, 'https://relay.cyjin.dev/mcp'),
    ),
    onboardingStep(
      4,
      'Authentication 选择 ',
      el('code', { class: 'inline-code' }, 'OAuth'),
      '（自动发现，无需 API key）',
    ),
    onboardingStep(5, 'Create as plugin，然后安装它'),
    onboardingStep(6, '在对话中 @-mention 这个插件'),
  )

  const claudeSteps = el(
    'ol',
    { class: 'steps' },
    onboardingStep(1, 'Settings → Connectors → Add custom connector'),
    onboardingStep(
      2,
      'URL 填写 ',
      el('code', { class: 'inline-code' }, 'https://relay.cyjin.dev/mcp'),
    ),
    onboardingStep(
      3,
      'Authentication 选择 ',
      el('code', { class: 'inline-code' }, 'OAuth'),
      '（自动发现，无需 API key）',
    ),
  )

  return el(
    'section',
    { class: 'card onboarding-card' },
    el(
      'div',
      { class: 'card-head' },
      el('h2', {}, '如何在 ChatGPT 添加 mcp-relay'),
      el('p', { class: 'muted' }, '添加一次 MCP 连接器，之后在对话里 @ 引用即可。'),
    ),
    el(
      'div',
      { class: 'onboarding-grid' },
      el(
        'div',
        { class: 'onboarding-col' },
        el('h3', { class: 'onboarding-title' }, 'ChatGPT'),
        chatgptSteps,
      ),
      el(
        'div',
        { class: 'onboarding-col' },
        el('h3', { class: 'onboarding-title' }, 'Claude'),
        claudeSteps,
      ),
    ),
    el(
      'p',
      { class: 'onboarding-note muted' },
      'OAuth 同意页会授予 ',
      el('code', { class: 'inline-code' }, 'relay.read'),
      '（只读工具）和 ',
      el('code', { class: 'inline-code' }, 'relay.write'),
      '（文件写入 / shell）。配对设备后，工具会以 ',
      el('code', { class: 'inline-code' }, 'd_<slug>__<tool>'),
      ' 出现在对话中。',
    ),
  )
}

export function mountDashboard(host: HTMLElement, me: Me): void {
  let devices: Device[] = []
  let audit: AuditEntry[] = []
  let showRevoked = false
  let noticeTimer: number | undefined

  const noticeArea = el('div', { class: 'notice-area', 'aria-live': 'polite' })

  function announce(message: string, kind: NoticeKind = 'info'): void {
    if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
    noticeArea.replaceChildren(
      el(
        'div',
        { class: `notice notice-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
        message,
      ),
    )
    noticeTimer = window.setTimeout(() => {
      noticeArea.replaceChildren()
    }, 7000)
  }

  function handleError(error: unknown): void {
    if (error instanceof UnauthorizedError) {
      renderLogin(host)
      return
    }
    if (error instanceof HttpError) {
      if (error.status === 403 && error.message === 'pending') {
        renderPending(host, me)
        return
      }
      announce(friendlyError(error), 'error')
      return
    }
    announce(error instanceof Error ? error.message : '请求失败，请稍后重试。', 'error')
  }

  function friendlyError(error: HttpError): string {
    switch (error.message) {
      case 'csrf':
        return '会话校验失败，请刷新页面后重试。'
      case 'too_many_requests':
        return '请求过于频繁，请稍后再试。'
      case 'not_found':
        return '设备不存在或已经被撤销。'
      case 'admin_required':
        return '需要管理员权限。'
      case 'database_error':
        return '服务器数据库错误。'
      default:
        return error.message
    }
  }

  const pairResult = el('div', { class: 'result' })
  const pairButton = protoButton('生成配对码')
  onProtoClick(pairButton, () => {
    void withBusy(pairButton, async () => {
      try {
        const result = await createPairingCode()
        pairResult.replaceChildren(pairingResultView(result, announce))
        announce('配对码已生成，10 分钟内有效。', 'success')
      } catch (error) {
        handleError(error)
      }
    })
  })

  const pairingCard = el(
    'section',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el('h2', {}, '配对设备'),
      el('p', { class: 'muted' }, '生成一次性配对码，在目标机器上运行 connect 命令。'),
    ),
    el('div', { class: 'card-actions' }, pairButton),
    pairResult,
  )

  const devicesBody = el(
    'tbody',
    {},
    el('tr', {}, el('td', { class: 'empty', colspan: '6' }, '正在加载设备…')),
  )
  const devicesTable = el(
    'table',
    { class: 'data-table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', {}, '设备'),
        el('th', {}, '状态'),
        el('th', {}, '平台'),
        el('th', {}, '工具包'),
        el('th', {}, '最后在线'),
        el('th', {}, '操作'),
      ),
    ),
    devicesBody,
  )

  const refreshDevicesButton = protoButton('刷新', { variant: 'outline', size: 'sm' })
  onProtoClick(refreshDevicesButton, () => {
    void withBusy(refreshDevicesButton, refreshDevices)
  })

  const filterSwitch = proto(
    'proto-ui-shadcn-switch',
    { defaultChecked: false },
    {},
    el('span', { class: 'sr-only' }, '显示已撤销设备'),
  )
  filterSwitch.addEventListener('checkedChange', (event) => {
    if (!(event instanceof CustomEvent)) return
    const detail: unknown = event.detail
    if (typeof detail !== 'object' || detail === null || !('checked' in detail)) return
    showRevoked = detail.checked === true
    renderDeviceRows()
  })

  const devicesCard = el(
    'section',
    { class: 'card devices-card' },
    el(
      'div',
      { class: 'card-toolbar' },
      el(
        'div',
        { class: 'card-head' },
        el('h2', {}, '我的设备'),
        el('p', { class: 'muted' }, '在线设备会出现在 ChatGPT / Claude 的工具列表里。'),
      ),
      el(
        'div',
        { class: 'card-actions' },
        el('div', { class: 'filter' }, filterSwitch, el('span', {}, '显示已撤销')),
        refreshDevicesButton,
      ),
    ),
    el('div', { class: 'table-wrap' }, devicesTable),
  )

  const auditBody = el(
    'tbody',
    {},
    el('tr', {}, el('td', { class: 'empty', colspan: '6' }, '正在加载审计记录…')),
  )
  const auditTable = el(
    'table',
    { class: 'data-table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', {}, '时间'),
        el('th', {}, '工具'),
        el('th', {}, '设备'),
        el('th', {}, '状态'),
        el('th', {}, '耗时'),
        el('th', {}, '错误码'),
      ),
    ),
    auditBody,
  )

  const refreshAuditButton = protoButton('刷新', { variant: 'outline', size: 'sm' })
  onProtoClick(refreshAuditButton, () => {
    void withBusy(refreshAuditButton, refreshAudit)
  })

  const auditCard = el(
    'section',
    { class: 'card' },
    el(
      'div',
      { class: 'card-toolbar' },
      el(
        'div',
        { class: 'card-head' },
        el('h2', {}, '最近审计'),
        el('p', { class: 'muted' }, '最近 100 次工具调用。'),
      ),
      el('div', { class: 'card-actions' }, refreshAuditButton),
    ),
    el('div', { class: 'table-wrap' }, auditTable),
  )

  const inviteResult = el('div', { class: 'result' })
  const inviteButton = protoButton('生成邀请码')
  onProtoClick(inviteButton, () => {
    void withBusy(inviteButton, async () => {
      try {
        const result = await createInvite()
        inviteResult.replaceChildren(inviteResultView(result, announce))
        announce('邀请码已生成，14 天内有效。', 'success')
      } catch (error) {
        handleError(error)
      }
    })
  })
  const invitesCard = el(
    'section',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el('h2', {}, '邀请码'),
      el('p', { class: 'muted' }, '管理员可以生成一次性邀请码，14 天内有效。'),
    ),
    el('div', { class: 'card-actions' }, inviteButton),
    inviteResult,
  )

  const tabsRoot = proto(
    'proto-ui-shadcn-tabs-root',
    { defaultValue: 'devices' },
    { class: 'tabs-root' },
  )
  const tabsList = el('proto-ui-shadcn-tabs-list')
  tabsList.append(
    proto('proto-ui-shadcn-tabs-trigger', { value: 'devices' }, {}, '设备'),
    proto('proto-ui-shadcn-tabs-trigger', { value: 'audit' }, {}, '审计'),
  )
  if (me.isAdmin) {
    tabsList.append(proto('proto-ui-shadcn-tabs-trigger', { value: 'invites' }, {}, '邀请码'))
  }

  const devicesPanel = proto(
    'proto-ui-shadcn-tabs-content',
    { value: 'devices' },
    { class: 'tab-panel' },
    el('div', { class: 'dashboard-grid' }, pairingCard, devicesCard),
  )
  const auditPanel = proto(
    'proto-ui-shadcn-tabs-content',
    { value: 'audit' },
    { class: 'tab-panel' },
    auditCard,
  )
  tabsRoot.append(tabsList, devicesPanel, auditPanel)
  if (me.isAdmin) {
    tabsRoot.append(
      proto('proto-ui-shadcn-tabs-content', { value: 'invites' }, { class: 'tab-panel' }, invitesCard),
    )
  }

  const topbar = el(
    'header',
    { class: 'topbar' },
    brand(),
    el(
      'div',
      { class: 'user' },
      el('span', { class: 'user-login' }, me.login),
      me.isAdmin ? el('span', { class: 'badge badge-muted' }, '管理员') : null,
    ),
  )

  host.replaceChildren(
    el(
      'div',
      { class: 'app-shell' },
      topbar,
      el('main', { class: 'container' }, noticeArea, onboardingCard(), tabsRoot),
    ),
  )
  document.title = '设备 · mcp-relay'

  void Promise.all([refreshDevices(), refreshAudit()])

  function revokeDialog(device: Device): HTMLElement {
    const dialog = el('proto-ui-shadcn-dialog-root', { class: 'dialog-inline' })
    const trigger = el('proto-ui-shadcn-dialog-trigger')
    trigger.append(protoButton('撤销', { variant: 'outline', size: 'sm' }))

    const cancel = protoButton('取消', { variant: 'outline', size: 'sm' })
    const confirm = protoButton('确认撤销', { variant: 'destructive', size: 'sm' })
    const content = el(
      'proto-ui-shadcn-dialog-content',
      {},
      el(
        'proto-ui-shadcn-dialog-header',
        {},
        el('proto-ui-shadcn-dialog-title', {}, '撤销设备'),
        el(
          'proto-ui-shadcn-dialog-description',
          {},
          `确定撤销 ${device.name}？撤销后该设备会立即断开，需要重新配对才能使用。`,
        ),
      ),
      el('proto-ui-shadcn-dialog-footer', {}, cancel, confirm),
    )
    dialog.append(trigger, el('proto-ui-shadcn-dialog-mask'), content)

    onProtoClick(cancel, () => closeDialog(dialog))
    onProtoClick(confirm, () => {
      void withBusy(confirm, async () => {
        try {
          await revokeDevice(device.id)
          closeDialog(dialog)
          announce(`已撤销 ${device.name}。`, 'success')
          await Promise.all([refreshDevices(), refreshAudit()])
        } catch (error) {
          handleError(error)
        }
      })
    })
    return dialog
  }

  function deviceRow(device: Device): HTMLElement {
    const status = device.revoked
      ? el('span', { class: 'badge badge-danger' }, '已撤销')
      : device.online
        ? el(
            'span',
            { class: 'badge badge-online' },
            el('span', { class: 'dot', 'aria-hidden': 'true' }),
            '在线',
          )
        : el('span', { class: 'badge badge-muted' }, '离线')

    const packs =
      device.packs.length > 0
        ? el(
            'div',
            { class: 'packs' },
            ...device.packs.map((pack) => el('code', { class: 'pack' }, pack)),
          )
        : el('span', { class: 'muted' }, '—')

    const platform = [device.platform, device.arch].filter((part) => part.length > 0).join(' ')

    return el(
      'tr',
      {},
      el(
        'td',
        {},
        el(
          'div',
          { class: 'device-identity' },
          el('span', { class: 'device-name' }, device.name),
          el('code', { class: 'device-slug' }, device.slug),
        ),
      ),
      el('td', {}, status),
      el('td', {}, el('span', { class: 'muted' }, platform || '—')),
      el('td', {}, packs),
      el(
        'td',
        {},
        el(
          'span',
          { class: 'muted', title: formatDateTime(device.lastSeen) },
          formatRelative(device.lastSeen),
        ),
      ),
      el('td', {}, device.revoked ? el('span', { class: 'muted' }, '—') : revokeDialog(device)),
    )
  }

  function renderDeviceRows(): void {
    const visible = showRevoked ? devices : devices.filter((device) => !device.revoked)
    if (visible.length === 0) {
      const message =
        devices.length === 0
          ? '还没有设备，先生成一个配对码。'
          : showRevoked
            ? '没有被撤销的设备。'
            : '没有可用设备；打开“显示已撤销”查看已撤销设备。'
      devicesBody.replaceChildren(el('tr', {}, el('td', { class: 'empty', colspan: '6' }, message)))
      return
    }
    devicesBody.replaceChildren(...visible.map(deviceRow))
  }

  function auditRow(entry: AuditEntry): HTMLElement {
    return el(
      'tr',
      {},
      el(
        'td',
        {},
        el(
          'span',
          { class: 'muted', title: formatDateTime(entry.createdAt) },
          formatDateTime(entry.createdAt),
        ),
      ),
      el('td', {}, el('code', {}, entry.tool)),
      el(
        'td',
        {},
        entry.deviceId.length > 0
          ? el('code', { class: 'device-slug' }, entry.deviceId)
          : el('span', { class: 'muted' }, '—'),
      ),
      el('td', {}, auditStatusBadge(entry.status)),
      el('td', {}, `${entry.durationMs} ms`),
      el(
        'td',
        {},
        entry.errorCode.length > 0
          ? el('code', { class: 'error-code' }, entry.errorCode)
          : el('span', { class: 'muted' }, '—'),
      ),
    )
  }

  function renderAuditRows(): void {
    if (audit.length === 0) {
      auditBody.replaceChildren(
        el('tr', {}, el('td', { class: 'empty', colspan: '6' }, '还没有审计记录。')),
      )
      return
    }
    auditBody.replaceChildren(...audit.map(auditRow))
  }

  async function refreshDevices(): Promise<void> {
    try {
      devices = await fetchDevices()
      renderDeviceRows()
    } catch (error) {
      handleError(error)
    }
  }

  async function refreshAudit(): Promise<void> {
    try {
      audit = await fetchAudit()
      renderAuditRows()
    } catch (error) {
      handleError(error)
    }
  }
}

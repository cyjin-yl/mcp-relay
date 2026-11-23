import {
  createShare,
  fetchShares,
  HttpError,
  revokeShare,
  UnauthorizedError,
  type CreatedShare,
  type Device,
  type DeviceShare,
  type ShareStatus,
} from './api'
import { closeDialog, copyText, el, onProtoClick, protoButton, setProtoProps, withBusy, type ProtoElement } from './ui'

interface ShareManagerOptions {
  announce: (message: string, kind?: 'success' | 'error' | 'info') => void
  onError: (error: unknown) => void
  refreshDevices: () => Promise<void>
  onChange: () => void
}

interface ShareRow {
  share: DeviceShare
  badge: HTMLElement
  remaining: HTMLElement
  revokeButton: ProtoElement | null
  status: ShareStatus
}

const absoluteTime = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false, timeZoneName: 'shortOffset',
})

function shareTime(unix: number): string {
  return absoluteTime.format(new Date(unix * 1000))
}

function currentStatus(share: DeviceShare): ShareStatus {
  if (share.revokedAt || share.status === 'revoked') return 'revoked'
  if (share.expiresAt * 1000 <= Date.now() || share.status === 'expired') return 'expired'
  return share.claimedAt || share.status === 'active' ? 'active' : 'pending'
}

function setStatus(badge: HTMLElement, status: ShareStatus): void {
  const states = {
    pending: ['待领取', 'badge-muted'],
    active: ['已领取', 'badge-online'],
    expired: ['已到期', 'badge-muted'],
    revoked: ['已撤销', 'badge-danger'],
  } as const
  badge.className = `badge ${states[status][1]}`
  badge.textContent = states[status][0]
}

function remainingTime(share: DeviceShare): string {
  if (currentStatus(share) === 'revoked') return '此分享的访问权限已终止'
  const seconds = Math.max(0, Math.ceil(share.expiresAt - Date.now() / 1000))
  if (seconds === 0 || currentStatus(share) === 'expired') return '访问权限已到期'
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `剩余 ${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
  if (hours > 0) return `剩余 ${hours} 小时 ${minutes % 60} 分钟`
  if (minutes > 0) return `剩余 ${minutes} 分 ${seconds % 60} 秒`
  return `剩余 ${seconds} 秒`
}

function shareError(error: unknown): string {
  if (!(error instanceof HttpError)) return error instanceof Error ? error.message : '请求失败，请稍后重试。'
  switch (error.message) {
    case 'invalid_label': return '名称最多 80 个字符，请去掉不可见的控制字符。'
    case 'invalid_devices': return '请选择 1 至 32 台可用设备；部分设备可能已被撤销，请刷新设备列表。'
    case 'invalid_permission': return '请选择操作设备或只读工具权限。'
    case 'invalid_expiry': return '有效期应为 5 分钟至 7 天，请输入整数分钟。'
    case 'share_limit': return '有效分享已达 100 个，请先撤销不再需要的分享。'
    case 'invalid_request': return '分享设置无效，请刷新页面后重试。'
    case 'csrf': return '会话校验失败，请刷新页面后重试。'
    case 'not_found': return '分享不存在或不属于当前账号，请刷新列表。'
    case 'too_many_requests': return '请求过于频繁，请稍后再试。'
    case 'database_error': return '服务器暂时无法保存分享，请稍后重试。'
    default: return `请求失败（${error.status}），请稍后重试。`
  }
}

function labelledField(label: string, id: string, input: HTMLElement, ...extra: HTMLElement[]): HTMLElement {
  return el('div', { class: 'share-field' }, el('label', { for: id }, label), input, ...extra)
}

export function createShareManager(options: ShareManagerOptions): {
  element: HTMLElement
  setDevices: (devices: Device[]) => void
  setDevicesError: () => void
  refresh: () => Promise<void>
} {
  let availableDevices: Device[] = []
  let devicesLoaded = false
  let shares: DeviceShare[] = []
  let sharesLoaded = false
  let busy = false
  let mutationRevision = 0
  let refreshTask: Promise<void> | null = null
  let lastRefresh = Date.now()
  const selected = new Set<string>()
  const deviceInputs = new Map<string, HTMLInputElement>()
  const createdResults = new Map<string, { share: DeviceShare; node: HTMLElement }>()
  let rows: ShareRow[] = []

  const deviceChoices = el('div', { class: 'share-device-options', 'aria-describedby': 'share-devices-help' },
    el('p', { class: 'muted' }, '正在加载设备…'))
  const selectionCount = el('span', { class: 'muted', 'aria-live': 'polite' }, '请选择设备')
  const formError = el('p', { id: 'share-form-error', class: 'notice notice-error', role: 'alert', hidden: true })
  const listError = el('p', { class: 'notice notice-error', role: 'alert', hidden: true })
  const createdArea = el('div', { class: 'share-created' })
  const selectedAllButton = protoButton('全选', { variant: 'ghost', size: 'sm' })
  const clearButton = protoButton('清空', { variant: 'ghost', size: 'sm' })
  const refreshDevicesButton = protoButton('刷新设备', { variant: 'outline', size: 'sm' })

  const labelInput = el('input', {
    id: 'share-label', name: 'label', type: 'text', class: 'share-input',
    maxlength: 160, placeholder: '例如：帮我排查笔电问题', autocomplete: 'off',
    'aria-describedby': 'share-label-help share-form-error',
  }) as HTMLInputElement
  const permissionInput = el('select', {
    id: 'share-permission', name: 'permission', class: 'share-input',
    'aria-describedby': 'share-permission-help',
  },
  el('option', { value: 'write' }, '操作设备（含文件写入与 shell）'),
  el('option', { value: 'read' }, '只读工具')) as HTMLSelectElement
  const permissionHelp = el('p', { id: 'share-permission-help', class: 'muted' },
    '按设备进程已有的系统权限执行，可使用所选设备已启用的操作工具。')
  const durationInput = el('select', { id: 'share-duration', name: 'duration', class: 'share-input' },
    el('option', { value: '900' }, '15 分钟'),
    el('option', { value: '3600' }, '1 小时'),
    el('option', { value: '14400' }, '4 小时'),
    el('option', { value: '86400' }, '24 小时'),
    el('option', { value: 'custom' }, '自定义时长')) as HTMLSelectElement
  durationInput.value = '3600'
  const customMinutes = el('input', {
    id: 'share-custom-minutes', name: 'customMinutes', type: 'number', class: 'share-input',
    min: 5, max: 10080, step: 1, value: 60, inputmode: 'numeric', disabled: true,
    'aria-describedby': 'share-duration-help share-form-error',
  }) as HTMLInputElement
  const customField = labelledField('时长（分钟）', 'share-custom-minutes', customMinutes)
  customField.hidden = true
  const expiryPreview = el('p', { id: 'share-duration-help', class: 'muted share-expiry-preview' })
  const createButton = protoButton('生成分享链接', {}, { 'data-action': 'create-share' })

  const fields = el('fieldset', { class: 'share-form-fields' },
    el('legend', { class: 'sr-only' }, '临时分享设置'),
    el('div', { class: 'share-form-grid' },
      el('fieldset', { class: 'share-device-picker' },
        el('legend', {}, '分享哪些设备'),
        el('p', { id: 'share-devices-help', class: 'muted' }, '选择 1 至 32 台设备。离线设备也可选择，重新上线后即可使用。'),
        el('div', { class: 'share-selection-toolbar' },
          selectionCount,
          el('div', { class: 'card-actions' }, selectedAllButton, clearButton, refreshDevicesButton)),
        deviceChoices),
      el('div', { class: 'share-settings' },
        labelledField('名称（可选）', 'share-label', labelInput,
          el('p', { id: 'share-label-help', class: 'muted' }, '最多 80 个字符，便于之后找到并撤销。')),
        labelledField('允许做什么', 'share-permission', permissionInput, permissionHelp),
        labelledField('有效期', 'share-duration', durationInput),
        customField,
        expiryPreview))) as HTMLFieldSetElement
  const form = el('form', { class: 'share-form', novalidate: true }, fields,
    formError,
    el('div', { class: 'share-form-footer' },
      el('p', { class: 'muted' }, '链接只可领取一次。领取后获得 MCP token 和连接文件；到期自动失效，也可随时撤销。'),
      createButton)) as HTMLFormElement

  const tableBody = el('tbody', {},
    el('tr', {}, el('td', { colspan: 6, class: 'empty' }, '正在加载分享记录…')))
  const refreshButton = protoButton('刷新', { variant: 'outline', size: 'sm' }, { 'aria-label': '刷新分享记录' })
  const table = el('table', { class: 'data-table share-table' },
    el('caption', { class: 'sr-only' }, '临时设备访问分享及其有效期'),
    el('thead', {}, el('tr', {},
      ...['分享', '设备', '权限', '状态', '有效至', '操作'].map((text) => el('th', { scope: 'col' }, text)))),
    tableBody)
  const listCard = el('section', { class: 'card share-list-card', 'aria-labelledby': 'share-list-title' },
    el('div', { class: 'card-toolbar' },
      el('div', { class: 'card-head' },
        el('h2', { id: 'share-list-title' }, '分享记录'),
        el('p', { class: 'muted' }, '撤销会终止此分享的后续访问，设备本身保持连接。')),
      refreshButton),
    listError,
    el('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': '分享记录，可横向滚动' }, table))
  const element = el('div', { class: 'share-manager' },
    el('section', { class: 'card', 'aria-labelledby': 'share-create-title' },
      el('div', { class: 'card-head' },
        el('h2', { id: 'share-create-title' }, '临时分享访问'),
        el('p', { class: 'muted' }, '把选定设备临时交给另一个 agent，帮你排查或完成任务。')),
      form, createdArea),
    listCard)

  function clearFormError(): void {
    formError.hidden = true
    formError.textContent = ''
    labelInput.removeAttribute('aria-invalid')
    customMinutes.removeAttribute('aria-invalid')
    deviceChoices.removeAttribute('aria-invalid')
  }

  function reportError(error: unknown, area: HTMLElement): void {
    if (error instanceof UnauthorizedError || (error instanceof HttpError && error.status === 403 && error.message === 'pending')) {
      options.onError(error)
      return
    }
    area.textContent = shareError(error)
    area.hidden = false
  }

  function ttlSeconds(): number {
    return durationInput.value === 'custom' ? Number(customMinutes.value) * 60 : Number(durationInput.value)
  }

  function updateExpiryPreview(): void {
    const seconds = ttlSeconds()
    expiryPreview.textContent = Number.isInteger(seconds / 60) && seconds >= 300 && seconds <= 604800
      ? `从创建时开始计时；如现在创建，约至 ${shareTime(Math.floor(Date.now() / 1000) + seconds)}。领取不会延长有效期。`
      : '从创建时开始计时，有效期可设为 5 分钟至 7 天。'
  }

  function updateSelection(): void {
    selectionCount.textContent = devicesLoaded ? `已选 ${selected.size} / ${availableDevices.length} 台` : '设备尚未加载'
    for (const [id, input] of deviceInputs) {
      input.checked = selected.has(id)
      input.disabled = busy || (!input.checked && selected.size >= 32)
    }
    setProtoProps(createButton, { disabled: busy || !devicesLoaded || availableDevices.length === 0 })
    setProtoProps(selectedAllButton, { disabled: busy || !devicesLoaded || availableDevices.length === 0 || availableDevices.length > 32 })
    setProtoProps(clearButton, { disabled: busy || selected.size === 0 })
    setProtoProps(refreshDevicesButton, { disabled: busy })
  }

  function setDevices(devices: Device[]): void {
    const focusedID = document.activeElement instanceof HTMLInputElement ? document.activeElement.dataset['deviceId'] : undefined
    availableDevices = devices.filter((device) => !device.revoked)
    devicesLoaded = true
    const availableIDs = new Set(availableDevices.map((device) => device.id))
    for (const id of selected) if (!availableIDs.has(id)) selected.delete(id)
    deviceInputs.clear()
    if (availableDevices.length === 0) {
      deviceChoices.replaceChildren(el('p', { class: 'share-device-empty muted' }, '还没有可分享的设备。请先在“设备”页连接设备。'))
    } else {
      deviceChoices.replaceChildren(...availableDevices.map((device) => {
        const input = el('input', {
          type: 'checkbox', name: 'devices', value: device.id,
          'data-device-id': device.id, 'aria-describedby': 'share-devices-help share-form-error',
        }) as HTMLInputElement
        deviceInputs.set(device.id, input)
        input.addEventListener('change', () => {
          if (input.checked && selected.size < 32) selected.add(device.id)
          else selected.delete(device.id)
          clearFormError()
          updateSelection()
        })
        return el('label', { class: 'share-device-option' }, input,
          el('span', { class: 'share-device-copy' },
            el('span', { class: 'device-name' }, device.name),
            el('code', { class: 'device-slug' }, device.slug),
            el('span', { class: 'muted' }, [device.platform, device.arch].filter(Boolean).join(' '))),
          el('span', { class: `badge ${device.online ? 'badge-online' : 'badge-muted'}` }, device.online ? '在线' : '离线'))
      }))
    }
    updateSelection()
    if (focusedID) deviceInputs.get(focusedID)?.focus()
  }

  function setDevicesError(): void {
    if (!devicesLoaded) {
      deviceChoices.replaceChildren(el('p', { class: 'muted' }, '设备加载失败，请点击“刷新设备”重试。'))
      updateSelection()
    }
  }

  function forgetResult(id: string): void {
    const entry = createdResults.get(id)
    if (!entry) return
    for (const input of entry.node.querySelectorAll('textarea')) input.value = ''
    entry.node.remove()
    createdResults.delete(id)
  }

  function copyButton(label: string, text: string): ProtoElement {
    const button = protoButton(label, { variant: 'outline', size: 'sm' })
    onProtoClick(button, () => {
      void copyText(text).then(() => options.announce('已复制到剪贴板。', 'success')).catch((error: unknown) => options.announce(shareError(error), 'error'))
    })
    return button
  }

  function showCreated(result: CreatedShare): void {
    const heading = el('h3', { tabindex: -1 }, `${result.share.label} · 分享链接已生成`)
    const urlInput = el('textarea', {
      class: 'share-link', rows: 2, readonly: true, spellcheck: false,
      'aria-label': '一次性领取链接', autocomplete: 'off',
    }) as HTMLTextAreaElement
    urlInput.value = result.claimUrl
    urlInput.addEventListener('focus', () => urlInput.select())
    const instruction = [
      '请通过以下链接领取临时设备访问权限，并按领取结果中的 Markdown 连接说明使用 MCP：',
      result.claimUrl,
      '',
      `授权设备：${result.share.devices.map((device) => `${device.name} (${device.slug})`).join('、')}`,
      `权限：${result.share.scopes.includes('relay.write') ? '操作设备（含文件写入与 shell）' : '只读工具'}`,
      `有效至：${new Date(result.share.expiresAt * 1000).toISOString()}（UTC）。领取不会延长有效期，所有者可提前撤销。`,
      '链接仅可领取一次。普通 GET 或预览不会领取；请从原始完整链接的 #claim= 后读取领取凭据，再按页面说明显式 POST 领取。',
      '领取响应包含 MCP Bearer token、设备范围、有效期及完整连接文件。请保存该文件，不要再次领取或把凭据转发给其他人。',
    ].join('\n')
    const dismiss = protoButton('收起链接', { variant: 'ghost', size: 'sm' })
    onProtoClick(dismiss, () => forgetResult(result.share.id))
    const node = el('section', { class: 'share-created-result', 'data-share-id': result.share.id },
      heading,
      el('p', { class: 'muted' }, `有效至 ${shareTime(result.share.expiresAt)}。链接只在本页显示，刷新页面后无法找回。`),
      urlInput,
      el('div', { class: 'card-actions' }, copyButton('复制链接', result.claimUrl), copyButton('复制给 agent 的说明', instruction), dismiss),
      el('p', { class: 'muted' }, '接收方明确领取后，获得一次性交付的 token 和 Markdown 连接文件；token 可在剩余有效期内反复使用。'))
    createdResults.set(result.share.id, { share: result.share, node })
    createdArea.prepend(node)
    heading.focus()
  }

  async function submitShare(): Promise<void> {
    if (busy) return
    clearFormError()
    const label = labelInput.value.trim()
    const seconds = ttlSeconds()
    let invalidTarget: HTMLElement | undefined
    if (selected.size < 1 || selected.size > 32) {
      formError.textContent = '请至少选择一台设备，最多 32 台。'
      deviceChoices.setAttribute('aria-invalid', 'true')
      invalidTarget = deviceInputs.values().next().value
    } else if ([...label].length > 80 || /\p{Cc}/u.test(label)) {
      formError.textContent = '名称最多 80 个字符，不能包含控制字符。'
      labelInput.setAttribute('aria-invalid', 'true')
      invalidTarget = labelInput
    } else if (!Number.isInteger(seconds / 60) || seconds < 300 || seconds > 604800) {
      formError.textContent = '请输入 5 至 10080 之间的整数分钟（最多 7 天）。'
      customMinutes.setAttribute('aria-invalid', 'true')
      invalidTarget = customMinutes
    }
    if (formError.textContent) {
      formError.hidden = false
      invalidTarget?.focus()
      return
    }
    busy = true
    fields.disabled = true
    createButton.textContent = '正在生成…'
    updateSelection()
    try {
      const result = await createShare({ label, deviceIds: [...selected], permission: permissionInput.value === 'read' ? 'read' : 'write', ttlSeconds: seconds })
      if (!element.isConnected) return
      mutationRevision++
      shares = [result.share, ...shares.filter((share) => share.id !== result.share.id)]
      sharesLoaded = true
      renderRows()
      showCreated(result)
      labelInput.value = ''
      options.announce('分享链接已生成，复制后即可交给接收方。', 'success')
      options.onChange()
    } catch (error) {
      reportError(error, formError)
      if (error instanceof HttpError && error.message === 'invalid_devices') void options.refreshDevices()
    } finally {
      busy = false
      fields.disabled = false
      createButton.textContent = '生成分享链接'
      updateSelection()
    }
  }

  function revokeDialog(share: DeviceShare): { dialog: HTMLElement; button: ProtoElement } {
    const dialog = el('proto-ui-shadcn-dialog-root', { class: 'dialog-inline' })
    const trigger = el('proto-ui-shadcn-dialog-trigger')
    const button = protoButton('撤销', { variant: 'outline', size: 'sm' }, { 'aria-label': `撤销分享 ${share.label}` })
    trigger.append(button)
    const cancel = protoButton('取消', { variant: 'outline', size: 'sm' })
    const confirm = protoButton('撤销此分享', { variant: 'destructive', size: 'sm' })
    const errorArea = el('p', { class: 'notice notice-error', role: 'alert', hidden: true })
    dialog.append(trigger, el('proto-ui-shadcn-dialog-mask'),
      el('proto-ui-shadcn-dialog-content', {},
        el('proto-ui-shadcn-dialog-header', {},
          el('proto-ui-shadcn-dialog-title', {}, '撤销临时访问'),
          el('proto-ui-shadcn-dialog-description', {}, `撤销“${share.label}”后，领取链接和已领取的 token 都会失效。此分享中的 ${share.devices.length} 台设备仍保持原有连接。`)),
        el('p', { class: 'muted' }, '已经完成的文件修改和已脱离运行的进程不会自动回滚。'),
        errorArea,
        el('proto-ui-shadcn-dialog-footer', {}, cancel, confirm)))
    onProtoClick(cancel, () => closeDialog(dialog))
    onProtoClick(confirm, () => {
      void withBusy(confirm, async () => {
        errorArea.hidden = true
        try {
          await revokeShare(share.id)
          mutationRevision++
          closeDialog(dialog)
          forgetResult(share.id)
          share.revokedAt = Math.floor(Date.now() / 1000)
          share.status = 'revoked'
          renderRows()
          options.announce(`已撤销“${share.label}”的临时访问。`, 'success')
          options.onChange()
          await refresh()
        } catch (error) {
          reportError(error, errorArea)
        }
      })
    })
    return { dialog, button }
  }

  function deviceSummary(share: DeviceShare): HTMLElement {
    const list = el('ul', { class: 'share-device-summary' }, ...share.devices.map((device) =>
      el('li', {}, el('span', { class: 'device-name' }, device.name), el('code', { class: 'device-slug', title: device.id }, device.slug))))
    return share.devices.length > 2
      ? el('details', { class: 'share-device-details' }, el('summary', {}, `${share.devices.length} 台设备`), list)
      : list
  }

  function renderRows(): void {
    rows = []
    if (shares.length === 0) {
      tableBody.replaceChildren(el('tr', {}, el('td', { colspan: 6, class: 'empty' },
        sharesLoaded ? '还没有临时分享，选择设备后即可创建。' : '分享记录暂时无法加载，请刷新重试。')))
      return
    }
    tableBody.replaceChildren(...shares.map((share) => {
      const status = currentStatus(share)
      const badge = el('span')
      setStatus(badge, status)
      const remaining = el('span', { class: 'muted' }, remainingTime(share))
      const canRevoke = status === 'pending' || status === 'active'
      const revoke = canRevoke ? revokeDialog(share) : null
      rows.push({ share, badge, remaining, revokeButton: revoke?.button ?? null, status })
      if (status !== 'pending') forgetResult(share.id)
      const statusDate = share.revokedAt ? `撤销于 ${shareTime(share.revokedAt)}`
        : share.claimedAt ? `领取于 ${shareTime(share.claimedAt)}` : '链接尚未领取'
      return el('tr', { 'data-share-id': share.id },
        el('td', {}, el('div', { class: 'share-cell-stack' },
          el('span', { class: 'device-name' }, share.label),
          el('span', { class: 'muted' }, `创建于 ${shareTime(share.createdAt)}`))),
        el('td', {}, deviceSummary(share)),
        el('td', {}, share.scopes.includes('relay.write') ? '操作设备' : '只读工具'),
        el('td', {}, el('div', { class: 'share-cell-stack' }, badge, el('span', { class: 'muted' }, statusDate))),
        el('td', {}, el('div', { class: 'share-cell-stack' },
          el('time', { datetime: new Date(share.expiresAt * 1000).toISOString() }, shareTime(share.expiresAt)), remaining)),
        el('td', {}, revoke ? revoke.dialog : el('span', { class: 'muted' }, '—')))
    }))
  }

  async function refresh(): Promise<void> {
    if (refreshTask) return refreshTask
    refreshTask = (async () => {
      const revision = mutationRevision
      listError.hidden = true
      try {
        const next = await fetchShares()
        if (!element.isConnected) return
        // A GET begun before a mutation must not bring an old share state back.
        if (revision !== mutationRevision) return
        shares = next
        sharesLoaded = true
        renderRows()
      } catch (error) {
        reportError(error, listError)
        if (!sharesLoaded) renderRows()
      } finally {
        lastRefresh = Date.now()
        refreshTask = null
      }
    })()
    return refreshTask
  }

  form.addEventListener('submit', (event) => { event.preventDefault(); void submitShare() })
  onProtoClick(createButton, () => { if (!busy) form.requestSubmit() })
  for (const input of [labelInput, customMinutes]) {
    input.addEventListener('input', () => { clearFormError(); updateExpiryPreview() })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); form.requestSubmit() }
    })
  }
  permissionInput.addEventListener('change', () => {
    permissionHelp.textContent = permissionInput.value === 'read'
      ? '只允许设备的只读工具，不能执行 shell 或写文件。'
      : '按设备进程已有的系统权限执行，可使用所选设备已启用的操作工具。'
  })
  durationInput.addEventListener('change', () => {
    customField.hidden = durationInput.value !== 'custom'
    customMinutes.disabled = customField.hidden
    clearFormError()
    updateExpiryPreview()
    if (!customField.hidden) customMinutes.focus()
  })
  onProtoClick(selectedAllButton, () => {
    if (busy || availableDevices.length > 32) return
    for (const device of availableDevices) selected.add(device.id)
    clearFormError()
    updateSelection()
  })
  onProtoClick(clearButton, () => {
    if (busy) return
    selected.clear()
    clearFormError()
    updateSelection()
  })
  onProtoClick(refreshDevicesButton, () => { void withBusy(refreshDevicesButton, options.refreshDevices) })
  onProtoClick(refreshButton, () => { void withBusy(refreshButton, refresh) })

  function tick(): void {
    if (!element.isConnected) {
      for (const id of createdResults.keys()) forgetResult(id)
      return
    }
    updateExpiryPreview()
    for (const row of rows) {
      const status = currentStatus(row.share)
      row.remaining.textContent = remainingTime(row.share)
      if (status !== row.status) {
        setStatus(row.badge, status)
        row.status = status
        if (row.revokeButton) setProtoProps(row.revokeButton, { disabled: status === 'expired' || status === 'revoked' })
      }
    }
    for (const [id, entry] of createdResults) if (currentStatus(entry.share) !== 'pending') forgetResult(id)
    if (Date.now() - lastRefresh >= 30000 && document.visibilityState === 'visible' && element.getClientRects().length > 0 && !listCard.contains(document.activeElement)) void refresh()
    window.setTimeout(tick, 1000)
  }
  updateSelection()
  updateExpiryPreview()
  window.setTimeout(tick, 1000)
  return { element, setDevices, setDevicesError, refresh }
}

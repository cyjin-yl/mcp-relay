import '../proto-ui/components/index'
import './styles/proto-ui-style.css'
import './styles/app.css'

import { fetchMe, setCsrfToken, UnauthorizedError } from './api'
import { mountDashboard } from './dashboard'
import { renderFatal, renderIntro, renderPending } from './screens'

const mountPoint = document.querySelector<HTMLElement>('#app')
if (!mountPoint) throw new Error('missing #app mount point')
const app: HTMLElement = mountPoint

async function boot(): Promise<void> {
  try {
    const me = await fetchMe()
    setCsrfToken(me.csrfToken)
    if (me.status === 'active') {
      mountDashboard(app, me)
    } else {
      renderPending(app, me)
    }
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      renderIntro(app)
      return
    }
    renderFatal(app, error)
  }
}

void boot()

import { SHELL_CSS, TOPBAR_HTML } from './ui/shell.js'
import { DESK_TAB_HTML } from './ui/deskTab.js'
import { CHAT_TAB_HTML, CHARTS_TAB_HTML, RESEARCH_TAB_HTML, KRONOS_TAB_HTML, SETTINGS_TAB_HTML } from './ui/chatTab.js'
import { CORE_JS } from './ui/appJs.js'
import { TABS_JS } from './ui/tabsJs.js'

/**
 * The desktop dashboard — one self-contained HTML page served by the status
 * server at /. No build step, no CDN, no framework. §12.9 turned it into a
 * hash-routed tabbed workbench (Desk / Chat / Charts / Research / Kronos /
 * Settings); section templates live in ./ui/*. The ONE external script is the
 * vendored lightweight-charts build, served from disk at /vendor/lwc.js —
 * localhost only. Binds localhost only. Polls /status, subscribes to /events
 * (SSE), POSTs /kill for the kill switch.
 */
export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Frog-to-Toad Agent</title>
<style>
${SHELL_CSS}
</style>
</head>
<body>
${TOPBAR_HTML}
<section id="tab-desk" class="tabpage">
${DESK_TAB_HTML}
</section>
<section id="tab-chat" class="tabpage" hidden>
${CHAT_TAB_HTML}
</section>
<section id="tab-charts" class="tabpage" hidden>
${CHARTS_TAB_HTML}
</section>
<section id="tab-research" class="tabpage" hidden>
${RESEARCH_TAB_HTML}
</section>
<section id="tab-kronos" class="tabpage" hidden>
${KRONOS_TAB_HTML}
</section>
<section id="tab-settings" class="tabpage" hidden>
${SETTINGS_TAB_HTML}
</section>

<script src="/vendor/lwc.js"></script>
<script>
${CORE_JS}
${TABS_JS}
showTab(currentTab())
</script>
</body>
</html>`

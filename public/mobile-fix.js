if (window.innerWidth < 900) {
  var s = document.getElementById('ml');
  if (!s) { s = document.createElement('style'); s.id = 'ml'; document.head.appendChild(s); }
  s.textContent = [
    'body{padding:6px!important}',
    '.shell{border-radius:10px!important}',
    /* Header: logo on row 1, badges on row 2 */
    '.app-topbar{flex-wrap:wrap!important;padding:8px 10px!important;gap:4px!important}',
    '.app-topbar .sidebar-toggle{order:0!important}',
    '.app-topbar .topbar-brand{order:1!important;flex:1!important;min-width:0!important;gap:6px!important}',
    '.app-topbar .topbar-brand strong{font-size:.85rem!important}',
    '.app-topbar .topbar-brand .brand-mark{width:24px!important;height:24px!important}',
    '.app-topbar .topbar-actions{order:2!important;width:100%!important;display:flex!important;justify-content:flex-end!important;gap:6px!important;margin-top:2px!important}',
    '.app-topbar .topbar-actions .status-pill,.app-topbar .topbar-actions .role-badge{font-size:10px!important;padding:2px 8px!important}',
    '.app-topbar .topbar-actions .secondary-action{font-size:11px!important;padding:3px 10px!important}',
    /* Content: match header width exactly */
    '.workspace-content{padding:8px 10px!important;overflow-x:hidden!important}',
    /* 5 metric cards in 2 columns + all show */
    '#dash-metrics{display:grid!important;grid-template-columns:1fr 1fr!important;gap:6px!important;margin-bottom:8px!important}',
    '.dash-metric{padding:10px!important;min-width:0!important}',
    '.dash-metric-icon{width:32px!important;height:32px!important;min-width:32px!important}',
    '.dash-metric strong{font-size:1rem!important}',
    '.dash-metric span{font-size:.72rem!important}',
    /* Other elements */
    '.panel{padding:10px!important;margin-bottom:8px!important}',
    '.stats{grid-template-columns:1fr 1fr!important;gap:6px!important;margin-bottom:8px!important}',
    /* Sidebar */
    '.workspace-grid{grid-template-columns:1fr!important}',
    '.sidebar{left:-260px!important;transition:left .25s!important;position:fixed!important;top:0!important;bottom:0!important;width:240px!important;z-index:1000!important}',
    '.sidebar.open{left:0!important}',
    '.sidebar-overlay{position:fixed!important;inset:0!important;background:rgba(0,0,0,.4)!important;z-index:999!important;display:none!important}',
    '.sidebar-overlay.show{display:block!important}'
  ].join('\n');
}
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => {
    console.error('setPanelBehavior failed:', err);
  });
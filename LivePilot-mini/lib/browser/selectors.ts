export const youtubeSelectors = {
  chatMessages: 'yt-live-chat-text-message-renderer',
  chatMessageAuthor: '#author-name',
  chatMessageBody: '#message',
  streamStatus: ['.ytp-offline-slate', '.ytp-error-content-wrap', 'ytd-watch-info-text', 'ytd-video-primary-info-renderer #info'],
  accountButton: [
    'button[aria-label*="Account"]',
    '#avatar-btn',
  ],
  accountHeader: [
    'ytd-active-account-header-renderer',
    'yt-multi-page-menu-section-renderer #header',
  ],
  accountName: [
    'ytd-active-account-header-renderer #account-name',
    'ytd-active-account-header-renderer yt-formatted-string#account-name',
    'yt-multi-page-menu-section-renderer #account-name',
  ],
  accountEmail: [
    'ytd-active-account-header-renderer #email',
    'yt-multi-page-menu-section-renderer #email',
  ],
  accountHandle: [
    'ytd-active-account-header-renderer #channel-handle',
    'ytd-active-account-header-renderer #handle',
  ],
  chatIframes: [
    'iframe#chatframe',
    'iframe[src*="live_chat"]',
    'ytd-live-chat-frame iframe',
  ],
  chatOpenButtons: [
    'button[aria-label*="Show chat" i]',
    'ytd-live-chat-frame #show-hide-button button:has-text("Show chat")',
    'tp-yt-paper-button:has-text("Show chat")',
  ],
  chatContainers: ['yt-live-chat-renderer', 'ytd-live-chat-frame'],
  chatInputName: /chat|say something|message/i,
  chatInputPlaceholder: /^(chat|say something|send a message)(\.{3}|…)?$/i,
  chatInputs: [
    'yt-live-chat-text-input-field-renderer #input[contenteditable="true"]',
    // YouTube also renders the HTML empty-value form: <div id="input" contenteditable>.
    // Keep this fallback inside the chat composer; it has neither role nor placeholder.
    'yt-live-chat-text-input-field-renderer #input[contenteditable=""]',
    '#input.yt-live-chat-text-input-field-renderer[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][aria-label*="chat" i]',
    '[contenteditable="plaintext-only"][role="textbox"]',
    'yt-live-chat-message-input-renderer [contenteditable="true"]',
    'yt-live-chat-message-input-renderer [contenteditable="plaintext-only"]',
    'textarea[placeholder^="Chat" i]',
    'input[placeholder^="Chat" i]',
  ],
  signIn: [
    'a[href*="accounts.google.com/ServiceLogin"]',
    'tp-yt-paper-button[aria-label*="Sign in" i]',
    'a[aria-label*="Sign in" i]',
  ],
  chatUnavailable: [
    'yt-live-chat-message-renderer',
    '#chat-unavailable-message',
    'ytd-message-renderer',
  ],
  restrictionText: [
    '#chat-unavailable-message',
    'yt-live-chat-restricted-participation-renderer',
    'yt-live-chat-message-input-renderer',
    'yt-live-chat-viewer-engagement-message-renderer',
  ],
  toast: ['tp-yt-paper-toast', 'yt-notification-action-renderer', '#toast'],
  videoTitle: ['h1.ytd-watch-metadata yt-formatted-string', 'h1.title yt-formatted-string'],
  channelName: ['ytd-channel-name a', '#owner-name a'],
} as const;
